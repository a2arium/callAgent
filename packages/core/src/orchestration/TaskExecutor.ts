import * as uuid from 'uuid';

import { logger, updateLoggingContext } from '@a2arium/callagent-utils';
import { AgentResultCache } from '@a2arium/callagent-memory-engine';
import { TaskTurnSupersededError } from '@a2arium/callagent-types/task-turn-superseded';
import { InboxManager, type EngineObservation } from './InboxManager.js';
import { ArtifactHydrationService } from './ArtifactHydrationService.js';
import { flushBufferedOperatorTurnEvents, runLoop } from '../loop/loopRunner.js';
import { pruneSnapshot } from '../loop/hygiene.js';
import { offloadArtifacts } from '@a2arium/callagent-memory-engine';
import { taskChannel } from '../eventbus/taskEventEmitter.js';
import type { IEventBus } from '../public-types/eventbus/types.js';
import { bindRuntimeCognitionStream } from '../streaming/cognitionRuntimePublisher.js';
import {
    filterInboxCurrentByConversationDeliveryKeys,
    readConsumedConversationDeliveryKeysFromMeta,
    writeConsumedConversationDeliveryKeysToMeta,
} from '../loop/conversationInboxIdentity.js';
import {
    addProcessedSegmentKey,
    currentSegmentIdempotencyKey,
    currentTaskTurnClaim,
} from '../runtime/segmentProcessedKeys.js';
import {
    assertCurrentTaskTurn,
    completeTaskTurnInSnapshot,
    setTaskTurnPhaseInSnapshot,
} from './TaskTurnCoordinator.js';
import {
    prepareChildResultForPersistence,
    prepareChildResultsInInboxForPersistence,
} from './childResultPersistence.js';
import {
    isSnapshotReconciliationError,
    reconcileSnapshotMutation,
} from './persistence/SnapshotRepository.js';
import {
    claimTaskTerminalInSnapshot,
    ensureTaskLifecycle,
    readDurableTaskTerminal,
    readTaskLifecycle,
} from './TaskLifecycle.js';
import type { DurableTaskTerminal } from './TaskLifecycle.js';
import { boundPendingToolTerminals, type PendingToolTerminals } from './ToolsRegistry.js';

import type {
    EnvironmentState,
    MentalState
} from '../loop/types.js';
import type { TaskStatus } from '../shared/types/StreamingEvents.js';
import type { TurnOutcome } from '../loop/oneTurn.js';
import type { TaskContext } from '../shared/types/index.js';
import type { InternalTaskContext } from '../loop/internalContext.js';
import type { ManifestProvenance } from '../types/turnTrace.js';
import { SessionManager } from './SessionManager.js';
import { defaultMetricsRegistry } from '../observability/metrics.js';

const log = logger.createLogger({ prefix: 'TaskExecutor' });

type A2AParentLink = {
    parentTenantId: string;
    parentTaskId: string;
    parentChildToken: string;
};

type A2AParentContext = TaskContext & {
    __a2aParent?: A2AParentLink;
};

export type LoopOutcome = TurnOutcome;

export type LoopOpts = {
    maxTurns?: number;
    latencyMs?: number;
    manifestProvenance?: ManifestProvenance;
    collectTraces?: boolean;
    autoJoinInvitedTopics?: boolean;
    hitl?: import('../loop/manifestConsent.js').ManifestHitlConfig;
    topicSweeper?: {
        intervalMs: number;
        batchSize: number;
        autoArchiveAfterMs: number;
    };
};

export interface ExecuteTurnParams {
    ctx: TaskContext;
    M: MentalState;
    env: EnvironmentState;
    overrides: Record<string, unknown>;
    loopOpts: LoopOpts;
    sessionManager: SessionManager | undefined;
    tenantId: string;
    sessionId: string;
    agentId: string;
    isStreaming: boolean;
    getSessionStorePrisma: () => any; // Pass as callback or interface
    eventBus?: IEventBus;
    throwOnSaveFailure?: boolean;
}

export type TurnPersistenceResult = {
    disposition: 'committed' | 'matching_terminal' | 'competing_terminal' | 'superseded';
    snapshot: Record<string, unknown>;
    wmVersion: bigint;
    terminal?: DurableTaskTerminal;
    scheduleNext: boolean;
};

export class TaskExecutor {

    /**
     * Executes a single turn of the agent loop, handling snapshot persistence,
     * artifact offloading, and status emission.
     */
    static async executeTurn(params: ExecuteTurnParams): Promise<{
        M: MentalState;
        outcome: LoopOutcome;
        metrics: any;
        taskStatus: TaskStatus;
        persistence?: TurnPersistenceResult;
    }> {
        const {
            ctx, M, env, overrides, loopOpts,
            sessionManager, tenantId, sessionId, agentId,
            isStreaming, getSessionStorePrisma, eventBus, throwOnSaveFailure
        } = params;

        // ✅ FIX: Increment turn count immediately so initialization logs reflect the correct turn
        env.turn = (env.turn || 0) + 1;
        updateLoggingContext({ turn: env.turn });

        if (process.env.DEBUG_BACKGROUND_TASKS) {
            console.log('[TaskExecutor.executeTurn] About to call runLoop', {
                maxTurns: loopOpts.maxTurns,
                envTurn: env.turn,
                envBudgetMaxTurns: (env as any).budget?.maxTurns
            });
        }

        TaskExecutor.ensureUsageRecorderAttached(ctx);
        await TaskExecutor.ensureAgentLlmAttached({
            ctx,
            agentId,
            sessionManager,
            tenantId,
            sessionId,
        });

        // Exposed flush for logic that needs DB sync (like starting subagents)
        // This MUST be defined before runLoop so the loop can use it!
        (ctx as any).flushSnapshot = async (current?: { M?: MentalState; env?: EnvironmentState }) => {
            if (!sessionManager) {
                log.warn('Manual flushSnapshot skipped - sessionManager missing', { tenantId, sessionId });
                return;
            }
            // Fallback to closure variables if not provided (e.g. called from TaskEngine where ctx.env is missing)
            const envToUse = current?.env || env;
            const mToUse = current?.M || M;

            try {
                // We use a simplified save here - explicitly NOT pruning, just flushing current state
                // ✅ FIX: Prevent event loop drain during async offload (Prisma/Network might yield too aggressively)
                const keepAlive = setInterval(() => { }, 1000);
                try {
                    await TaskExecutor.saveSnapshot({
                        sessionManager,
                        tenantId,
                        sessionId,
                        agentId,
                        env: envToUse,
                        M: mToUse,
                        mNext: mToUse, // snapshot "now" implies next is same as current 
                        outcome: { kind: 'continue', observations: [] }, // intermediate flush implies continue
                        loopOpts,
                        ctx,
                        getSessionStorePrisma,
                    });
                } finally {
                    clearInterval(keepAlive);
                }
                // Mark as saved so we don't worry about duplicate saves if loop finishes comfortably?
                (ctx as any).__wmSavedThisTurn = true;
            } catch (e) {
                log.warn('Manual flushSnapshot failed', { error: (e as Error).message });
                throw e; // let caller decide
            }
        };

        // ✅ FIX: Ensure memory backends are initialized before running loop
        // Memory registry may have been lost during session save/restore or context recreation
        const semanticBackends = Object.keys((ctx as any).memory?.semantic?.backends || {});
        const defaultBackend = (ctx as any).memory?.semantic?.getDefaultBackend?.();

        if (semanticBackends.length === 0 || defaultBackend === 'none') {
            log.debug('Memory backends empty or stub detected, reinitializing', {
                turn: env.turn,
                agentId,
            });

            try {
                const { extendContextWithMemory, getMemoryPrismaClient } = await import('@a2arium/callagent-memory-engine');
                const { createEmbeddingFunction, isEmbeddingAvailable } = await import('../llm/LLMFactory.js');

                // We don't need embedding function here as proper config will handle it via UnifiedMemoryService if configured
                // But we keep existingPrisma logic
                const existingPrisma = getSessionStorePrisma?.() || await getMemoryPrismaClient();

                // Use extendContextWithMemory to ensure facades (ctx.semantic, etc.) are also attached
                // Passing empty config {} will result in default 'basic' memory profile
                await extendContextWithMemory(
                    ctx as any,
                    tenantId,
                    agentId || 'default',
                    {},
                    undefined,
                    existingPrisma
                );

                log.info('Memory registry and facades re-initialized successfully', {
                    turn: env.turn,
                    agentId,
                    backends: Object.keys((ctx as any).memory?.semantic?.backends || {})
                });
            } catch (memErr) {
                log.error('Failed to reinitialize memory registry', {
                    turn: env.turn,
                    error: memErr instanceof Error ? memErr.message : String(memErr)
                });
                // Continue with stub memory - better than crashing
            }
        }

        if (eventBus) {
            try {
                bindRuntimeCognitionStream({ ctx, eventBus, tenantId, sessionId, agentId });
            } catch {
                /* noop */
            }
        }

        // Run the loop
        let outcome: LoopOutcome;
        let mNext: MentalState;
        let metrics: any;

        // ✅ FIX: Prevent event loop drain during runLoop execution (e.g. async artifact hydration, LLM calls)
        const loopKeepAlive = setInterval(() => { }, 1000);

        try {
            // ✅ FIX: Register active loop context so handleToolCompleted can inject results
            // instead of starting a redundant runTurn
            const { LoopRegistry } = await import('./LoopRegistry.js');
            LoopRegistry.__activeLoopContexts.set(sessionId, ctx);
            try {
                const result = await runLoop(ctx, M, env, overrides, {
                    ...loopOpts,
                    onTurnCheckpoint: async (state) => {
                        if (!sessionManager || state.consumedConversationMessageKeys.size === 0) {
                            return;
                        }
                        await TaskExecutor.saveSnapshot({
                            sessionManager,
                            tenantId,
                            sessionId,
                            agentId,
                            env: state.env,
                            M,
                            mNext: state.M,
                            outcome: state.outcome,
                            loopOpts,
                            ctx,
                            getSessionStorePrisma
                        });
                    },
                });
                if (process.env.DEBUG_BACKGROUND_TASKS) {
                    console.log('[TaskExecutor] runLoop result:', {
                        hasResult: !!result,
                        hasM: !!result?.M,
                        hasOutcome: !!result?.outcome
                    });
                }
                mNext = result.M;

                outcome = result.outcome;
                metrics = result.metrics;
            } finally {
                LoopRegistry.__activeLoopContexts.delete(sessionId);
            }
        } catch (loopError) {
            console.error('[TaskExecutor] runLoop threw an error:', loopError);
            log.error('runLoop exception', { error: loopError instanceof Error ? loopError.message : String(loopError) });
            throw loopError;
        } finally {
            clearInterval(loopKeepAlive);
        }

        if (process.env.DEBUG_BACKGROUND_TASKS) {
            console.log('[TaskExecutor.executeTurn] runLoop returned', {
                outcome: outcome.kind,
                reason: (outcome as any).reason
            });
        }

        // Persist state
        let taskStatus: TaskStatus = { state: 'working', timestamp: new Date().toISOString() };

        let persistence: TurnPersistenceResult | undefined;
        if (sessionManager) {
            try {
                // Ensure we don't overwrite if already saved inside loop (vars dirty check etc?)
                // TaskEngine logic had checks for `__wmSavedThisTurn`.
                // For now, we assume this is the main save point at end of turn.
                // If the loop saved internally (rare?), we might double save or need that flag.
                // TaskEngine checks: if (this.sessionManager) ...

                // ✅ FIX: Prevent event loop drain during async offload at end of turn
                const keepAlive = setInterval(() => { }, 1000);

                try {
                    persistence = await TaskExecutor.saveSnapshot({
                        sessionManager,
                        tenantId,
                        sessionId,
                        agentId,
                        env,
                        M,
                        mNext,
                        outcome,
                        loopOpts,
                        ctx,
                        getSessionStorePrisma,
                        finalizeTurnClaim: true,
                    });
                } finally {
                    clearInterval(keepAlive);
                }

                (ctx as any).__wmSavedThisTurn = true;
            } catch (e) {
                // Logic for retrying with prune
                if ((e as Error).message === 'LIMIT_WM_SNAPSHOT_TOO_LARGE') {
                    try {
                        log.warn('Snapshot too large at end of turn, pruning and retrying...');
                        persistence = await TaskExecutor.saveSnapshot({
                            sessionManager,
                            tenantId,
                            sessionId,
                            agentId,
                            env,
                            M,
                            mNext,
                            outcome,
                            loopOpts,
                            ctx,
                            getSessionStorePrisma,
                            prune: true,
                            finalizeTurnClaim: true,
                        });
                        (ctx as any).__wmSavedThisTurn = true;
                    } catch (err) {
                        if (isSnapshotReconciliationError(err)) throw err;
                        if (currentTaskTurnClaim() !== undefined) throw err;
                        if (throwOnSaveFailure) throw err;
                        log.error('Snapshot save failed after prune (end of turn)', { error: err });
                    }
                } else {
                    if (isSnapshotReconciliationError(e)) throw e;
                    if (currentTaskTurnClaim() !== undefined) throw e;
                    if (throwOnSaveFailure) throw e;
                    log.warn('TaskExecutor saveSnapshot block caught exception', {
                        error: (e as Error).message,
                        sessionId,
                        outcomeKind: outcome.kind
                    });
                }
            }
        }

        // The durable terminal winner is authoritative. A local outcome may have
        // lost arbitration and must never replace that status.
        taskStatus = persistence?.terminal?.status ?? TaskExecutor.determineTaskStatus(outcome, metrics, isStreaming);
        if (persistence === undefined || persistence.disposition === 'committed') {
            taskStatus = TaskExecutor.attachUsageToTaskStatus(taskStatus, ctx);
        }

        const internalCtx = ctx as InternalTaskContext;
        if (internalCtx.__pendingTerminalIntent !== undefined) {
            const explicitState = outcome.kind === 'complete'
                ? 'completed'
                : outcome.kind === 'fail' ? 'failed' : undefined;
            if (explicitState !== internalCtx.__pendingTerminalIntent.state) {
                defaultMetricsRegistry.increment('task.terminal_intent_total', {
                    status: 'conflict',
                    intent: internalCtx.__pendingTerminalIntent.state,
                    transition: explicitState ?? outcome.kind,
                });
                log.warn('Buffered terminal intent disagreed with explicit loop transition', {
                    tenantId,
                    taskId: sessionId,
                    intentState: internalCtx.__pendingTerminalIntent.state,
                    transition: explicitState ?? outcome.kind,
                });
            }
            internalCtx.__clearTerminalIntent?.();
        }

        // Emit Status
        if (!isStreaming) {
            // For non-streaming, TaskEngine handles final return usually?
            // But we can emit intermediate status here if needed.
        } else {
            // Emit? TaskEngine emitted for streaming failures.
            // TaskEngine.ts line 2400 emit 'failed'.
            // Success? line 2309 publish final completion.
        }

        if (currentTaskTurnClaim() !== undefined) {
            await flushBufferedOperatorTurnEvents(
                ctx,
                persistence?.disposition === 'committed' ? 'committed' : 'superseded'
            );
        }

        (ctx as InternalTaskContext).__conversationConsumedDeliveryKeys = undefined;

        return { M: mNext, outcome, metrics, taskStatus, ...(persistence ? { persistence } : {}) };
    }

    /**
     * Consolidates the complex logic for saving snapshots with all the "fixes"
     * (awaiting metadata, variable merging, inbox merging, artifact offloading).
     */
    private static async saveSnapshot(params: {
        sessionManager: SessionManager;
        tenantId: string;
        sessionId: string;
        agentId: string;
        env: EnvironmentState;
        M: MentalState;
        mNext: MentalState;
        outcome: LoopOutcome;
        loopOpts: any;
        ctx: TaskContext;
        getSessionStorePrisma: () => any;
        prune?: boolean;
        finalizeTurnClaim?: boolean;
    }) {
        const {
            sessionManager, tenantId, sessionId, agentId,
            env, M, mNext, outcome, loopOpts, ctx,
            getSessionStorePrisma, prune
        } = params;

        // Apply hygiene caps if not pruning (prune does it internally mostly)
        if (!prune) {
            try {
                // Use imported pruneMentalState if available or inline?
                // It was: const { pruneMentalState } = await import('../loop/hygiene.js');
                // We imported pruneSnapshot from hygiene.js. Check if pruneMentalState is exported.
                // Assuming hygiene.js has it. if not, loopRunner import handles it?
                // TaskEngine did dynamic import.
            } catch { /* noop */ }
        }

        const consumedKeysFromRun =
            (ctx as InternalTaskContext).__conversationConsumedDeliveryKeys ?? new Set<string>();
        const a2aParent = (ctx as A2AParentContext).__a2aParent;
        let mNextEffective = mNext;
        if (prune) {
            mNextEffective = pruneSnapshot(mNext);
        }
        const snapshotPrisma = getSessionStorePrisma() || (sessionManager as any).prisma;
        const childResultCache = snapshotPrisma ? new AgentResultCache(snapshotPrisma) : undefined;

        // Inject LLM history into snapshot base
        let attachedLlmState: unknown = undefined;
        try {
            const llmAny = (ctx as any).llm as any;
            const historyMode = (typeof llmAny?.getHistoryMode === 'function') ? llmAny.getHistoryMode() : 'full';

            if (historyMode !== 'stateless') {
                if (llmAny?.getMessages) {
                    const messages = llmAny.getMessages(true);
                    attachedLlmState = { messages } as unknown;
                } else if (llmAny?.exportState) {
                    attachedLlmState = llmAny.exportState();
                }
            }
        } catch (err) {
            log.warn('Failed to fetch LLM state during saveSnapshot', { error: (err as Error).message });
        }

        // Artifact publication and JSON normalization are external/expensive effects. Do
        // them once before entering the replayable CAS mutator so retries remain pure and
        // Prisma never sees LocalArtifact.then (or another non-JSON value).
        mNextEffective = await prepareChildResultForPersistence(
            mNextEffective,
            childResultCache,
            tenantId
        ) as MentalState;
        const preparedLocalInbox = await prepareChildResultForPersistence(
            await prepareChildResultsInInboxForPersistence(
                InboxManager.normalizeInbox(env.inbox),
                childResultCache,
                tenantId
            ),
            childResultCache,
            tenantId
        ) as ReturnType<typeof InboxManager.normalizeInbox>;
        if (attachedLlmState !== undefined) {
            attachedLlmState = await prepareChildResultForPersistence(
                attachedLlmState,
                childResultCache,
                tenantId
            );
        }
        const preparedOutcomeResult = outcome.kind === 'complete'
            ? await prepareChildResultForPersistence(outcome.result, childResultCache, tenantId)
            : undefined;
        const activeIdempotencyKey = currentSegmentIdempotencyKey();
        const activeTurnClaim = currentTaskTurnClaim();
        const terminalIntent = (ctx as InternalTaskContext).__pendingTerminalIntent;
        const persisted = await reconcileSnapshotMutation<{
            disposition: TurnPersistenceResult['disposition'];
            terminal?: DurableTaskTerminal;
            scheduleNext: boolean;
        }>({
            session: sessionManager,
            tenantId,
            sessionId,
            agentId: agentId || 'default',
            operation: 'turn.persist',
            mutate: async ({ snapshot: baseNow, storageNow }) => {
                if (activeTurnClaim !== undefined) {
                    try {
                        assertCurrentTaskTurn(baseNow, {
                            tenantId,
                            taskId: sessionId,
                            claim: activeTurnClaim,
                            operation: 'turn.persist',
                            storageNow,
                        });
                    } catch (error) {
                        if (!(error instanceof TaskTurnSupersededError)) throw error;
                        return {
                            kind: 'noop',
                            value: {
                                disposition: 'superseded' as const,
                                terminal: readDurableTaskTerminal(baseNow),
                                scheduleNext: false,
                            },
                        };
                    }
                    baseNow = setTaskTurnPhaseInSnapshot(baseNow, {
                        tenantId,
                        taskId: sessionId,
                        claim: activeTurnClaim,
                        phase: 'committing',
                        storageNow,
                    });
                }
                const prevMeta = (baseNow as any).meta || {};
                const consumedKeysFromSnapshot = readConsumedConversationDeliveryKeysFromMeta(prevMeta);
                const consumedKeys = new Set<string>([
                    ...consumedKeysFromSnapshot,
                    ...consumedKeysFromRun,
                ]);
                const lifecycleBase = ensureTaskLifecycle(baseNow, {
                    taskId: sessionId,
                    ...(a2aParent?.parentTaskId ? { parentTaskId: a2aParent.parentTaskId } : {}),
                });
                const terminalClaim = outcome.kind === 'complete' || outcome.kind === 'fail'
                    ? claimTaskTerminalInSnapshot(lifecycleBase, {
                          taskId: sessionId,
                          state: outcome.kind === 'complete' ? 'completed' : 'failed',
                          claimedAt: storageNow,
                          ...(outcome.kind === 'fail' ? { reason: outcome.reason } : {}),
                          status: outcome.kind === 'complete'
                              ? {
                                    state: 'completed',
                                    timestamp: storageNow,
                                    ...(terminalIntent?.state === 'completed' && terminalIntent.message
                                        ? { message: { role: 'agent' as const, parts: [{ type: 'text' as const, text: terminalIntent.message }] } }
                                        : {}),
                                    metadata: {
                                        result: preparedOutcomeResult,
                                        ...(terminalIntent?.state === 'completed' && terminalIntent.usage
                                            ? { usage: terminalIntent.usage }
                                            : {}),
                                        ...(terminalIntent?.state === 'completed' && terminalIntent.progress !== undefined
                                            ? { progress: terminalIntent.progress }
                                            : {}),
                                    },
                                }
                              : {
                                    state: 'failed',
                                    timestamp: storageNow,
                                    message: {
                                        role: 'agent',
                                        parts: [{
                                            type: 'text',
                                            text: terminalIntent?.state === 'failed' && terminalIntent.message
                                                ? terminalIntent.message
                                                : `Loop failed: ${outcome.reason}`,
                                        }],
                                    },
                                    metadata: {
                                        reason: outcome.reason,
                                        ...(terminalIntent?.state === 'failed' && terminalIntent.usage
                                            ? { usage: terminalIntent.usage }
                                            : {}),
                                    },
                          },
                          ...(activeTurnClaim ? {
                              turnClaim: {
                                  attemptKey: `claim:${activeTurnClaim.claimId}`,
                                  claimId: activeTurnClaim.claimId,
                                  fence: activeTurnClaim.fence,
                                  generation: activeTurnClaim.claimedGeneration,
                                  turnSeq: activeTurnClaim.turnSeq,
                              },
                          } : {}),
                      })
                    : undefined;
                if (terminalClaim?.disposition === 'competing_terminal') {
                    return {
                        kind: 'noop',
                        value: {
                            disposition: 'competing_terminal',
                            terminal: terminalClaim.terminal,
                            scheduleNext: false,
                        },
                    };
                }
                const lifecycleSnapshot = terminalClaim?.snapshot ?? lifecycleBase;
                const taskLifecycle = readTaskLifecycle(lifecycleSnapshot, sessionId);
                const lifecycleMeta = (lifecycleSnapshot as { meta?: Record<string, unknown> }).meta ?? {};
                const nextMeta = {
                    ...prevMeta,
                    ...lifecycleMeta,
                    turn: env.turn,
                    budgets: loopOpts,
                    ...(taskLifecycle !== undefined ? { taskLifecycle } : {}),
                    ...(a2aParent ? { a2aParent } : {}),
                    ...(ctx.telemetry ? { telemetry: ctx.telemetry } : {})
                };
                if (consumedKeysFromRun.size > 0) {
                    Object.assign(
                        nextMeta,
                        writeConsumedConversationDeliveryKeysToMeta(nextMeta, consumedKeysFromRun)
                    );
                }

                if (outcome.kind === 'await_child' || outcome.kind === 'await_tool' || outcome.kind === 'await_event') {
                    (nextMeta as any).awaiting = { kind: outcome.kind, token: (outcome as any).token };
                } else {
                    delete (nextMeta as any).awaiting;
                }

                const remotePending = ((baseNow as any).pending ?? {}) as Record<string, any>;
                const localPending = (env.pending ?? {}) as Record<string, any>;
                const childTerminals = {
                    ...(localPending.childTerminals ?? {}),
                    ...(remotePending.childTerminals ?? {}),
                } as Record<string, unknown>;
                const toolTerminals = boundPendingToolTerminals({
                    ...(localPending.toolTerminals ?? {}),
                    ...(remotePending.toolTerminals ?? {}),
                } as PendingToolTerminals);
                const children = {
                    ...(remotePending.children ?? {}),
                    ...(localPending.children ?? {}),
                } as Record<string, unknown>;
                const tasks = {
                    ...(localPending.tasks ?? {}),
                    ...(remotePending.tasks ?? {}),
                } as Record<string, any>;
                for (const token of Object.keys(childTerminals)) {
                    delete children[token];
                    if (remotePending.tasks?.[token]?.terminal === undefined) {
                        delete tasks[token];
                    }
                }
                const tools = {
                    ...(remotePending.tools ?? {}),
                    ...(localPending.tools ?? {}),
                } as Record<string, unknown>;
                for (const token of Object.keys(toolTerminals)) {
                    delete tools[token];
                }

                const remoteInbox = filterInboxCurrentByConversationDeliveryKeys(
                    InboxManager.normalizeInbox((baseNow as any)?.inbox),
                    consumedKeys
                );
                const localInbox = filterInboxCurrentByConversationDeliveryKeys(
                    preparedLocalInbox,
                    consumedKeys
                );
                const terminalOrActiveChildren = { ...children, ...childTerminals };
                let nextInbox = InboxManager.mergeInboxes(
                    localInbox,
                    remoteInbox,
                    terminalOrActiveChildren
                );
                if (prune) {
                    nextInbox = InboxManager.normalizeInbox(pruneSnapshot(nextInbox as any) as any);
                }

                const nextPending = {
                    ...remotePending,
                    ...localPending,
                    inputs: { ...(remotePending.inputs ?? {}), ...(localPending.inputs ?? {}) },
                    children,
                    tasks,
                    childTerminals,
                    tools,
                    toolTerminals,
                    events: { ...(remotePending.events ?? {}), ...(localPending.events ?? {}) },
                    groups: { ...(remotePending.groups ?? {}), ...(localPending.groups ?? {}) },
                    controlVars: { ...(remotePending.controlVars ?? {}), ...(localPending.controlVars ?? {}) },
                    manifestConsents: { ...(remotePending.manifestConsents ?? {}), ...(localPending.manifestConsents ?? {}) },
                };
                let next = {
                    ...baseNow,
                    M: mNextEffective,
                    meta: nextMeta,
                    inbox: nextInbox,
                    pending: nextPending,
                    ...(attachedLlmState ? { llmState: attachedLlmState } : {})
                } as Record<string, unknown>;
                if (activeIdempotencyKey !== undefined) {
                    next = addProcessedSegmentKey(next, activeIdempotencyKey);
                }
                let scheduleNext = false;
                if (activeTurnClaim !== undefined && params.finalizeTurnClaim === true) {
                    const finalized = completeTaskTurnInSnapshot(next, {
                        tenantId,
                        taskId: sessionId,
                        claim: activeTurnClaim,
                        storageNow,
                    });
                    if (finalized.disposition === 'superseded') {
                        throw new TaskTurnSupersededError({
                            tenantId,
                            taskId: sessionId,
                            claimId: activeTurnClaim.claimId,
                            fence: activeTurnClaim.fence,
                            operation: 'turn.persist.finalize',
                        });
                    }
                    next = finalized.snapshot;
                    scheduleNext = finalized.scheduleNext;
                }

                const terminalDisposition: TurnPersistenceResult['disposition'] =
                    terminalClaim?.disposition === 'matching_replay' ? 'matching_terminal' : 'committed';
                return {
                    kind: 'write',
                    snapshot: next,
                    value: {
                        disposition: terminalDisposition,
                        ...(terminalClaim ? { terminal: terminalClaim.terminal } : {}),
                        scheduleNext,
                    },
                };
            },
        });
        let committedSnapshot = persisted.snapshot;
        let committedVersion = persisted.wmVersion;
        if (persisted.value.disposition === 'committed' && snapshotPrisma && childResultCache) {
            const projected = await publishArtifactProjection({
                sessionManager,
                tenantId,
                sessionId,
                agentId: agentId || 'default',
                snapshot: committedSnapshot,
                wmVersion: committedVersion,
                cache: childResultCache,
            });
            committedSnapshot = projected.snapshot;
            committedVersion = projected.wmVersion;
        }
        return {
            ...persisted.value,
            snapshot: committedSnapshot,
            wmVersion: committedVersion,
        } satisfies TurnPersistenceResult;
    }

    private static determineTaskStatus(outcome: LoopOutcome, metrics: any, isStreaming: boolean): TaskStatus {
        const timingsArray = metrics?.timings || [];
        const rewardsArray = metrics?.rewards || [];

        // Aggregations (simplified from TaskEngine for brevity, or full implementation)
        // ... (Implement aggregation logic if strictly needed, or pass full metrics)

        if (outcome.kind === 'await_input') {
            return { state: 'input-required', timestamp: new Date().toISOString(), metadata: { token: (outcome as any).token, awaitExtra: { kind: outcome.kind }, timings: metrics?.timings, rewards: metrics?.rewards } } as any;
        }
        if (outcome.kind === 'await_child' || outcome.kind === 'await_tool' || outcome.kind === 'await_event') {
            return { state: 'working', timestamp: new Date().toISOString(), metadata: { awaiting: outcome.kind, token: (outcome as any).token, awaitExtra: { kind: outcome.kind } } } as any;
        }
        if (outcome.kind === 'fail') {
            return {
                state: 'failed',
                timestamp: new Date().toISOString(),
                message: { role: 'agent', parts: [{ type: 'text', text: `Loop failed: ${outcome.reason}` }] },
                metadata: { reason: outcome.reason }
            } as any;
        }
        if (outcome.kind === 'complete') {
            return {
                state: 'completed',
                timestamp: new Date().toISOString(),
                metadata: { result: (outcome as any).result }
            } as any;
        }
        return { state: 'working', timestamp: new Date().toISOString() } as any;
    }

    private static ensureUsageRecorderAttached(ctx: TaskContext): void {
        const candidate = ctx as TaskContext & {
            __usageRecorderInstalled?: boolean;
            __usageRecords?: Array<Record<string, unknown>>;
        };
        if (candidate.__usageRecorderInstalled === true) {
            return;
        }

        let totalCost = 0;
        const byKind: Record<string, number> = {};
        const records: Array<Record<string, unknown>> = [];
        candidate.__usageRecords = records;
        candidate.recordUsage = (usage: number | Record<string, unknown>) => {
            const record =
                typeof usage === 'number'
                    ? { cost: usage, kind: 'other' }
                    : { ...usage };
            records.push(record);
            const cost = Number(record.cost) || 0;
            totalCost += cost;
            const kind = typeof record.kind === 'string' && record.kind.length > 0
                ? record.kind
                : 'other';
            byKind[kind] = (byKind[kind] || 0) + cost;
        };
        candidate.getUsage = () => ({
            totalCost,
            byKind: { ...byKind },
        });
        candidate.__usageRecorderInstalled = true;
    }

    private static attachUsageToTaskStatus(taskStatus: TaskStatus, ctx: TaskContext): TaskStatus {
        const usage = ctx.getUsage?.();
        if (!usage || usage.totalCost <= 0) {
            return taskStatus;
        }
        return {
            ...taskStatus,
            metadata: {
                ...(taskStatus.metadata ?? {}),
                usage,
            },
        } as TaskStatus;
    }

    private static async ensureAgentLlmAttached(params: {
        ctx: TaskContext;
        agentId: string;
        sessionManager: SessionManager | undefined;
        tenantId: string;
        sessionId: string;
    }): Promise<void> {
        const { ctx, agentId, sessionManager, tenantId, sessionId } = params;
        if (!agentId) return;

        try {
            const { PluginManager } = await import('../plugin/pluginManager.js');
            const plugin = PluginManager.findAgent(agentId);
            if (!plugin?.llmAdapter && !plugin?.llmConfig) {
                (ctx as InternalTaskContext).__llmConfigured = false;
                return;
            }

            if (plugin.llmAdapter) {
                (ctx as any).llm = plugin.llmAdapter;
            } else if (plugin.llmConfig) {
                const { createLLMForTask } = await import('../llm/LLMFactory.js');
                (ctx as any).llm = createLLMForTask(plugin.llmConfig, ctx);
            }
            (ctx as InternalTaskContext).__llmConfigured = true;

            const llmAny = (ctx as any).llm as {
                getHistoryMode?: () => 'stateless' | 'dynamic' | 'full';
                clearHistory?: () => void;
                importState?: (state: unknown) => void;
            };
            const historyMode =
                typeof llmAny?.getHistoryMode === 'function'
                    ? llmAny.getHistoryMode()
                    : 'full';

            if (historyMode === 'stateless') {
                llmAny?.clearHistory?.();
                return;
            }

            const snap = await sessionManager?.load(tenantId, sessionId);
            const llmState = (snap?.snapshot as { llmState?: unknown } | undefined)?.llmState;
            if (llmState !== undefined && typeof llmAny?.importState === 'function') {
                llmAny.importState(llmState);
            }
        } catch (error) {
            log.warn('Failed to attach agent LLM before turn execution', {
                agentId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}

async function publishArtifactProjection(params: {
    sessionManager: SessionManager;
    tenantId: string;
    sessionId: string;
    agentId: string;
    snapshot: Record<string, unknown>;
    wmVersion: bigint;
    cache: AgentResultCache;
}): Promise<{ snapshot: Record<string, unknown>; wmVersion: bigint }> {
    let snapshot = params.snapshot;
    let wmVersion = params.wmVersion;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const projected = structuredClone(snapshot);
        try {
            await offloadArtifacts(projected, params.cache, params.tenantId);
        } catch (error) {
            log.warn('Post-commit artifact publication failed', {
                tenantId: params.tenantId,
                sessionId: params.sessionId,
                error: error instanceof Error ? error.message : String(error),
            });
            return { snapshot, wmVersion };
        }
        if (JSON.stringify(projected) === JSON.stringify(snapshot)) return { snapshot, wmVersion };
        try {
            const written = await params.sessionManager.saveSnapshot({
                tenantId: params.tenantId,
                sessionId: params.sessionId,
                agentId: params.agentId,
                expectedWmVersion: wmVersion,
                snapshot: projected,
            });
            return { snapshot: projected, wmVersion: written?.newVersion ?? wmVersion };
        } catch (error) {
            if (attempt === 3) {
                log.warn('Post-commit artifact snapshot projection was superseded', {
                    tenantId: params.tenantId,
                    sessionId: params.sessionId,
                });
                return { snapshot, wmVersion };
            }
            const latest = await params.sessionManager.load(params.tenantId, params.sessionId);
            if (!latest) return { snapshot, wmVersion };
            snapshot = latest.snapshot;
            wmVersion = latest.wmVersion;
        }
    }
    return { snapshot, wmVersion };
}
