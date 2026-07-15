import { logger } from '@a2arium/callagent-utils';
import { TaskContext } from '../shared/types/index.js';
import { TaskEntity } from './types.js';
import { MentalState, EnvironmentState } from '../loop/types.js';
import { initialM } from '../loop/init.js';
import { SessionManager } from './SessionManager.js';
import { ApiBinder } from './api/ApiBinder.js';

import { TaskExecutor, type LoopOpts } from './TaskExecutor.js';
import type { InternalTaskContext, OperatorTurnTraceCapture } from '../loop/internalContext.js';
import type { ManifestProvenance } from '../types/turnTrace.js';
import { InboxManager, EngineObservation } from './InboxManager.js';
import { ArtifactHydrationService } from './ArtifactHydrationService.js';
import { PluginManager } from '../plugin/pluginManager.js';
import { AgentResultCache } from '@a2arium/callagent-memory-engine';
import type { IEventBus } from '../public-types/eventbus/types.js';
import { createBusEvent } from '../eventbus/busEventHelpers.js';
import { taskChannel } from '../eventbus/taskEventEmitter.js';
import { TaskStateUtils } from './utils/TaskStateUtils.js';
import { prepareChildResultForPersistence } from './childResultPersistence.js';
import { readLoopBudgetsFromSnapshotMeta } from './loopOptsFromSnapshotMeta.js';
import { telemetry } from '../telemetry/TelemetryCollector.js';
import { TurnNode } from '../telemetry/nodes/TurnNode.js';
import { AgentNode } from '../telemetry/nodes/AgentNode.js';
import { bindRuntimeCognitionStream } from '../streaming/cognitionRuntimePublisher.js';
import { reconcileSnapshotMutation } from './persistence/SnapshotRepository.js';
import * as uuid from 'uuid';
const uuidv7 = uuid.v7;

// Re-export type for convenience
export type TurnTrigger = 'start' | 'resume' | 'tool' | 'event' | 'conversation';

export interface TurnExecutionParams {
    tenantId: string;
    sessionId: string;
    trigger: TurnTrigger;
    isStreaming: boolean;
    // For specific triggers
    input?: unknown; // for 'resume' (input provided)
    toolToken?: string;
    toolResult?: unknown;
    eventToken?: string;
    eventPayload?: unknown;
    eventType?: string;
    throwOnSaveFailure?: boolean;
}

const log = logger.createLogger({ prefix: 'TurnRunner' });

export class TurnRunner {
    constructor(
        private sessionManager: SessionManager,
        private apiBinder: ApiBinder,
        private getSessionStorePrisma: () => any,
        private readonly eventBus: IEventBus
    ) { }

    /**
     * Main entry point to run a turn.
     * Handles:
     * 1. Loading/Hydrating Snapshot
     * 2. Preparing Context & Vars
     * 3. Constructing Environment
     * 4. Executing Turn (TaskExecutor)
     * 5. Handling Completion/Failure
     */
    async runTurn(
        ctx: TaskContext,
        params: TurnExecutionParams,
        overrides?: {
            initialM?: MentalState;
            snapshot?: Record<string, unknown>;
        }
    ): Promise<TaskEntity> {
        const { tenantId, sessionId, trigger, isStreaming } = params;
        log.debug('runTurn called', { trigger, sessionId, toolToken: params.toolToken });

        // Telemetry state
        let turnNode: TurnNode | undefined;
        let tempAgentNode: AgentNode | undefined;
        let prevNodeId: string | undefined;

        try {
            // 1. Load Snapshot
            let snap = await this.sessionManager.load(tenantId, sessionId);
            if (!snap && trigger !== 'start' && !overrides?.snapshot) {
                throw new Error(`Session not found for ${sessionId}`);
            }

            const base = overrides?.snapshot || (snap?.snapshot as Record<string, unknown>) || {};

            // 2. Prepare Mental State (M)
            let M: MentalState = overrides?.initialM || (base.M as MentalState) || initialM(ctx);
            // Ensure ctx knows about M for syncing
            (ctx as any).M = M;

            // 3. (Vars Façade removed per APLRET contract)

            // 4. Attach APIs and Flush Helper
            const flushMentalState = async () => {
                const mutateFn = async (baseSnap: Record<string, unknown>) => {
                    // Inject LLM history into M before saving
                    try {
                        const llmAny = (ctx as any).llm as any;
                        const historyMode = (typeof llmAny?.getHistoryMode === 'function') ? llmAny.getHistoryMode() : 'full';

                        if (historyMode !== 'stateless') {
                            let llmState: unknown = undefined;
                            if (llmAny?.getMessages) {
                                const messages = llmAny.getMessages(true);
                                llmState = { messages } as unknown;
                            } else if (llmAny?.exportState) {
                                llmState = llmAny.exportState();
                            }

                            if (llmState) {
                                return { ...baseSnap, M, llmState };
                            }
                        }
                    } catch (err) {
                        log.warn('Failed to inject LLM state during TurnRunner flush', { error: (err as Error).message });
                    }

                    return { ...baseSnap, M };
                };

                await reconcileSnapshotMutation({
                    session: this.sessionManager,
                    tenantId,
                    sessionId,
                    agentId: (ctx as any).agentId || 'default',
                    operation: 'turn.flush',
                    mutate: async ({ snapshot }) => ({
                        kind: 'write',
                        snapshot: await mutateFn(snapshot),
                        value: undefined,
                    }),
                });
            };

            await this.apiBinder.attachOrchestrationAPIs(ctx, {
                tenantId,
                sessionId,
                agentId: (ctx as any).agentId || 'default',
                flushMentalState
            });
            try {
                bindRuntimeCognitionStream({
                    ctx,
                    eventBus: this.eventBus,
                    tenantId,
                    sessionId,
                    agentId: (ctx as any).agentId || 'default',
                });
            } catch { /* noop */ }

            // 5. Environment & Inbox Setup
            const startTurnTotal = Number((base as any)?.meta?.turn) || 0;

            let envInbox = InboxManager.normalizeInbox((base as { inbox?: unknown })?.inbox);
            // Hydrate
            envInbox = ArtifactHydrationService.hydrateInboxArtifacts(
                envInbox,
                this.getSessionStorePrisma(),
                tenantId,
                trigger
            );
            // Inject initial input if present (start OR resume)
            if (trigger === 'start' && params.input) {
                const inputObservation: EngineObservation = {
                    source: 'user',
                    kind: 'input.provided',
                    payload: {
                        token: `input-${trigger}-${sessionId}-${Date.now()}`,
                        value: params.input
                    },
                    provenance: {
                        ts: Date.now(),
                        // ✅ FIX: Use next turn number for provenance since TaskExecutor will increment it
                        turn: startTurnTotal + 1,
                        id: `input-${trigger}-${sessionId}-${Date.now()}`,
                        correlationId: `input-${trigger}-${sessionId}-${Date.now()}`
                    }
                };
                envInbox = InboxManager.addObservationToInbox(envInbox, inputObservation);
            }

            // Restore telemetry from snapshot if missing, to survive process/async suspension boundaries
            const persistedTelemetry = (base as { meta?: { telemetry?: { nodeId?: string; traceId?: string } } })?.meta
                ?.telemetry;
            if (persistedTelemetry && (persistedTelemetry.nodeId || persistedTelemetry.traceId)) {
                if (!ctx.telemetry) {
                    ctx.telemetry = {};
                }
                if (
                    persistedTelemetry.nodeId != null &&
                    persistedTelemetry.nodeId !== '' &&
                    ctx.telemetry.nodeId == null
                ) {
                    ctx.telemetry.nodeId = persistedTelemetry.nodeId;
                }
                if (
                    persistedTelemetry.traceId != null &&
                    persistedTelemetry.traceId !== '' &&
                    ctx.telemetry.traceId == null
                ) {
                    ctx.telemetry.traceId = persistedTelemetry.traceId;
                }
            }

            // --- TELEMETRY START ---
            try {
                let parentId = ctx.telemetry?.nodeId;
                if (!parentId) {
                    const tempId = uuidv7();
                    tempAgentNode = new AgentNode((ctx as any).agentId || 'unknown-agent', tempId, undefined, tempId);
                    tempAgentNode.start();
                    telemetry.registerNode(tempAgentNode);
                    parentId = tempAgentNode.id;
                }

                // Note: TurnNodes are now created by loopRunner (one per loop iteration)
                // We maintain the AgentNode as the session context here.

                if (!ctx.telemetry) ctx.telemetry = {};
                prevNodeId = ctx.telemetry.nodeId;
                if (parentId) {
                    ctx.telemetry.nodeId = parentId;
                }
                const parentTelNode = parentId ? telemetry.getNode(parentId) : undefined;
                if (parentTelNode?.traceId && !ctx.telemetry.traceId) {
                    ctx.telemetry.traceId = parentTelNode.traceId;
                }
            } catch { }
            // -----------------------

            // If inbox is empty, check for child completion events that might not be in the snapshot
            if (envInbox.current.length === 0 && this.sessionManager) {
                try {
                    const lastChildToken = (base?.meta as any)?.lastChildToken;
                    const pendingChildren = ((base as any)?.pending?.children) || {};
                    const pendingChildTokens = Object.keys(pendingChildren);

                    const tokensToCheck = new Set<string>();
                    if (lastChildToken) tokensToCheck.add(lastChildToken);
                    pendingChildTokens.forEach(t => tokensToCheck.add(t));

                    if (tokensToCheck.size > 0) {
                        const events = await this.sessionManager.listEventsSince({ tenantId, sessionId, sinceSeq: -1 });
                        const childTerminalEvents = events.filter(
                            (e: any) => e.type === 'task.child_completed' || e.type === 'task.child_failed'
                        );

                        for (const token of tokensToCheck) {
                            const terminalEvent = childTerminalEvents.find((e: any) =>
                                (e.payload as any)?.token === token
                            );

                            if (terminalEvent) {
                                const observationPredicate = (obs: EngineObservation) =>
                                    (obs?.kind === 'child.completed' || obs?.kind === 'child.failed') &&
                                    typeof obs === 'object' &&
                                    obs !== null &&
                                    (obs as any)?.payload &&
                                    (obs as any).payload.token === token;

                                const terminalPayload = (terminalEvent.payload as any) ?? {};
                                if (terminalEvent.type === 'task.child_failed') {
                                    const rawError = terminalPayload.error;
                                    const errorRecord = rawError !== null && typeof rawError === 'object'
                                        ? rawError as Record<string, unknown>
                                        : {};
                                    const error = {
                                        code: typeof errorRecord.code === 'string' ? errorRecord.code : 'CHILD_FAILED',
                                        message: typeof errorRecord.message === 'string'
                                            ? errorRecord.message
                                            : String(rawError ?? 'Child failed.'),
                                        ...(typeof errorRecord.timeoutMs === 'number'
                                            ? { timeoutMs: errorRecord.timeoutMs }
                                            : {}),
                                    };
                                    const childObservation: EngineObservation = {
                                        source: 'child',
                                        kind: 'child.failed',
                                        payload: {
                                            token,
                                            childTaskId: terminalPayload.childTaskId,
                                            agentId: terminalPayload.agentId,
                                            error,
                                        },
                                        provenance: {
                                            ts: new Date(terminalEvent.createdAt).getTime(),
                                            turn: startTurnTotal,
                                            id: token,
                                            correlationId: token,
                                        },
                                    };
                                    envInbox = InboxManager.addObservationToInboxIfMissing(
                                        envInbox,
                                        childObservation,
                                        observationPredicate
                                    );
                                    continue;
                                }
                                const completionResult = terminalPayload.result;
                                const cleanChildResult = TaskStateUtils.extractCleanChildResult(completionResult);
                                const childPrisma = this.getSessionStorePrisma();
                                const cache = childPrisma ? new AgentResultCache(childPrisma) : undefined;
                                const childResultForParent = await prepareChildResultForPersistence(
                                    cleanChildResult.result,
                                    cache,
                                    tenantId
                                );
                                const childObservation: EngineObservation = {
                                    source: 'child',
                                    kind: 'child.completed',
                                    payload: {
                                        token,
                                        childTaskId: cleanChildResult.childTaskId || terminalPayload.childTaskId,
                                        result: childResultForParent,
                                        agentId: terminalPayload.agentId,
                                        executionMetadata: cleanChildResult.executionMetadata
                                    },
                                    provenance: {
                                        ts: new Date(terminalEvent.createdAt).getTime(),
                                        turn: startTurnTotal, // Bug 1 Fix: Let loopRunner increment
                                        id: token,
                                        correlationId: token
                                    }
                                };
                                envInbox = InboxManager.addObservationToInboxIfMissing(envInbox, childObservation, observationPredicate);
                            }
                        }
                    }
                } catch (error) {
                    log.warn('Failed to check for child completion events on resume', {
                        error: error instanceof Error ? error.message : String(error),
                        sessionId
                    });
                }
            }


            const env: EnvironmentState = {
                time: new Date().toISOString(),
                sessionId,
                turn: startTurnTotal, // Bug 1 Fix: Let loopRunner increment
                budget: { maxTurns: Infinity, latencyMs: Infinity },
                inbox: envInbox,
                pending: (base as any)?.pending || {},
                lastExec: (base as any)?.meta?.lastExec,
                externalEvents: undefined
            };

            // Restore manifest provenance from snapshot so every turn-entry path has it
            const metaProvenance = (base as Record<string, unknown>)?.meta as { manifestProvenance?: ManifestProvenance } | undefined;
            if (metaProvenance?.manifestProvenance) {
                (ctx as InternalTaskContext).__manifestProvenance = metaProvenance.manifestProvenance;
            }

            // Budgeting
            const agentId = (ctx as Record<string, unknown>).agentId as string | undefined;
            const plugin = agentId ? PluginManager.findAgent(agentId) : null;
            const turnTrace = plugin?.resolved.runtimeManifest.observability?.turnTrace;
            (ctx as InternalTaskContext).__operatorTurnTraceCapture = {
                enabled: turnTrace?.enabled ?? true,
                level: turnTrace?.level ?? 'summary',
            } satisfies OperatorTurnTraceCapture;
            const moduleOverrides = (plugin as { loop?: { modules?: Record<string, unknown> } })?.loop?.modules || {};

            // Restore budgets
            let loopOpts: LoopOpts = {};
            try {
                const persistedBudgets = readLoopBudgetsFromSnapshotMeta(
                    (base as Record<string, unknown>)?.meta
                );
                const manifestBudgets = plugin?.resolved.runtimeManifest.budgets;
                const hitl = plugin?.resolved.runtimeManifest.hitl;
                const communication = plugin?.resolved.runtimeManifest.communication;

                const topicSw = communication?.topicSweeper;
                const topicSweeperResolved =
                    topicSw &&
                    typeof topicSw.intervalMs === 'number' &&
                    topicSw.intervalMs > 0 &&
                    typeof topicSw.autoArchiveAfterMs === 'number' &&
                    topicSw.autoArchiveAfterMs > 0
                        ? {
                              intervalMs: topicSw.intervalMs,
                              batchSize:
                                  typeof topicSw.batchSize === 'number' && topicSw.batchSize > 0
                                      ? topicSw.batchSize
                                      : 100,
                              autoArchiveAfterMs: topicSw.autoArchiveAfterMs,
                          }
                        : undefined;

                if (persistedBudgets && typeof persistedBudgets.maxTurns === 'number') {
                    loopOpts = persistedBudgets;
                } else if (manifestBudgets && typeof manifestBudgets === 'object') {
                    loopOpts = { maxTurns: manifestBudgets.maxTurns, latencyMs: manifestBudgets.latencyMs };
                } else {
                    log.warn('No budgets found in manifest or state for agent, using default 50 turns. Ensure agent.json is present and correctly matched if this is unexpected.', { agentId, sessionId });
                    loopOpts = { maxTurns: 50 };
                }

                if (typeof loopOpts.maxTurns === 'number') {
                    env.budget = { maxTurns: loopOpts.maxTurns, latencyMs: loopOpts.latencyMs ?? Infinity };
                }
                loopOpts.autoJoinInvitedTopics = communication?.autoJoinInvitedTopics === true;
                if (topicSweeperResolved !== undefined) {
                    loopOpts.topicSweeper = topicSweeperResolved;
                }
                if (hitl) loopOpts.hitl = hitl;
            } catch (err) {
                // ignore
            }

            loopOpts.manifestProvenance = (ctx as InternalTaskContext).__manifestProvenance;

            // 6. Execute Turn
            const { outcome, taskStatus } = await TaskExecutor.executeTurn({
                ctx, M, env, overrides: moduleOverrides, loopOpts,
                sessionManager: this.sessionManager,
                tenantId, sessionId, agentId: agentId || 'default',
                isStreaming,
                getSessionStorePrisma: this.getSessionStorePrisma,
                eventBus: this.eventBus,
                throwOnSaveFailure: params.throwOnSaveFailure === true
            });
            // explicit flush at end of turn (if not already flushed)
            if (this.sessionManager && !(ctx as any).__wmSavedThisTurn) {
                try { await flushMentalState(); } catch (e) {
                    if ((e as Error).message !== 'LIMIT_WM_SNAPSHOT_TOO_LARGE') {
                        throw e;
                    }
                }
            }

            // 7. Result Construction
            const results = (ctx as any).getBufferedResults ? (ctx as any).getBufferedResults() : { artifacts: [] };

            // Determine effective status:
            // 1. Prefer taskStatus returned by TaskExecutor (contains Result/Artifacts)
            // 2. Fallback to results.status (from streaming buffer)
            // 3. Fallback to 'working'
            const effectiveStatus = taskStatus || results.status || { state: 'working', timestamp: new Date().toISOString() };

            // Determine artifacts:
            // 1. Prefer taskStatus.metadata.result.artifacts (if present and array)
            // 2. Fallback to results.artifacts
            // 3. Fallback to empty array
            let effectiveArtifacts = (taskStatus as any)?.metadata?.result?.artifacts;
            if (!Array.isArray(effectiveArtifacts)) {
                effectiveArtifacts = results.artifacts || [];
            }

            const taskResult: TaskEntity = {
                id: sessionId,
                input: params.input || {},
                status: effectiveStatus,
                artifacts: effectiveArtifacts
            };

            // Map outcome validation to task status...
            if (outcome.kind === 'complete') {
                // Ensure state is completed (it should be from executor, but force if needed, preserving metadata)
                if (taskResult.status && taskResult.status.state !== 'completed') {
                    taskResult.status = { ...taskResult.status, state: 'completed', timestamp: new Date().toISOString() };
                } else if (!taskResult.status) {
                    taskResult.status = { state: 'completed', timestamp: new Date().toISOString() };
                }

                // Publish final event
                try {
                    void this.eventBus.publish(
                        createBusEvent({
                            channel: taskChannel(sessionId),
                            partitionKey: sessionId,
                            cloud: {
                                id: uuidv7(),
                                type: 'task.status',
                                source: `/tasks/${sessionId}`,
                                time: new Date().toISOString(),
                                datacontenttype: 'application/json',
                                data: {
                                    id: sessionId,
                                    status: taskResult.status,
                                    final: true,
                                },
                            },
                        })
                    );
                } catch {
                    /* noop */
                }
            } else if (outcome.kind === 'fail') {
                taskResult.status = { state: 'failed', timestamp: new Date().toISOString() };
            }

            return taskResult;

        } catch (error) {
            log.error('TurnRunner error', { error });
            throw error;
        } finally {
            if (prevNodeId && ctx.telemetry) ctx.telemetry.nodeId = prevNodeId;
            if (tempAgentNode) {
                try {
                    tempAgentNode.end();
                    // Do we want to broadcast end for temp node too? Probably yes.
                    if (tempAgentNode) telemetry.endNode(tempAgentNode);
                } catch { }
            }
        }
    }
}
