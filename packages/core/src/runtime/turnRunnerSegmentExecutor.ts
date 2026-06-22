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
import { prepareSegmentWake } from './segmentWakeApplicator.js';
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

export type TurnRunnerSegmentExecutorDeps = {
    turnRunner: TurnRunner;
    sessionManager: SessionManager;
    createContext: (task: { id: string; input: unknown }) => TaskContext;
    isStreaming?: boolean;
    dedupe?: SegmentDedupe;
};

export class TurnRunnerSegmentExecutor implements TurnExecutor {
    private readonly turnRunner: TurnRunner;
    private readonly sessionManager: SessionManager;
    private readonly createContext: (task: { id: string; input: unknown }) => TaskContext;
    private readonly isStreaming: boolean;
    private readonly dedupe: SegmentDedupe;

    constructor(deps: TurnRunnerSegmentExecutorDeps) {
        this.turnRunner = deps.turnRunner;
        this.sessionManager = deps.sessionManager;
        this.createContext = deps.createContext;
        this.isStreaming = deps.isStreaming ?? false;
        this.dedupe = deps.dedupe ?? createInMemorySegmentDedupe();
    }

    async runSegment(params: RunSegmentParams): Promise<SegmentResult> {
        const { tenantId, taskId, agentId, wake, idempotencyKey, prepared } = params;

        if (await this.hasProcessedKey(tenantId, taskId, idempotencyKey)) {
            return this.buildDuplicateResult(tenantId, taskId, agentId);
        }

        if (prepared !== undefined) {
            const taskEntity = await runWithSegmentIdempotencyKey(
                idempotencyKey,
                () => this.turnRunner.runTurn(
                    prepared.ctx,
                    prepared.turnParams,
                    {
                        initialM: prepared.initialM,
                        snapshot: prepared.snapshot,
                    }
                )
            );
            await this.ensureProcessedKeyRecorded(tenantId, taskId, agentId, idempotencyKey);
            this.dedupe.record(idempotencyKey);

            const boundary = await this.resolveBoundary(
                tenantId,
                taskId,
                taskEntity,
                undefined
            );
            const taskStatus = mapTaskEntityStatus(taskEntity.status?.state, boundary);

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
            };
        }

        const preparedWake = await prepareSegmentWake(this.sessionManager, {
            tenantId,
            taskId,
            agentId,
            wake,
        });

        const ctx = this.createContext({
            id: taskId,
            input: wake.trigger === 'start' ? wake.input : {},
        });
        (ctx as { tenantId?: string }).tenantId = tenantId;
        (ctx as { agentId?: string }).agentId = preparedWake.agentId;

        const M = (preparedWake.snapshot.M as MentalState | undefined) ?? initialM(ctx);

        const taskEntity = await runWithSegmentIdempotencyKey(
            idempotencyKey,
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
                    snapshot: preparedWake.snapshot,
                }
            )
        );

        await this.ensureProcessedKeyRecorded(tenantId, taskId, preparedWake.agentId, idempotencyKey);
        this.dedupe.record(idempotencyKey);

        const boundary = await this.resolveBoundary(
            tenantId,
            taskId,
            taskEntity,
            preparedWake.inputExpiresAt
        );
        const taskStatus = mapTaskEntityStatus(taskEntity.status?.state, boundary);

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
        };
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
            return { kind: 'await_child', token: awaiting.token };
        }
        if (awaiting?.kind === 'await_event') {
            return { kind: 'await_event', token: awaiting.token };
        }

        if (state === 'working') {
            return { kind: 'paused', reason: 'budget_or_latency' };
        }

        return { kind: 'complete' };
    }

    private async hasProcessedKey(
        tenantId: string,
        taskId: string,
        idempotencyKey: string
    ): Promise<boolean> {
        if (this.dedupe.has(idempotencyKey)) {
            return true;
        }
        const snap = await this.sessionManager.load(tenantId, taskId);
        return snapshotHasProcessedSegmentKey(snap?.snapshot, idempotencyKey);
    }

    private async ensureProcessedKeyRecorded(
        tenantId: string,
        taskId: string,
        agentId: string | undefined,
        idempotencyKey: string
    ): Promise<void> {
        const snap = await this.sessionManager.load(tenantId, taskId);
        if (
            snap === null ||
            snap === undefined ||
            snapshotHasProcessedSegmentKey(snap.snapshot, idempotencyKey)
        ) {
            return;
        }
        await this.sessionManager.saveSnapshot({
            tenantId,
            sessionId: taskId,
            agentId: agentId ?? snap.agentId,
            expectedWmVersion: snap.wmVersion ?? BigInt(0),
            snapshot: addProcessedSegmentKey(snap.snapshot, idempotencyKey),
        });
    }

    private async buildDuplicateResult(
        tenantId: string,
        taskId: string,
        agentId?: string
    ): Promise<SegmentResult> {
        const snap = await this.sessionManager.load(tenantId, taskId);
        const base = (snap?.snapshot ?? {}) as {
            meta?: { awaiting?: { kind: string; token: string }; agentId?: string };
        };
        const awaiting = base.meta?.awaiting;
        const boundary =
            awaiting?.kind === 'await_input'
                ? { kind: 'await_input' as const, token: awaiting.token }
                : awaiting?.kind === 'await_tool'
                  ? { kind: 'await_tool' as const, token: awaiting.token }
                  : awaiting?.kind === 'await_child'
                    ? { kind: 'await_child' as const, token: awaiting.token }
                    : awaiting?.kind === 'await_event'
                      ? { kind: 'await_event' as const, token: awaiting.token }
                      : ({ kind: 'complete' as const });
        return {
            tenantId,
            taskId,
            agentId: agentId ?? base.meta?.agentId,
            boundary,
            taskStatus: boundaryToTaskStatus(boundary),
        };
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
    if (state === 'input-required') {
        return 'input-required';
    }
    return boundaryToTaskStatus(boundary);
}
