/**
 * TurnExecutor backed by the real TurnRunner.runTurn path.
 *
 * Phase 0.2: wraps existing cognition machinery without changing TaskEngine wiring.
 * INTERNAL — not exported from the public package index.
 */

import { initialM } from '../loop/init.js';
import type { MentalState } from '../loop/types.js';
import type { SessionManager } from '../orchestration/SessionManager.js';
import type { TaskContext } from '../shared/types/index.js';
import { TurnRunner } from '../orchestration/TurnRunner.js';
import { applyWakeToSnapshot, type PreparedSegmentWake } from './segmentWakeApplicator.js';
import {
    boundaryToTaskStatus,
    type RunSegmentParams,
    type SegmentResult,
    type TurnExecutor,
} from './turnExecutor.js';
import { createInMemorySegmentDedupe, type SegmentDedupe } from './inMemorySegmentDedupe.js';
import {
    addProcessedSegmentKey,
    runWithSegmentIdempotencyKey,
    snapshotHasProcessedSegmentKey,
} from './segmentProcessedKeys.js';
import { readSegmentCancellation } from './segmentCancellation.js';
import { reconcileSnapshotMutation } from '../orchestration/persistence/SnapshotRepository.js';
import {
    readTaskTurnCoordinator,
    markTaskTurnExecuting,
    releaseUnstartedTaskTurn,
    renewTaskTurnClaim,
    requestTaskTurn,
    resolveTaskTurnLeaseConfig,
    type TaskTurnClaim,
} from '../orchestration/TaskTurnCoordinator.js';
import { readDurableTaskTerminal } from '../orchestration/TaskLifecycle.js';
import { isTaskLifecycleTerminalError } from '@a2arium/callagent-types/task-lifecycle-terminal';
import { isTaskTurnSupersededError } from '@a2arium/callagent-types/task-turn-superseded';

export type TurnRunnerSegmentExecutorDeps = {
    turnRunner: TurnRunner;
    sessionManager: SessionManager;
    createContext: (task: { id: string; input: unknown }) => TaskContext;
    isStreaming?: boolean;
    dedupe?: SegmentDedupe;
    onChildTimeout?: (params: { tenantId: string; childTaskId: string }) => Promise<void>;
    onTaskTerminal?: (params: {
        tenantId: string;
        taskId: string;
        state: 'completed' | 'failed' | 'canceled';
        runtimeSurface: 'direct' | 'in_process' | 'hatchet';
    }) => Promise<void>;
};

export class TurnRunnerSegmentExecutor implements TurnExecutor {
    private readonly turnRunner: TurnRunner;
    private readonly sessionManager: SessionManager;
    private readonly createContext: (task: { id: string; input: unknown }) => TaskContext;
    private readonly isStreaming: boolean;
    private readonly dedupe: SegmentDedupe;
    private readonly onChildTimeout?: (params: { tenantId: string; childTaskId: string }) => Promise<void>;
    private readonly onTaskTerminal?: TurnRunnerSegmentExecutorDeps['onTaskTerminal'];

    constructor(deps: TurnRunnerSegmentExecutorDeps) {
        this.turnRunner = deps.turnRunner;
        this.sessionManager = deps.sessionManager;
        this.createContext = deps.createContext;
        this.isStreaming = deps.isStreaming ?? false;
        this.dedupe = deps.dedupe ?? createInMemorySegmentDedupe();
        this.onChildTimeout = deps.onChildTimeout;
        this.onTaskTerminal = deps.onTaskTerminal;
    }

    async runSegment(params: RunSegmentParams): Promise<SegmentResult> {
        const { tenantId, taskId, agentId, wake, idempotencyKey, prepared } = params;
        const runtimeAttemptKey = params.runtimeAttemptKey ??
            `${params.runtimeSurface ?? 'in_process'}:${idempotencyKey}`;

        // Fast replay path only. Correctness still comes from requestTaskTurn below:
        // two workers that both miss this read race through the snapshot claim and
        // only one can enter TurnRunner.
        if (await this.hasProcessedKey(tenantId, taskId, idempotencyKey)) {
            await this.appendAttemptEvent('turn.attempt_finished', {
                tenantId, taskId, idempotencyKey, attemptKey: runtimeAttemptKey,
                disposition: 'matching_replay', status: 'matching_replay',
            });
            return this.buildDuplicateResult(tenantId, taskId, agentId, 'matching_replay');
        }

        if (prepared !== undefined) {
            const preparedCancellation = readSegmentCancellation(prepared.snapshot);
            if (preparedCancellation !== undefined) {
                return this.buildCanceledResult(
                    tenantId,
                    taskId,
                    agentId,
                    idempotencyKey,
                    preparedCancellation.reason,
                    params.runtimeSurface ?? 'in_process',
                    prepared.ctx as { telemetry?: { traceId?: string } }
                );
            }

            const admission = await this.admitTurn({
                tenantId,
                taskId,
                agentId,
                idempotencyKey,
                runtimeSurface: params.runtimeSurface,
                wake,
            });
            if (admission.result.staged) {
                await this.appendAcceptedWakeEvent(tenantId, taskId, wake);
            }
            if (admission.result.disposition !== 'acquired') {
                const disposition = admission.result.disposition === 'queued' ? 'queued' :
                    admission.result.disposition === 'terminal' ? 'terminal_replay' : 'matching_replay';
                await this.appendAttemptEvent('turn.attempt_finished', {
                    tenantId, taskId, idempotencyKey, attemptKey: runtimeAttemptKey,
                    disposition, status: disposition,
                });
                return this.buildDuplicateResult(
                    tenantId,
                    taskId,
                    agentId,
                    admission.result.disposition === 'queued' ? 'queued' :
                        admission.result.disposition === 'terminal' ? 'terminal_replay' : 'matching_replay'
                );
            }
            if ((prepared.ctx as { task?: unknown }).task === undefined) {
                (prepared.ctx as { task?: { id: string; input: unknown } }).task = {
                    id: taskId,
                    input: wake.trigger === 'start' ? wake.input : {},
                };
            }
            let taskEntity;
            try {
                taskEntity = await this.runClaimedTurn(
                    { tenantId, taskId, agentId, idempotencyKey, claim: admission.result.claim },
                    () => this.turnRunner.runTurn(
                        prepared.ctx,
                        prepared.turnParams,
                        {
                            initialM: (admission.snapshot.M as MentalState | undefined) ?? initialM(prepared.ctx),
                            snapshot: admission.snapshot,
                        }
                    )
                );
            } catch (error) {
                const disposition = await this.classifySupersededExecutionError({
                    error,
                    tenantId,
                    taskId,
                    agentId,
                    idempotencyKey,
                    claim: admission.result.claim,
                });
                if (disposition === undefined) throw error;
                this.dedupe.record(idempotencyKey);
                return this.buildDuplicateResult(tenantId, taskId, agentId, disposition);
            }
            const persistedDisposition = (taskEntity as { __turnPersistence?: { disposition?: string } })
                .__turnPersistence?.disposition;
            if (persistedDisposition === 'superseded' || persistedDisposition === 'competing_terminal') {
                this.dedupe.record(idempotencyKey);
                return this.buildDuplicateResult(tenantId, taskId, agentId, 'superseded');
            }
            this.dedupe.record(idempotencyKey);

            const boundary = await this.resolveBoundary(
                tenantId,
                taskId,
                taskEntity,
                undefined
            );
            const taskStatus = mapTaskEntityStatus(taskEntity.status?.state, boundary);
            await this.finalizeIfTerminal(
                tenantId,
                taskId,
                taskStatus,
                params.runtimeSurface ?? 'in_process'
            );

            const snapAfter = await this.sessionManager.load(tenantId, taskId);
            const telemetry = (snapAfter?.snapshot as { meta?: { telemetry?: { traceId?: string } } } | undefined)
                ?.meta?.telemetry;

            return {
                tenantId,
                taskId,
                agentId,
                boundary,
                taskStatus,
                traceId:
                    telemetry?.traceId ??
                    (prepared.ctx as { telemetry?: { traceId?: string } }).telemetry?.traceId,
                taskEntity,
                turnDisposition: 'executed',
                turnClaim: admission.result.claim,
            };
        }

        const snapBeforeWake = await this.sessionManager.load(tenantId, taskId);
        const cancellationBeforeWake = readSegmentCancellation(snapBeforeWake?.snapshot);
        if (cancellationBeforeWake !== undefined) {
            return this.buildCanceledResult(
                tenantId,
                taskId,
                agentId ?? snapBeforeWake?.agentId,
                idempotencyKey,
                cancellationBeforeWake.reason,
                params.runtimeSurface ?? 'in_process'
            );
        }

        const admission = await this.admitTurn({
            tenantId,
            taskId,
            agentId,
            wake,
            idempotencyKey,
            runtimeSurface: params.runtimeSurface,
            recoveryGeneration: params.recoveryGeneration,
        });

        if (admission.result.staged) {
            await this.appendAcceptedWakeEvent(tenantId, taskId, wake);
        }

        const preparedWake = admission.prepared ?? describeWake(admission.snapshot, wake, agentId);

        if (admission.result.disposition !== 'acquired') {
            const disposition = admission.result.disposition === 'queued' ? 'queued' :
                admission.result.disposition === 'terminal' ? 'terminal_replay' : 'matching_replay';
            await this.appendAttemptEvent('turn.attempt_finished', {
                tenantId, taskId, idempotencyKey, attemptKey: runtimeAttemptKey,
                disposition, status: disposition,
            });
            return this.buildDuplicateResult(
                tenantId,
                taskId,
                preparedWake.agentId,
                admission.result.disposition === 'queued' ? 'queued' :
                    admission.result.disposition === 'terminal' ? 'terminal_replay' : 'matching_replay'
            );
        }

        if (
            preparedWake.childTerminalClaim?.terminal?.error?.code === 'CHILD_TIMEOUT' &&
            (preparedWake.childTerminalClaim.won === true ||
                preparedWake.childTerminalClaim.disposition === 'matching_replay')
        ) {
            const childTaskId = preparedWake.childTerminalClaim.terminal.childTaskId;
            if (childTaskId !== undefined && this.onChildTimeout !== undefined) {
                await this.onChildTimeout({ tenantId, childTaskId });
            }
        }

        if (preparedWake.skipTurn) {
            await releaseUnstartedTaskTurn({
                session: this.sessionManager,
                tenantId,
                taskId,
                agentId: preparedWake.agentId,
                claim: admission.result.claim,
            });
            this.dedupe.record(idempotencyKey);
            return this.buildDuplicateResult(tenantId, taskId, preparedWake.agentId, 'matching_replay');
        }

        const ctx = this.createContext({
            id: taskId,
            input: wake.trigger === 'start' ? wake.input : {},
        });
        if ((ctx as { task?: unknown }).task === undefined) {
            (ctx as { task?: { id: string; input: unknown } }).task = {
                id: taskId,
                input: wake.trigger === 'start' ? wake.input : {},
            };
        }
        (ctx as { tenantId?: string }).tenantId = tenantId;
        (ctx as { agentId?: string }).agentId = preparedWake.agentId;

        const M = (admission.snapshot.M as MentalState | undefined) ?? initialM(ctx);

        let taskEntity;
        try {
            taskEntity = await this.runClaimedTurn(
                { tenantId, taskId, agentId: preparedWake.agentId, idempotencyKey, claim: admission.result.claim },
                () => this.turnRunner.runTurn(
                    ctx,
                    {
                        tenantId,
                        sessionId: taskId,
                        trigger: preparedWake.trigger,
                        isStreaming: this.isStreaming,
                        ...preparedWake.turnParams,
                    },
                    {
                        initialM: M,
                        snapshot: admission.snapshot,
                    }
                )
            );
        } catch (error) {
            const disposition = await this.classifySupersededExecutionError({
                error,
                tenantId,
                taskId,
                agentId: preparedWake.agentId,
                idempotencyKey,
                claim: admission.result.claim,
            });
            if (disposition === undefined) throw error;
            this.dedupe.record(idempotencyKey);
            return this.buildDuplicateResult(tenantId, taskId, preparedWake.agentId, disposition);
        }

        const persistedDisposition = (taskEntity as { __turnPersistence?: { disposition?: string } })
            .__turnPersistence?.disposition;
        if (persistedDisposition === 'superseded' || persistedDisposition === 'competing_terminal') {
            this.dedupe.record(idempotencyKey);
            return this.buildDuplicateResult(tenantId, taskId, preparedWake.agentId, 'superseded');
        }

        this.dedupe.record(idempotencyKey);

        const boundary = await this.resolveBoundary(
            tenantId,
            taskId,
            taskEntity,
            preparedWake.inputExpiresAt
        );
        const taskStatus = mapTaskEntityStatus(taskEntity.status?.state, boundary);
        await this.finalizeIfTerminal(
            tenantId,
            taskId,
            taskStatus,
            params.runtimeSurface ?? 'in_process'
        );

        const snapAfter = await this.sessionManager.load(tenantId, taskId);
        const telemetry = (snapAfter?.snapshot as { meta?: { telemetry?: { traceId?: string } } } | undefined)
            ?.meta?.telemetry;

        return {
            tenantId,
            taskId,
            agentId: preparedWake.agentId,
            boundary,
            taskStatus,
            traceId: telemetry?.traceId ?? (ctx as { telemetry?: { traceId?: string } }).telemetry?.traceId,
            turnDisposition: 'executed',
            turnClaim: admission.result.claim,
        };
    }

    private async admitTurn(params: {
        tenantId: string;
        taskId: string;
        agentId?: string;
        idempotencyKey: string;
        runtimeSurface?: 'direct' | 'in_process' | 'hatchet';
        wake: RunSegmentParams['wake'];
        recoveryGeneration?: string;
    }) {
        let prepared: PreparedSegmentWake | undefined;
        const admitted = await requestTaskTurn({
            session: this.sessionManager,
            tenantId: params.tenantId,
            taskId: params.taskId,
            agentId: params.agentId,
            ownerId: `segment:${process.pid}`,
            requestKey: params.idempotencyKey,
            runtimeSurface: params.runtimeSurface,
            recoveryGeneration: params.recoveryGeneration,
            allowInitialize: params.wake.trigger === 'start' || params.wake.trigger === 'conversation',
            stageWake: params.recoveryGeneration !== undefined ? undefined : (snapshot, storageNow) => {
                prepared = applyWakeToSnapshot(snapshot, params.wake, {
                    tenantId: params.tenantId,
                    taskId: params.taskId,
                    agentId: params.agentId,
                    storageNow,
                });
                return prepared.snapshot;
            },
        });
        return { ...admitted, prepared };
    }

    private async runClaimedTurn<T>(params: {
        tenantId: string;
        taskId: string;
        agentId?: string;
        idempotencyKey: string;
        claim: TaskTurnClaim;
    }, body: () => Promise<T>): Promise<T> {
        await markTaskTurnExecuting({
            session: this.sessionManager,
            tenantId: params.tenantId,
            taskId: params.taskId,
            agentId: params.agentId,
            claim: params.claim,
        });
        await this.appendAttemptEvent('turn.attempt_started', {
            tenantId: params.tenantId,
            taskId: params.taskId,
            idempotencyKey: params.idempotencyKey,
            claim: params.claim,
            disposition: 'executed',
        });
        let renewing = false;
        const abortController = new AbortController();
        const leaseConfig = resolveTaskTurnLeaseConfig();
        const timer = setInterval(() => {
            if (renewing) return;
            renewing = true;
            void renewTaskTurnClaim({
                session: this.sessionManager,
                tenantId: params.tenantId,
                taskId: params.taskId,
                agentId: params.agentId,
                claim: params.claim,
            }).then((disposition) => {
                if (disposition !== 'renewed') {
                    abortController.abort(new Error(`Task turn renewal ${disposition}`));
                }
            }).catch((error) => {
                abortController.abort(error);
            }).finally(() => { renewing = false; });
        }, leaseConfig.heartbeatMs);
        timer.unref?.();
        try {
            const value = await runWithSegmentIdempotencyKey(
                params.idempotencyKey,
                body,
                {
                    ...params.claim,
                    tenantId: params.tenantId,
                    taskId: params.taskId,
                    abortSignal: abortController.signal,
                }
            );
            const entity = value as {
                status?: { state?: string };
                __turnPersistence?: { disposition?: string; terminal?: { turnClaim?: { claimId?: string } } };
            };
            const disposition = entity.__turnPersistence?.disposition === 'superseded' ||
                entity.__turnPersistence?.disposition === 'competing_terminal'
                ? 'superseded'
                : 'executed';
            const terminal = entity.__turnPersistence?.terminal;
            await this.appendAttemptEvent('turn.attempt_finished', {
                tenantId: params.tenantId,
                taskId: params.taskId,
                idempotencyKey: params.idempotencyKey,
                claim: params.claim,
                disposition,
                status: disposition === 'superseded'
                    ? 'superseded'
                    : entity.status?.state ?? 'completed',
                authoritativeTerminal: terminal?.turnClaim?.claimId === params.claim.claimId,
                deliveryKey: (terminal as { deliveryKey?: string } | undefined)?.deliveryKey,
            });
            return value;
        } finally {
            clearInterval(timer);
        }
    }

    private async appendAcceptedWakeEvent(
        tenantId: string,
        taskId: string,
        wake: RunSegmentParams['wake']
    ): Promise<void> {
        try {
            if (wake.trigger === 'resume' && wake.event.kind === 'input') {
                await this.sessionManager.appendEvent(tenantId, taskId, 'task.input_provided', {
                    token: wake.event.token,
                });
            } else if (wake.trigger === 'event' && wake.event.kind === 'external') {
                await this.sessionManager.appendEvent(tenantId, taskId, 'task.external_event_registered', {
                    token: wake.event.token,
                    type: wake.event.type,
                });
            }
        } catch {
            // Durable wake acceptance is authoritative; event append is repairable projection work.
        }
    }

    private async classifySupersededExecutionError(params: {
        error: unknown;
        tenantId: string;
        taskId: string;
        agentId?: string;
        idempotencyKey: string;
        claim: TaskTurnClaim;
    }): Promise<'superseded' | 'terminal_replay' | undefined> {
        if (!hasSupersedingCause(params.error)) return undefined;

        const proof = await reconcileSnapshotMutation<{
            disposition?: 'superseded' | 'terminal_replay';
        }>({
            session: this.sessionManager,
            tenantId: params.tenantId,
            sessionId: params.taskId,
            agentId: params.agentId,
            operation: 'turn.supersession.classify',
            mutate: ({ snapshot, storageNow }) => {
                const terminal = readDurableTaskTerminal(snapshot);
                if (terminal !== undefined) {
                    return { kind: 'noop', value: { disposition: 'terminal_replay' } };
                }
                const coordinator = readTaskTurnCoordinator(snapshot);
                const active = coordinator.active;
                const replaced = active === undefined ||
                    active.claimId !== params.claim.claimId ||
                    active.fence !== params.claim.fence ||
                    Date.parse(storageNow) >= Date.parse(active.expiresAt);
                return {
                    kind: 'noop',
                    value: replaced ? { disposition: 'superseded' } : {},
                };
            },
        });
        const disposition = proof.value.disposition;
        if (disposition === undefined) return undefined;
        try {
            await this.sessionManager.appendEvent(params.tenantId, params.taskId, 'turn.superseded', {
                requestKey: params.idempotencyKey,
                claimId: params.claim.claimId,
                fence: params.claim.fence,
                reason: disposition,
                errorCode: supersedingCauseCode(params.error),
            });
            await this.appendAttemptEvent('turn.attempt_finished', {
                tenantId: params.tenantId,
                taskId: params.taskId,
                idempotencyKey: params.idempotencyKey,
                claim: params.claim,
                disposition,
                status: 'superseded',
            });
        } catch {
            // Snapshot ownership is authoritative; this is a repairable diagnostic projection.
        }
        return disposition;
    }

    private async appendAttemptEvent(
        type: 'turn.attempt_started' | 'turn.attempt_finished',
        params: {
            tenantId: string;
            taskId: string;
            idempotencyKey: string;
            claim?: TaskTurnClaim;
            attemptKey?: string;
            disposition: 'executed' | 'queued' | 'matching_replay' | 'superseded' | 'terminal_replay';
            status?: string;
            authoritativeTerminal?: boolean;
            deliveryKey?: string;
        }
    ): Promise<void> {
        try {
            await this.sessionManager.appendEvent(params.tenantId, params.taskId, type, {
                taskId: params.taskId,
                attemptKey: params.claim ? `claim:${params.claim.claimId}` : params.attemptKey,
                requestKey: params.idempotencyKey,
                ...(params.claim ? {
                    claimId: params.claim.claimId,
                    fence: params.claim.fence,
                    claimedGeneration: params.claim.claimedGeneration,
                    turnSeq: params.claim.turnSeq,
                } : {}),
                disposition: params.disposition,
                ...(params.status ? { status: params.status } : {}),
                ...(params.authoritativeTerminal ? { authoritativeTerminal: true } : {}),
                ...(params.deliveryKey ? { deliveryKey: params.deliveryKey } : {}),
            });
        } catch {
            // Attempt projection is repairable; snapshot arbitration is authoritative.
        }
    }

    private async resolveBoundary(
        tenantId: string,
        taskId: string,
        taskEntity: {
            status?: {
                state?: string;
                metadata?: { result?: unknown; token?: string; awaiting?: string };
            };
        },
        inputExpiresAt?: string
    ): Promise<SegmentResult['boundary']> {
        const state = taskEntity.status?.state;
        if (state === 'failed') {
            return { kind: 'fail', error: 'segment failed' };
        }
        if (state === 'completed') {
            return { kind: 'complete', result: taskEntity.status?.metadata?.result };
        }

        const snapAfter = await this.sessionManager.load(tenantId, taskId);
        const cancellation = readSegmentCancellation(snapAfter?.snapshot);
        if (cancellation !== undefined) {
            return cancellation.reason !== undefined
                ? { kind: 'canceled', reason: cancellation.reason }
                : { kind: 'canceled' };
        }

        const meta = (snapAfter?.snapshot as { meta?: { awaiting?: { kind: string; token: string } } } | undefined)
            ?.meta;
        const awaiting = meta?.awaiting;
        const statusToken = taskEntity.status?.metadata?.token;

        if (state === 'input-required' || awaiting?.kind === 'await_input') {
            const token = awaiting?.token ?? statusToken ?? 'unknown';
            return inputExpiresAt !== undefined
                ? { kind: 'await_input', token, expiresAt: inputExpiresAt }
                : { kind: 'await_input', token };
        }
        if (awaiting?.kind === 'await_tool') {
            return { kind: 'await_tool', token: awaiting.token };
        }
        if (awaiting?.kind === 'await_child') {
            const pendingTask = (snapAfter?.snapshot as any)?.pending?.tasks?.[awaiting.token];
            return {
                kind: 'await_child',
                token: awaiting.token,
                ...(typeof pendingTask?.expiresAt === 'string' ? { expiresAt: pendingTask.expiresAt } : {}),
                ...(typeof pendingTask?.timeoutMs === 'number' ? { timeoutMs: pendingTask.timeoutMs } : {}),
                ...(typeof pendingTask?.childTaskId === 'string' ? { childTaskId: pendingTask.childTaskId } : {}),
                ...(typeof pendingTask?.agentId === 'string' ? { agentId: pendingTask.agentId } : {}),
            };
        }
        if (awaiting?.kind === 'await_event') {
            return { kind: 'await_event', token: awaiting.token };
        }

        if (state === 'working') {
            return { kind: 'paused', reason: 'budget_or_latency' };
        }

        throw new Error(
            `TASK_TURN_PROTOCOL_STATE_UNKNOWN: task ${tenantId}/${taskId} has no terminal status or durable await boundary`
        );
    }

    private async hasProcessedKey(
        tenantId: string,
        taskId: string,
        idempotencyKey: string
    ): Promise<boolean> {
        const snap = await this.sessionManager.load(tenantId, taskId);
        if (!this.dedupe.has(idempotencyKey) &&
            !snapshotHasProcessedSegmentKey(snap?.snapshot, idempotencyKey)) {
            return false;
        }
        const coordinator = readTaskTurnCoordinator(snap?.snapshot);
        const requested = BigInt(coordinator.requestedGeneration);
        const completed = BigInt(coordinator.completedGeneration);
        // A processed key means the wake was durably accepted, not necessarily
        // that the generation it requested has executed. Re-enter admission
        // while work remains so the queued generation cannot be stranded.
        return requested <= completed;
    }

    private async ensureProcessedKeyRecorded(
        tenantId: string,
        taskId: string,
        agentId: string | undefined,
        idempotencyKey: string
    ): Promise<void> {
        await reconcileSnapshotMutation({
            session: this.sessionManager,
            tenantId,
            sessionId: taskId,
            agentId,
            operation: 'segment.processed.record',
            mutate: ({ snapshot, wmVersion }) => {
                if (wmVersion === BigInt(0) || snapshotHasProcessedSegmentKey(snapshot, idempotencyKey)) {
                    return { kind: 'noop', value: undefined };
                }
                return {
                    kind: 'write',
                    snapshot: addProcessedSegmentKey(snapshot, idempotencyKey),
                    value: undefined,
                };
            },
        });
    }

    private async buildDuplicateResult(
        tenantId: string,
        taskId: string,
        agentId?: string,
        turnDisposition: SegmentResult['turnDisposition'] = 'matching_replay'
    ): Promise<SegmentResult> {
        const snap = await this.sessionManager.load(tenantId, taskId);
        const base = (snap?.snapshot ?? {}) as {
            meta?: { awaiting?: { kind: string; token: string }; agentId?: string };
        };
        const cancellation = readSegmentCancellation(snap?.snapshot);
        const awaiting = base.meta?.awaiting;
        const terminal = readDurableTaskTerminal(snap?.snapshot);
        const boundary = terminal !== undefined
            ? terminal.state === 'completed'
                ? { kind: 'complete' as const, result: terminal.status.metadata?.result }
                : terminal.state === 'canceled'
                    ? { kind: 'canceled' as const, reason: terminal.status.metadata?.reason as string | undefined }
                    : { kind: 'fail' as const, error: terminal.status.metadata ?? terminal.status.message ?? 'task failed' }
            :
            cancellation !== undefined
                ? cancellation.reason !== undefined
                    ? { kind: 'canceled' as const, reason: cancellation.reason }
                    : { kind: 'canceled' as const }
                : awaiting?.kind === 'await_input'
                ? { kind: 'await_input' as const, token: awaiting.token }
                : awaiting?.kind === 'await_tool'
                  ? { kind: 'await_tool' as const, token: awaiting.token }
                  : awaiting?.kind === 'await_child'
                    ? { kind: 'await_child' as const, token: awaiting.token }
                    : awaiting?.kind === 'await_event'
                      ? { kind: 'await_event' as const, token: awaiting.token }
                      : ({ kind: 'paused' as const, reason: 'authoritative_state_unavailable' });
        return {
            tenantId,
            taskId,
            agentId: agentId ?? base.meta?.agentId,
            boundary,
            taskStatus: boundaryToTaskStatus(boundary),
            turnDisposition,
            ...(terminal !== undefined
                ? {
                      taskEntity: {
                          id: taskId,
                          input: {},
                          status: terminal.status,
                      },
                  }
                : {}),
        };
    }

    private async buildCanceledResult(
        tenantId: string,
        taskId: string,
        agentId: string | undefined,
        idempotencyKey: string,
        reason?: string,
        runtimeSurface: 'direct' | 'in_process' | 'hatchet' = 'in_process',
        ctx?: { telemetry?: { traceId?: string } }
    ): Promise<SegmentResult> {
        await this.ensureProcessedKeyRecorded(tenantId, taskId, agentId, idempotencyKey);
        this.dedupe.record(idempotencyKey);

        const snap = await this.sessionManager.load(tenantId, taskId);
        const telemetry = (snap?.snapshot as { meta?: { telemetry?: { traceId?: string } } } | undefined)
            ?.meta?.telemetry;
        const boundary = reason !== undefined
            ? { kind: 'canceled' as const, reason }
            : { kind: 'canceled' as const };
        await this.finalizeIfTerminal(tenantId, taskId, 'canceled', runtimeSurface);

        return {
            tenantId,
            taskId,
            agentId: agentId ?? snap?.agentId,
            boundary,
            taskStatus: 'canceled',
            traceId: telemetry?.traceId ?? ctx?.telemetry?.traceId,
        };
    }

    private async finalizeIfTerminal(
        tenantId: string,
        taskId: string,
        state: SegmentResult['taskStatus'],
        runtimeSurface: 'direct' | 'in_process' | 'hatchet'
    ): Promise<void> {
        if (
            this.onTaskTerminal !== undefined &&
            (state === 'completed' || state === 'failed' || state === 'canceled')
        ) {
            await this.onTaskTerminal({ tenantId, taskId, state, runtimeSurface });
        }
    }
}

function mapTaskEntityStatus(
    state: string | undefined,
    boundary: SegmentResult['boundary']
): SegmentResult['taskStatus'] {
    if (state === 'failed') {
        return 'failed';
    }
    if (state === 'completed') {
        return 'completed';
    }
    if (boundary.kind === 'canceled') {
        return 'canceled';
    }
    if (state === 'input-required') {
        return 'input-required';
    }
    return boundaryToTaskStatus(boundary);
}

function hasSupersedingCause(error: unknown): boolean {
    const seen = new Set<object>();
    let current: unknown = error;
    for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
        if (isTaskTurnSupersededError(current) || isTaskLifecycleTerminalError(current)) return true;
        if (typeof current !== 'object') return false;
        if (seen.has(current)) return false;
        seen.add(current);
        current = (current as { cause?: unknown }).cause;
    }
    return false;
}

function supersedingCauseCode(error: unknown): string {
    const seen = new Set<object>();
    let current: unknown = error;
    for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
        if (isTaskTurnSupersededError(current)) return 'TASK_TURN_SUPERSEDED';
        if (isTaskLifecycleTerminalError(current)) return 'TASK_LIFECYCLE_TERMINAL';
        if (typeof current !== 'object' || seen.has(current)) break;
        seen.add(current);
        current = (current as { cause?: unknown }).cause;
    }
    return 'TASK_TURN_SUPERSEDED';
}

function describeWake(
    snapshot: Record<string, unknown>,
    wake: RunSegmentParams['wake'],
    agentId?: string
): PreparedSegmentWake {
    const snapshotAgentId = (snapshot.meta as { agentId?: string } | undefined)?.agentId ?? agentId ?? 'default';
    switch (wake.trigger) {
        case 'start':
            return { snapshot, wmVersion: 0n, agentId: snapshotAgentId, trigger: 'start', turnParams: { input: wake.input } };
        case 'resume':
            return { snapshot, wmVersion: 0n, agentId: snapshotAgentId, trigger: 'resume', turnParams: { input: wake.event.kind === 'input' ? wake.event.value : undefined } };
        case 'tool':
            return { snapshot, wmVersion: 0n, agentId: snapshotAgentId, trigger: 'tool', turnParams: wake.event.kind === 'tool' ? { toolToken: wake.event.token, toolResult: wake.event.result } : {} };
        case 'event':
            return { snapshot, wmVersion: 0n, agentId: snapshotAgentId, trigger: 'event', turnParams: wake.event.kind === 'external' ? { eventToken: wake.event.token, eventPayload: wake.event.data } : {} };
        case 'conversation':
            return { snapshot, wmVersion: 0n, agentId: snapshotAgentId, trigger: 'conversation', turnParams: {} };
        default:
            return { snapshot, wmVersion: 0n, agentId: snapshotAgentId, trigger: 'resume', turnParams: {} };
    }
}
