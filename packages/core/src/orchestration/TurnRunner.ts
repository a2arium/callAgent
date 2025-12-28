import { logger } from '@a2arium/callagent-utils';
import { TaskContext } from '../shared/types/index.js';
import { TaskEntity } from './types.js';
import { MentalState, EnvironmentState } from '../loop/types.js';
import { initialM } from '../loop/init.js';
import { SessionManager } from './SessionManager.js';
import { ApiBinder } from './api/ApiBinder.js';
import { VarsSync } from './synchronization/VarsSync.js';
import { TaskExecutor } from './TaskExecutor.js';
import { InboxManager, EngineObservation } from './InboxManager.js';
import { ArtifactHydrationService } from './ArtifactHydrationService.js';
import { PluginManager } from '../plugin/pluginManager.js';
import { AgentResultCache, hydrateArtifacts } from '@a2arium/callagent-memory-engine';
import { eventBus } from '../eventbus/inMemoryEventBus.js';
import { taskChannel } from '../eventbus/taskEventEmitter.js';
import { TaskStateUtils } from './utils/TaskStateUtils.js';

// Re-export type for convenience
export type TurnTrigger = 'start' | 'resume' | 'tool' | 'event';

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
}

const log = logger.createLogger({ prefix: 'TurnRunner' });

export class TurnRunner {
    constructor(
        private sessionManager: SessionManager,
        private apiBinder: ApiBinder,
        private getSessionStorePrisma: () => any
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

            // 3. Setup Vars Facade & Sync
            const currentVars = ((M.memory as any)?.vars || {}) as Record<string, unknown>;
            const varCache = new Map<string, unknown>(Object.entries(currentVars));

            // Define helper for removing keys (adapted from TaskEngine)
            const iterMentalTargets = (
                fn: (args: { target: Record<string, unknown>; memory: Record<string, unknown>; existing: Record<string, unknown> }) => void
            ): void => {
                const candidates: unknown[] = [
                    M,
                    (ctx as any).M,
                    (ctx as any).__mental
                ];

                for (const mental of candidates) {
                    if (!mental || typeof mental !== 'object') continue;
                    const target = mental as Record<string, unknown>;
                    let memory = target.memory;

                    if (!memory || typeof memory !== 'object' || Array.isArray(memory)) {
                        memory = {};
                        target.memory = memory as Record<string, unknown>;
                    }

                    const existing = ((memory as Record<string, unknown>).vars ?? {}) as Record<string, unknown>;
                    fn({ target, memory: memory as Record<string, unknown>, existing });
                }
            };

            const removeKeyFromMental = (key: string): void => {
                iterMentalTargets(({ target, memory, existing }) => {
                    let updated: Record<string, unknown> | undefined;
                    if (Object.prototype.hasOwnProperty.call(existing, key)) {
                        updated = { ...existing };
                        delete updated[key];
                    }
                    if (updated) {
                        (memory as Record<string, unknown>).vars = updated;
                        target.vars = updated;
                    }
                });
            };

            (ctx as any).vars = VarsSync.createVarsProxy(
                varCache,
                (key, value) => { (ctx as any).__varsDirty = true; },
                (key) => { (ctx as any).__varsDirty = true; removeKeyFromMental(key); }
            );

            // Sync immediately
            VarsSync.assignVarsIntoMental(ctx, varCache, [M, (ctx as any).M]);


            // 4. Attach APIs and Flush Helper
            const flushMentalState = async () => {
                const mutateFn = async (baseSnap: Record<string, unknown>) => {
                    VarsSync.assignVarsIntoMental(ctx, varCache, [M, (ctx as any).M]);
                    return { ...baseSnap, M };
                };

                await this.sessionManager.saveSnapshot({
                    tenantId,
                    sessionId,
                    agentId: (ctx as any).agentId || 'default',
                    expectedWmVersion: snap?.wmVersion ?? BigInt(0),
                    snapshot: await mutateFn(base)
                });
                (ctx as any).__varsDirty = false;
            };

            await this.apiBinder.attachOrchestrationAPIs(ctx, {
                tenantId,
                sessionId,
                agentId: (ctx as any).agentId || 'default',
                flushMentalState
            });

            // 5. Environment & Inbox Setup
            const startTurnTotal = Number((base as any)?.meta?.turn) || 0;
            let envInbox = InboxManager.normalizeInbox((base as any)?.inbox);
            // Hydrate
            envInbox = ArtifactHydrationService.hydrateInboxArtifacts(
                envInbox,
                this.getSessionStorePrisma(),
                tenantId,
                trigger
            );

            // Inject initial input if present
            if (trigger === 'start' && params.input) {
                const inputObservation: EngineObservation = {
                    source: 'user',
                    kind: 'input.provided',
                    payload: {
                        token: `input-start-${sessionId}`,
                        value: params.input
                    },
                    provenance: {
                        ts: Date.now(),
                        turn: startTurnTotal + 1,
                        id: `input-start-${sessionId}`,
                        correlationId: `input-start-${sessionId}`
                    }
                };
                envInbox = InboxManager.addObservationToInbox(envInbox, inputObservation);
            }

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
                        const events = await this.sessionManager.listEventsSince({ tenantId, sessionId, sinceSeq: 0 });
                        const childCompletedEvents = events.filter((e: any) => e.type === 'task.child_completed');

                        for (const token of tokensToCheck) {
                            const completionEvent = childCompletedEvents.find((e: any) =>
                                (e.payload as any)?.token === token
                            );

                            if (completionEvent) {
                                const observationPredicate = (obs: EngineObservation) =>
                                    obs?.kind === 'child.completed' &&
                                    typeof obs === 'object' &&
                                    obs !== null &&
                                    (obs as any)?.payload &&
                                    (obs as any).payload.token === token;

                                const childPrisma = this.getSessionStorePrisma();
                                if (childPrisma) {
                                    const p = (completionEvent.payload as any);
                                    if (p?.result) {
                                        const cache = new AgentResultCache(childPrisma);
                                        p.result = hydrateArtifacts(p.result, cache, tenantId);
                                    }
                                }

                                const completionResult = (completionEvent.payload as any)?.result;
                                const cleanChildResult = TaskStateUtils.extractCleanChildResult(completionResult);
                                const childObservation: EngineObservation = {
                                    source: 'child',
                                    kind: 'child.completed',
                                    payload: {
                                        token,
                                        childTaskId: cleanChildResult.childTaskId || (completionEvent.payload as any)?.childTaskId,
                                        result: cleanChildResult.result,
                                        agentId: (completionEvent.payload as any)?.agentId,
                                        executionMetadata: cleanChildResult.executionMetadata
                                    },
                                    provenance: {
                                        ts: new Date(completionEvent.createdAt).getTime(),
                                        turn: startTurnTotal + 1,
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
                turn: startTurnTotal + 1,
                budget: { maxTurns: Infinity, latencyMs: Infinity },
                inbox: envInbox,
                pending: (base as any)?.pending || {},
                lastExec: (base as any)?.meta?.lastExec,
                externalEvents: undefined
            };

            // Budgeting
            const agentId = (ctx as any).agentId;
            const plugin = agentId ? PluginManager.findAgent(agentId) : null;
            const moduleOverrides = (plugin as any)?.loop?.modules || {};

            // Restore budgets
            let loopOpts: { maxTurns?: number; latencyMs?: number } = {};
            try {
                const persistedBudgets = (base as any)?.meta?.budgets;
                const manifestBudgets = (plugin?.manifest as any)?.budgets;
                const hitl = (plugin?.manifest as any)?.hitl;
                if (hitl) { try { (M as any).hitl = hitl; } catch { } }

                if (persistedBudgets && typeof persistedBudgets.maxTurns === 'number') {
                    loopOpts = persistedBudgets;
                } else if (manifestBudgets && typeof manifestBudgets === 'object') {
                    loopOpts = { maxTurns: manifestBudgets.maxTurns, latencyMs: manifestBudgets.latencyMs };
                } else {
                    loopOpts = { maxTurns: 1 };
                }

                if (typeof loopOpts.maxTurns === 'number') {
                    (env as any).budget = { maxTurns: loopOpts.maxTurns, latencyMs: loopOpts.latencyMs ?? Infinity };
                }
            } catch (err) {
                // ignore
            }

            // 6. Execute Turn
            const { outcome, taskStatus } = await TaskExecutor.executeTurn({
                ctx, M, env, overrides: moduleOverrides, loopOpts,
                sessionManager: this.sessionManager,
                tenantId, sessionId, agentId: agentId || 'default',
                isStreaming,
                getSessionStorePrisma: this.getSessionStorePrisma
            });

            // explicit flush at end of turn (if not already flushed)
            if (this.sessionManager && !(ctx as any).__wmSavedThisTurn) {
                try { await flushMentalState(); } catch (e) {
                    // simplified error handling for now - duplicate of TaskEngine logic?
                    // Ideally flushMentalState handles logic internally or throws specific errors.
                    // TaskEngine had retry logic here.
                    // TurnRunner's flushMentalState handles saveSnapshot.
                    if ((e as Error).message === 'LIMIT_WM_SNAPSHOT_TOO_LARGE') {
                        await this.sessionManager.appendEvent(tenantId, sessionId, 'wm.snapshot_limit', { size: 'unknown' });
                    } else { throw e; }
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
                    eventBus.publish(taskChannel(sessionId), {
                        id: sessionId,
                        status: taskResult.status,
                        final: true
                    } as any);
                } catch { }
            } else if (outcome.kind === 'fail') {
                taskResult.status = { state: 'failed', timestamp: new Date().toISOString() };
            }

            return taskResult;

        } catch (error) {
            log.error('TurnRunner error', { error });
            throw error;
        }
    }
}
