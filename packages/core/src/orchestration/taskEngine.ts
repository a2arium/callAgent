import type { TaskContext, TaskInput } from '../shared/types/index.js';
import { LoopRegistry } from './LoopRegistry.js';
import type { TaskStatus } from '../shared/types/StreamingEvents.js';
import { Artifact } from '../shared/types/index.js'; // Explicitly import Memory Artifact for usage
import { eventBus } from '../eventbus/inMemoryEventBus.js';
import { taskChannel } from '../eventbus/taskEventEmitter.js';
import { extendContextWithStreaming } from '../context/StreamingContext.js';
import { SessionManager } from './SessionManager.js';
import { InMemorySessionManager } from './InMemorySessionManager.js';
import type { IWorkingMemorySessionStore, WMSessionSnapshot } from '@a2arium/callagent-memory-engine';
import { decide } from './reducer.js';
import { applyInputProvided, getPendingInputs, setPendingInputs } from './DurableHandlerRegistry.js';
import type { DurableHandlerInvoker } from './DurableHandlerInvoker.js';
import { DurableHandlerInvokerCore } from './DurableHandlerInvoker.js';
import { InputHandle, createTaskHandle, createGroupHandle, type GroupHandle } from './Handles.js';
import { getPendingTasks, setPendingTasks, getPendingGroups, setPendingGroups } from './Handles.js';
import { globalA2AService } from './A2AService.js';
import * as uuid from 'uuid';
const uuidv7 = uuid.v7;

import { outboxPublisher } from '../eventbus/outboxPublisher.js';
import { createTraceparent } from '../tracing/Tracing.js';
import type { MentalState } from '../loop/types.js';
import { initialM } from '../loop/init.js';
import { telemetry } from '../telemetry/TelemetryCollector.js';
import { AgentNode } from '../telemetry/nodes/AgentNode.js';
import { WorkflowNode } from '../telemetry/nodes/WorkflowNode.js';
import type { NodeStatus } from '../telemetry/nodes/TelemetryNode.js';


import { logger } from '@a2arium/callagent-utils';

import { normalizeObservationInbox, type EnvironmentState, type ObservationInbox, type Snapshot } from '../loop/types.js';
import { writeControlVar } from '../loop/controlVarAccessors.js';
import type { Observation } from '../loop/oneTurn.js';
import { getPendingTools, setPendingTools } from './ToolsRegistry.js';
import { getPendingExternalEvents, setPendingExternalEvents } from './ExternalEventsRegistry.js';
import { PluginManager } from '../plugin/pluginManager.js';
import type { AgentPlugin } from '../plugin/types.js';
import { resolveManifestProvenance } from '../telemetry/manifestProvenance.js';
import type { ManifestProvenance, ManifestSource } from '../types/turnTrace.js';
import type { InternalTaskContext } from '../loop/internalContext.js';
import { extendContextWithMemory } from '@a2arium/callagent-memory-engine';
import { createMemoryRegistry } from '@a2arium/callagent-memory-engine';
import { ArtifactImpl, isArtifactMarker, type ArtifactMarker } from '@a2arium/callagent-memory-engine';
import { AgentResultCache } from '@a2arium/callagent-memory-engine';
import { hydrateArtifacts } from '@a2arium/callagent-memory-engine';
import { offloadArtifacts } from '@a2arium/callagent-memory-engine';
import { pruneSnapshot } from '../loop/hygiene.js';
import { ArtifactHydrationService, HYDRATED_ARTIFACT_HANDLE_SYMBOL } from './ArtifactHydrationService.js';
import { InboxManager, type EngineObservation, type EngineObservationInbox } from './InboxManager.js';
import { TaskExecutor } from './TaskExecutor.js';





import {
    TaskEntity,
    StartTaskParams,
    CleanChildResult
} from './types.js';

export type {
    TaskEntity,
    StartTaskParams,
    CleanChildResult
};







/**
 * A minimal task engine that handles task execution
 * This is a simplified implementation that would use XState in a full framework
 */

const log = logger.createLogger({ prefix: 'TaskEngine' });

/**
 * Merge ctx.telemetry into snapshot meta on every persist path (not only TaskExecutor.saveSnapshot).
 * Without this, a flush before tool await can drop meta.telemetry; tool resume then lacks traceId and
 * Opik turn spans attach to a new trace or are dropped.
 */
function mergeSnapshotMetaWithCtxTelemetry(
    baseSnap: Record<string, unknown>,
    ctx: TaskContext
): Record<string, unknown> {
    const prevMeta =
        baseSnap.meta != null && typeof baseSnap.meta === 'object' && !Array.isArray(baseSnap.meta)
            ? ({ ...(baseSnap.meta as Record<string, unknown>) } as Record<string, unknown>)
            : {};
    const nextMeta: Record<string, unknown> = { ...prevMeta };
    const tel = ctx.telemetry;
    if (tel != null && (tel.nodeId !== undefined || tel.traceId !== undefined)) {
        const prevTel =
            prevMeta.telemetry != null &&
            typeof prevMeta.telemetry === 'object' &&
            !Array.isArray(prevMeta.telemetry)
                ? ({ ...(prevMeta.telemetry as Record<string, unknown>) } as Record<string, unknown>)
                : {};
        nextMeta.telemetry = { ...prevTel, ...tel };
    }
    return nextMeta;
}

export type TaskEngineTestOverrides = {
    attachAndRestoreLLM?: (ctx: TaskContext, agentName: string | undefined, M: MentalState | undefined, baseSnap?: Record<string, unknown>) => Promise<void>;
};
// Re-export or use the extracted class
// Re-export or use the extracted class
import { FlushScheduler } from './engine/FlushScheduler.js';
import { PathUtils } from './utils/PathUtils.js';
import { SnapshotRepository } from './persistence/SnapshotRepository.js';
import { ApiBinder } from './api/ApiBinder.js';
import { TaskStateUtils } from './utils/TaskStateUtils.js';
import { TurnRunner } from './TurnRunner.js';
import { throwInvariantError } from '../utils/invariantError.js';
import type { InvariantErrorCode, InvariantErrorDetail } from '../types/invariantError.js';

// Legacy adapters to maintain internal calls if needed, or replace usages.

// FlushScheduler extracted to ./engine/FlushScheduler.ts

class KeyedMutex {
    private mutexes = new Map<string, Promise<void>>();

    async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const previous = this.mutexes.get(key) || Promise.resolve();
        let release: () => void;
        const currentTaskComplete = new Promise<void>(resolve => { release = resolve; });
        const chainPromise = previous.then(() => currentTaskComplete);
        this.mutexes.set(key, chainPromise);

        try {
            log.debug(`[KeyedMutex] Waiting for lock on key ${key}`);
            await previous;
            log.debug(`[KeyedMutex] Acquired lock on key ${key}`);
        } catch { /* ignore previous failure */ }

        try {
            return await fn();
        } finally {
            log.debug(`[KeyedMutex] Releasing lock on key ${key}`);
            release!();
            if (this.mutexes.get(key) === chainPromise) {
                this.mutexes.delete(key);
            }
        }
    }
}

export class TaskEngine {
    static testOverrides?: TaskEngineTestOverrides;
    private sessionManager?: SessionManager;
    private snapshotRepo?: SnapshotRepository;
    private taskExecutorInitialized = false;
    private readonly childCompletionInFlight = new Map<string, number>();
    private flushScheduler = new FlushScheduler();
    private taskCreationMutex = new KeyedMutex();
    private handlerInvoker?: DurableHandlerInvoker;
    // Track background task promises for cleanup (especially in tests)
    private readonly backgroundTaskPromises = new Set<Promise<void>>();
    private apiBinder: ApiBinder;
    private turnRunner: TurnRunner;

    constructor(opts?: { sessionStore?: IWorkingMemorySessionStore; handlerInvoker?: DurableHandlerInvoker }) {
        if (opts?.sessionStore) {
            this.sessionManager = new SessionManager(opts.sessionStore);
        } else {
            // Default to in-memory session manager for testing/CLI
            log.warn('No SessionStore configured - using IN-MEMORY mode');
            log.warn('⚠️  IN-MEMORY MODE IS NOT SUITABLE FOR PRODUCTION');
            log.warn('For production, configure a database-backed SessionStore');
            this.sessionManager = new SessionManager(new InMemorySessionManager());
        }
        this.snapshotRepo = new SnapshotRepository(this.sessionManager);

        this.apiBinder = new ApiBinder({
            sessionManager: this.sessionManager,
            snapshotRepo: this.snapshotRepo,
            getTraceContext: () => ({}), // Dummy for now, or fetch from context if generic
            getSessionStorePrisma: () => this.getSessionStorePrisma(),
            taskCreationMutex: this.taskCreationMutex,
            backgroundTaskPromises: this.backgroundTaskPromises,
            handleChildCompleted: (p) => this.handleChildCompleted(p),
            handleToolCompleted: (p) => this.handleToolCompleted(p)
        });

        this.turnRunner = new TurnRunner(
            this.sessionManager!,
            this.apiBinder,
            () => this.getSessionStorePrisma()
        );

        if (opts?.handlerInvoker) {
            this.handlerInvoker = opts.handlerInvoker;
        } else {
            // Default basic invoker using local restoreCtx
            this.handlerInvoker = new DurableHandlerInvokerCore(this.restoreCtx.bind(this));
        }

        // Ensure outbox publisher is running (unless disabled for tests)
        // In test environments, we don't want background services running
        if (!process.env.DISABLE_OUTBOX_PUBLISHER) {
            try { outboxPublisher.start(); } catch { /* noop */ }
        }
    }


    private getSessionStorePrisma() {
        return (this.sessionManager as any)?.store?.prisma;
    }

    // Persist a child's minimal context so durable handlers can restore it later
    public async persistChildContext(params: { tenantId: string; sessionId: string; agentId: string }): Promise<void> {
        if (!this.sessionManager) return;
        const { tenantId, sessionId, agentId } = params;
        const snap = await this.sessionManager.load(tenantId, sessionId);
        const base = (snap?.snapshot as Record<string, unknown>) || {};
        const M = ((base as Record<string, unknown>).M || {}) as MentalState;
        const nextM = { ...M };
        const snapshot = { ...base, M: nextM } as Record<string, unknown>;
        try {
            await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId, expectedWmVersion: BigInt(0), snapshot });
        } catch {
            // best-effort; a later write will win
        }
    }


    // Attach WM and orchestration APIs for child session (flush, requestInput, sendTaskToAgent, etc.)
    public async attachWorkingMemory(ctx: TaskContext, tenantId: string, sessionId: string, agentId: string, loadedMentalState?: MentalState): Promise<void> {
        if (!this.sessionManager) return;

        let M = loadedMentalState;
        if (!M) {
            const snapshot = await this.sessionManager.load(tenantId, sessionId);
            M = (snapshot?.snapshot as Record<string, unknown>)?.M as MentalState | undefined;
            M = (ArtifactHydrationService.hydrateMentalStateArtifacts(
                M as MentalState,
                this.getSessionStorePrisma() || (this.sessionManager as unknown as Record<string, unknown>)?.prisma,
                tenantId,
                'attachWorkingMemory'
            ) as MentalState) || M;
        }

        if (!(ctx as Record<string, unknown>).__ctxId) (ctx as Record<string, unknown>).__ctxId = `ctx-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        if (!(ctx as Record<string, unknown>).tenantId) (ctx as Record<string, unknown>).tenantId = tenantId;
        if (!(ctx as Record<string, unknown>).agentId) (ctx as Record<string, unknown>).agentId = agentId;
        if (M && !(ctx as Record<string, unknown>).__mental) {
            (ctx as Record<string, unknown>).__mental = M;
        }

        await this.apiBinder.attachOrchestrationAPIs(ctx, {
            tenantId,
            sessionId,
            agentId,
            flushMentalState: async () => {
                await this.flushContextSnapshot(tenantId, sessionId, agentId, ctx);
            }
        });
    }

    // Flush current MentalState and LLM state into snapshot (no vars; worldModel/scratch are persisted via M)
    public async flushContextSnapshot(tenantId: string, sessionId: string, agentId: string, ctx: TaskContext): Promise<void> {
        // Use scheduler to debounce/coalesce flushes
        const flushKey = `${tenantId}:${sessionId}`;
        return this.flushScheduler.coalesce(flushKey, async () => {
            await this._doFlushContextSnapshot(tenantId, sessionId, agentId, ctx);
        }, ctx, agentId);
    }

    private async _doFlushContextSnapshot(tenantId: string, sessionId: string, agentId: string, ctx: TaskContext): Promise<void> {
        if (!this.sessionManager) return;
        const baseSnap = ((await this.sessionManager.load(tenantId, sessionId))?.snapshot as Record<string, unknown>) || {};
        let M: MentalState | undefined = (baseSnap as Record<string, unknown>).M as MentalState | undefined;
        const mentalFromCtx = (() => { try { return (ctx as Record<string, unknown>).__mental as MentalState | undefined; } catch { return undefined; } })();
        if (!M && mentalFromCtx) M = mentalFromCtx;
        if (!M) {
            try { const { initialM } = await import('../loop/init.js'); M = initialM(ctx); } catch {
                M = { memory: { sensory: {}, longTerm: { episodic: [], semantic: { concepts: [] }, procedural: { skills: [] } } }, worldModel: {}, goalState: { hierarchy: { nodes: {}, roots: [] } }, emotion: { valence: 0, arousal: 0 }, rewardParams: { extrinsicWeights: [], intrinsic: { curiosity: 0, novelty: 0, competence: 0, exploration: 0 }, discountGamma: 1 }, policyParams: { theta: undefined, stochastic: false } } as MentalState;
            }
        }
        if (!M) return;
        // Attach LLM state
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
            } else {
                log.debug('[TaskEngine] Skipping LLM history save (stateless mode)');
            }
        } catch { /* ignore */ }
        const next = {
            ...(baseSnap as any),
            M,
            ...(attachedLlmState ? { llmState: attachedLlmState } : {}),
            meta: mergeSnapshotMetaWithCtxTelemetry(baseSnap as Record<string, unknown>, ctx),
        } as Record<string, unknown>;
        try {
            const snap = await this.sessionManager.load(tenantId, sessionId);
            const expected = snap?.wmVersion ?? BigInt(0);

            // Offload any LocalArtifacts before saving
            // We need access to prisma for the cache.
            // Using getSessionStorePrisma() helper method if available or casting
            const prisma = this.getSessionStorePrisma() || (this.sessionManager as any).prisma;

            log.debug('DEBUG: Resolving prisma for offloading', {
                hasPrisma: !!prisma,
                hasSessionManager: !!this.sessionManager,
                hasStore: !!(this.sessionManager as any)?.store,
                storeHasPrisma: !!(this.sessionManager as any)?.store?.prisma
            });

            if (prisma) {
                const cache = new AgentResultCache(prisma);
                log.debug('DEBUG: Calling offloadArtifacts');
                // We need to offload artifacts from M and inbox
                // Note: offloadArtifacts modifies the object in place for arrays/objects
                // We are working on 'next' which is a copy of baseSnap + M, so mutation is safe for 'next',
                // but M might be shared. However, offloadArtifacts only replaces LocalArtifacts,
                // and next.M is the one being saved.
                await offloadArtifacts(next, cache, tenantId);
            } else {
                log.warn('DEBUG: Skipping offloadArtifacts - No Prisma');
            }

            await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || agentId, expectedWmVersion: expected, snapshot: next });
        } catch (e) {
            if ((e as Error).message === 'LIMIT_WM_SNAPSHOT_TOO_LARGE') {
                try {
                    const prunedNext = pruneSnapshot(next);
                    const snap3 = await this.sessionManager.load(tenantId, sessionId);
                    const expected3 = snap3?.wmVersion ?? BigInt(0);
                    await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || 'default', expectedWmVersion: expected3, snapshot: prunedNext });
                } catch (err) {
                    log.error('Failed to save snapshot even after pruning', { error: err });
                    throw e;
                }
            } else if ((e as Error).message === 'CAS_MISMATCH') {
                try {
                    const snap2 = await this.sessionManager.load(tenantId, sessionId);
                    const expected2 = snap2?.wmVersion ?? BigInt(0);
                    const base2 = ((await this.sessionManager.load(tenantId, sessionId))?.snapshot as Record<string, unknown>) || {};
                    const next2 = {
                        ...base2,
                        M,
                        meta: mergeSnapshotMetaWithCtxTelemetry(base2, ctx),
                    } as Record<string, unknown>;
                    await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || agentId, expectedWmVersion: expected2, snapshot: next2 });
                } catch { /* ignore */ }
            } else {
                throw e;
            }
        }
    }

    /** Compact output for root agent traces (avoid huge payloads). */
    private buildAgentTelemetryOutput(task: TaskEntity): Record<string, unknown> {
        const status = task.status;
        const state = status?.state;
        const terminalStates = new Set(['completed', 'failed', 'canceled', 'input-required']);
        return {
            state,
            timestamp: status?.timestamp,
            artifactsCount: Array.isArray(task.artifacts) ? task.artifacts.length : 0,
            taskId: task.id,
            terminal: typeof state === 'string' && terminalStates.has(state),
            outcome:
                state === 'completed'
                    ? 'success'
                    : state === 'failed'
                      ? 'failure'
                      : state === 'input-required'
                        ? 'await_input'
                        : state ?? 'unknown',
        };
    }

    private taskFailureMessage(task: TaskEntity): string {
        const st = task.status;
        if (!st || st.state !== 'failed') return 'Task failed';
        const msg = (st as { message?: { parts?: Array<{ type?: string; text?: string }> } }).message;
        if (msg?.parts && Array.isArray(msg.parts)) {
            const text = msg.parts
                .filter((p) => p.type === 'text' && typeof p.text === 'string')
                .map((p) => p.text!)
                .join(' ');
            return text || 'Task failed';
        }
        return 'Task failed';
    }

    /**
     * Close the execution AgentNode for Opik and other providers.
     * Applies to TaskEngine-created nodes and reused nodes from A2AService (loop subagents).
     */
    private finalizeAgentNodeTelemetry(
        agentNode: AgentNode | undefined,
        task: TaskEntity,
        thrown?: Error
    ): void {
        if (!agentNode || agentNode.endTime != null) return;
        try {
            const state = task.status?.state;
            const output = this.buildAgentTelemetryOutput(task);

            if (state === 'failed' || thrown) {
                const err = thrown ?? new Error(this.taskFailureMessage(task));
                agentNode.fail(err);
                telemetry.failNode(agentNode, err);
                telemetry.endNode(agentNode);
                return;
            }

            const nodeStatus: NodeStatus = 'success';
            agentNode.end(output, nodeStatus);
            telemetry.endNode(agentNode);
        } catch {
            /* ignore telemetry errors */
        }
    }

    /**
     * Start a task with either streaming or buffered mode
     * @returns The final task entity for buffered mode, or void for streaming mode
     */
    async startTask(params: StartTaskParams): Promise<TaskEntity | void> {
        const { task, isStreaming, agentId, tenantId: startTenantId, initialContext, parentTelemetryNodeId, skipTelemetryNodeCreation } = params;

        // Automatic Telemetry: specific Agent Node for this task execution
        let agentNode: AgentNode | undefined;
        try {
            const parentNode = parentTelemetryNodeId ? telemetry.getNode(parentTelemetryNodeId) : undefined;
            if (skipTelemetryNodeCreation && parentNode instanceof AgentNode && parentNode.agentName === (agentId || 'default') && !parentNode.endTime) {
                agentNode = parentNode;
            } else {
                const traceId = parentNode?.traceId || uuidv7();
                const nodeId = uuidv7();
                agentNode = new AgentNode(agentId || 'default', nodeId, parentTelemetryNodeId, traceId);
                const inputPayload = (typeof task.input === 'object' && task.input !== null)
                    ? { ...task.input, originalTaskId: task.id }
                    : { value: task.input, originalTaskId: task.id };
                agentNode.start(inputPayload);
                telemetry.registerNode(agentNode);
            }
        } catch { /* ignore telemetry errors to prevent blockers */ }

        // Use provided context if present, otherwise create a basic one
        const ctx = initialContext ?? this.createContext(task);

        // Inject telemetry context
        if (agentNode) {
            if (!ctx.telemetry) ctx.telemetry = {};
            ctx.telemetry.nodeId = agentNode.id;
            ctx.telemetry.traceId = agentNode.traceId;
        }

        // Preserve A2A requestInput override if provided on initialContext
        try {
            if ((initialContext as any)?.__preserveRequestInput && (initialContext as any).requestInput) {
                (ctx as any).requestInput = (initialContext as any).requestInput;
            }
        } catch { }
        // Safety: warn if semantic registry looks uninitialized
        try {
            const def = (ctx as any).memory?.semantic?.getDefaultBackend?.();
            if (def === 'none') {
                (ctx as any).logger?.warn?.('TaskEngine.startTask: semantic registry appears uninitialized (default=none)');
            }
        } catch { }
        // Attach agentId/tenantId to context for downstream persistence/restore
        if (agentId) {
            (ctx as any).agentId = agentId;
        }
        if (startTenantId) {
            (ctx as any).tenantId = startTenantId;
        }

        // Attach LLM adapter for this agent if configured
        try {
            const agentNameForStart = ((ctx as any).agentId || agentId) as string | undefined;
            if (agentNameForStart) {
                const { PluginManager } = await import('../plugin/pluginManager.js');
                const pluginForStart = PluginManager.findAgent(agentNameForStart);
                if (pluginForStart?.llmAdapter) {
                    (ctx as any).llm = pluginForStart.llmAdapter;
                } else if (pluginForStart?.llmConfig) {
                    const { createLLMForTask } = await import('../llm/LLMFactory.js');
                    (ctx as any).llm = createLLMForTask(pluginForStart.llmConfig, ctx as any);
                }
            }
        } catch { /* ignore LLM attach errors */ }

        // Choose execution path: loop-first (default) or durable handler
        // Check manifest for runMode, then ctx, then default to 'loop'
        const activeAgentId = (ctx as Record<string, unknown>).agentId as string | undefined || agentId;
        const plugin = activeAgentId ? PluginManager.findAgent(activeAgentId) : null;
        const manifestRunMode = plugin?.resolved.runtimeManifest.runMode;
        const runModeRaw = (ctx as Record<string, unknown>).runMode ?? manifestRunMode ?? 'loop';
        const runMode: 'loop' | 'legacy' = runModeRaw === 'legacy' ? 'legacy' : 'loop';
        try { log.debug('Task execution start', { runMode, agentId: activeAgentId }); } catch { }
        if (process.env.DEBUG_BACKGROUND_TASKS) {
            console.log('[TaskEngine.startTask] About to execute, runMode=', runMode, 'isStreaming=', isStreaming);
        }

        const tenantId = ((ctx as Record<string, unknown>).tenantId || startTenantId || 'default') as string;
        const sessionId = task.id as string;
        if (agentNode) {
            Object.assign(agentNode.providerData, {
                sessionId,
                tenantId,
                rootTaskId: task.id,
                threadId: agentNode.traceId,
            });
        }
        const traceparent = createTraceparent();

        // Compute manifest provenance (fail-fast on identity mismatch when plugin has both manifests)
        let manifestProvenance: ManifestProvenance;
        if (plugin?.resolved) {
            try {
                manifestProvenance = resolveManifestProvenance({
                    agentCard: { source: plugin.resolved.agentCardSource as ManifestSource, content: plugin.resolved.agentCard },
                    runtimeManifest: { source: plugin.resolved.runtimeManifestSource as ManifestSource, content: plugin.resolved.runtimeManifest }
                });
            } catch (err) {
                throw new Error(`Manifest provenance failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        } else {
            manifestProvenance = { agentCardSource: 'inline', runtimeManifestSource: 'inline', agentCardHash: '', runtimeManifestHash: '' };
        }
        (ctx as InternalTaskContext).__manifestProvenance = manifestProvenance;

        try {
            // Load session-scoped snapshot if available (tenantId/sessionId assumed on ctx for now)
            const session = await this.sessionManager?.load(tenantId, sessionId) ?? null;


            const baseSnap = (session?.snapshot as Record<string, unknown>) || {};
            // Restore manifest provenance from snapshot if present (resume path)
            const meta = baseSnap.meta as { manifestProvenance?: ManifestProvenance } | undefined;
            if (meta?.manifestProvenance) {
                (ctx as InternalTaskContext).__manifestProvenance = meta.manifestProvenance;
            } else {
                // Persist provenance into snapshot meta so it is saved and available on resume
                const metaObj = (baseSnap.meta as Record<string, unknown>) || {};
                metaObj.manifestProvenance = manifestProvenance;
                baseSnap.meta = metaObj;
            }
            let M: MentalState = (baseSnap as Record<string, unknown>).M as MentalState || initialM(ctx);

            // Hydrate any persisted Artifact markers inside the mental state / vars
            const mentalHydrationPrisma = this.getSessionStorePrisma() || (this.sessionManager as any)?.prisma;
            M = (ArtifactHydrationService.hydrateMentalStateArtifacts(M, mentalHydrationPrisma, tenantId, 'startTask') as MentalState) || M;
            // Ensure session agentId is correctly set for this task upfront
            try {
                const declaredAgentId = ((ctx as any).agentId || activeAgentId || 'default') as string;
                const currentAgentId = (session as any)?.agentId as string | undefined;
                if (this.sessionManager && declaredAgentId && (!currentAgentId || currentAgentId === 'default')) {
                    await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: declaredAgentId, expectedWmVersion: session?.wmVersion ?? BigInt(0), snapshot: baseSnap });
                }
            } catch { /* best-effort */ }
            // Expose MentalState on context for in-turn cognitive operations (e.g., goals API)
            (ctx as Record<string, unknown>).__mental = M;
            (ctx as Record<string, unknown>).__wmVersion = session?.wmVersion;

            // Seed loop budget limits if provided in params.options
            if (params.options) {
                (ctx as any).options = { ...(ctx as any).options, ...params.options };

                try {
                    if (typeof params.options.maxTurns === 'number') {
                        // Update base snapshot meta immediately so it persists
                        const meta = (baseSnap as any).meta || {};
                        const budgets = meta.budgets || {};
                        budgets.maxTurns = params.options.maxTurns;
                        meta.budgets = budgets;
                        (baseSnap as any).meta = meta;

                        // Also seed initial mental state meta if needed
                        const mMeta = (M as any).meta || {};
                        const mBudgets = mMeta.budgets || {};
                        mBudgets.maxTurns = params.options.maxTurns;
                        mMeta.budgets = mBudgets;
                        (M as any).meta = mMeta;
                    }
                } catch (err) {
                    try { (ctx as any).logger?.warn?.('TaskEngine.startTask: Failed to inject options.maxTurns', { error: err }); } catch { }
                }
            }


            let cachedLlmState: unknown = undefined;
            const prepareLlmState = () => {
                try {
                    const llmAny = (ctx as any).llm as any;
                    const historyMode = (typeof llmAny?.getHistoryMode === 'function') ? llmAny.getHistoryMode() : 'full';

                    if (historyMode !== 'stateless') {
                        if (llmAny?.getMessages) {
                            const messages = llmAny.getMessages(true);
                            cachedLlmState = { messages } as unknown;
                        } else if (llmAny?.exportState) {
                            cachedLlmState = llmAny.exportState();
                        }
                    }
                } catch { /* ignore */ }
            };
            const flushMentalState = async () => {
                if (!this.snapshotRepo) return;
                // Capture dependencies for mutate function
                const prisma = this.getSessionStorePrisma() || (this.sessionManager as any).prisma;

                const parentTelemetryId = ctx.telemetry?.nodeId ?? agentNode?.id;
                const traceForPersist = ctx.telemetry?.traceId ?? agentNode?.traceId;
                let persistNode: WorkflowNode | undefined;
                if (parentTelemetryId) {
                    persistNode = new WorkflowNode('state.persist', parentTelemetryId, undefined, traceForPersist);
                    persistNode.start({
                        tenantId,
                        sessionId,
                        agentId: (ctx as Record<string, unknown>).agentId as string | undefined,
                    });
                    telemetry.registerNode(persistNode);
                }

                const mutateFn = async (baseSnap: Record<string, unknown>) => {
                    prepareLlmState();
                    const next = {
                        ...baseSnap,
                        M,
                        ...(cachedLlmState ? { llmState: cachedLlmState } : {}),
                        meta: mergeSnapshotMetaWithCtxTelemetry(baseSnap, ctx),
                    } as Record<string, unknown>;

                    if (prisma) {
                        const cache = new AgentResultCache(prisma);
                        await offloadArtifacts(next, cache, tenantId);
                    }
                    return next;
                };

                try {
                    try {
                        await this.snapshotRepo.saveWithRetry({
                            tenantId,
                            sessionId,
                            agentId: typeof (ctx as Record<string, unknown>).agentId === 'string' ? (ctx as Record<string, unknown>).agentId as string : 'default',
                            mutate: mutateFn
                        });
                    } catch (e) {
                        if ((e as Error).message === 'LIMIT_WM_SNAPSHOT_TOO_LARGE') {
                            const prunedM = pruneSnapshot(M);
                            M = prunedM;
                            await this.snapshotRepo.saveWithRetry({
                                tenantId,
                                sessionId: sessionId,
                                agentId: typeof (ctx as Record<string, unknown>).agentId === 'string' ? (ctx as Record<string, unknown>).agentId as string : 'default',
                                mutate: async (baseSnap) => {
                                    const next = {
                                        ...baseSnap,
                                        M,
                                        meta: mergeSnapshotMetaWithCtxTelemetry(baseSnap, ctx),
                                    };
                                    if (prisma) {
                                        const cache = new AgentResultCache(prisma);
                                        await offloadArtifacts(next, cache, tenantId);
                                    }
                                    return next;
                                }
                            });
                        } else {
                            throw e;
                        }
                    }
                    if (persistNode) {
                        persistNode.end({ ok: true }, 'success');
                        telemetry.endNode(persistNode);
                    }
                    if (parentTelemetryId) {
                        const concepts = M?.memory?.longTerm?.semantic?.concepts;
                        const semanticConceptCount = Array.isArray(concepts) ? concepts.length : 0;
                        const vars = (M as Record<string, unknown>).vars as
                            | Record<string, unknown>
                            | undefined;
                        const hasSelectorsInVars = vars != null && vars.selectors != null;
                        const memSaveNode = new WorkflowNode(
                            'memory.save_selectors',
                            parentTelemetryId,
                            undefined,
                            traceForPersist
                        );
                        memSaveNode.start({
                            tenantId,
                            sessionId,
                            surface: 'working_memory_snapshot',
                            semanticConceptCount,
                            hasSelectorsInVars,
                        });
                        telemetry.registerNode(memSaveNode);
                        memSaveNode.end({ ok: true, persisted: true }, 'success');
                        telemetry.endNode(memSaveNode);
                    }
                } catch (e) {
                    if (persistNode) {
                        const er = e instanceof Error ? e : new Error(String(e));
                        persistNode.fail(er);
                        telemetry.failNode(persistNode, er);
                        telemetry.endNode(persistNode);
                    }
                    throw e;
                }
            };

            // Legacy VarsSync.createVarsProxy and assignVarsIntoMental removed.


            await this.apiBinder.attachOrchestrationAPIs(ctx, {
                tenantId,
                sessionId,
                agentId: (ctx as any).agentId || 'default',
                flushMentalState
            });

            // Append start event and publish status via outbox; reducer entrypoint
            await this.sessionManager?.appendEvent(tenantId as string, sessionId as string, 'task.started', { taskId: sessionId, traceparent });
            await this.sessionManager?.enqueueOutbox(tenantId as string, 'task.status', sessionId as string, { taskId: sessionId, status: { state: 'working', timestamp: new Date().toISOString() }, traceparent });
            // Emit initial working status locally too so CLI can see the taskId
            try {
                eventBus.publish(taskChannel(sessionId), {
                    id: sessionId,
                    status: { state: 'working', timestamp: new Date().toISOString(), message: { role: 'agent', parts: [{ type: 'text', text: `Task started: ${sessionId}` }] } },
                    final: false
                } as any);
            } catch { }
            const initialWm = (session?.snapshot as Record<string, unknown>) || {};
            const { wm: wmAfterStart } = decide(initialWm, { t: 'task.started' });

            // Extend the context with streaming capabilities
            extendContextWithStreaming(ctx, isStreaming);
            // carry runMode from agent manifest via streaming runner if present; default loop
            // FIX: Don't prematurely default to 'loop' here, wait until we check the manifest
            // if (!(ctx as any).runMode) { (ctx as any).runMode = 'loop'; }


            // Set initial status
            const initialStatus: TaskStatus = {
                state: 'submitted',
                timestamp: new Date().toISOString()
            };

            // Update status to 'working'
            ctx.progress({
                state: 'working',
                timestamp: new Date().toISOString()
            });

            // Choose execution path: loop-first (default) or durable handler
            // Check manifest for runMode, then ctx, then default to 'loop'
            const agentId = (ctx as any).agentId;
            const plugin = agentId ? PluginManager.findAgent(agentId) : null;
            const manifestRunMode = plugin?.resolved.runtimeManifest.runMode;
            const runMode: 'loop' | 'legacy' = (ctx as any).runMode || manifestRunMode || 'loop';
            try { log.debug('Task execution start', { runMode, agentId: (ctx as any).agentId }); } catch { }
            if (process.env.DEBUG_BACKGROUND_TASKS) {
                console.log('[TaskEngine.startTask] About to execute, runMode=', runMode, 'isStreaming=', isStreaming);
            }

            const runLegacy = async () => {
                if (isStreaming) {
                    this.executeTaskHandler(ctx).catch(error => {
                        log.error('Task handler error', { error: error instanceof Error ? error.message : String(error) });
                        ctx.fail({
                            state: 'failed',
                            message: { role: 'agent', parts: [{ type: 'text', text: `Task execution failed: ${error instanceof Error ? error.message : String(error)}` }] },
                            timestamp: new Date().toISOString()
                        } as any);
                    });
                    return;
                }
                await this.executeTaskHandler(ctx);
            };

            if (runMode === 'legacy') {
                await runLegacy();
            } else {
                const taskResult = await this.turnRunner.runTurn(ctx, {
                    tenantId,
                    sessionId,
                    trigger: 'start',
                    isStreaming,
                    input: task.input
                }, {
                    initialM: M,
                    snapshot: baseSnap
                });

                if (taskResult) {
                    task.status = taskResult.status;
                    task.artifacts = taskResult.artifacts;
                    task.input = taskResult.input;
                }

                if (task.status?.state === 'completed') {
                    await this.sessionManager?.appendEvent(tenantId as string, sessionId as string, 'task.completed', {
                        taskId: sessionId,
                        artifactsCount: Array.isArray(task.artifacts) ? task.artifacts.length : 0,
                        traceparent
                    });
                    await this.sessionManager?.enqueueOutbox(tenantId as string, 'task.status', sessionId as string, {
                        taskId: sessionId,
                        status: { state: 'completed', timestamp: new Date().toISOString() },
                        final: true,
                        traceparent
                    });
                }

                this.finalizeAgentNodeTelemetry(agentNode, task);

                if (isStreaming) {
                    // Even in streaming mode, we return the task entity so the caller has the ID and handle.
                    // The runTurn call above is awaited, so we have initial state.
                }
                return task;
            }

            // After handler: flush MentalState once (skip if already flushed earlier in this turn)
            if (this.sessionManager && !(ctx as any).__wmSavedThisTurn) {
                try { await flushMentalState(); } catch (e) {
                    if ((e as Error).message === 'LIMIT_WM_SNAPSHOT_TOO_LARGE') {
                        await this.sessionManager!.appendEvent(tenantId as string, sessionId as string, 'wm.snapshot_limit', { size: 'unknown' });
                    } else { throw e; }
                }
            }

            // Get the buffered results from the context
            const results = (ctx as any).getBufferedResults();

            // Update the task entity with the results
            task.status = results.status || {
                state: 'completed',
                timestamp: new Date().toISOString()
            };
            task.artifacts = results.artifacts;

            // If this turn requested input, do NOT mark completed; just return current status
            if (task.status?.state === 'input-required' || (ctx as any).__wmSavedThisTurn) {
                this.finalizeAgentNodeTelemetry(agentNode, task);
                return task;
            }

            // Append completed event and publish status via outbox
            await this.sessionManager?.appendEvent(tenantId as string, sessionId as string, 'task.completed', {
                taskId: sessionId,
                artifactsCount: Array.isArray(task.artifacts) ? task.artifacts.length : 0,
                traceparent
            });
            await this.sessionManager?.enqueueOutbox(tenantId as string, 'task.status', sessionId as string, {
                taskId: sessionId,
                status: { state: 'completed', timestamp: new Date().toISOString() },
                final: true,
                traceparent
            });

            this.finalizeAgentNodeTelemetry(agentNode, task);
            return task;
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            log.error('Task engine error', { error: err.message });

            // Set failure status for non-streaming mode
            if (!isStreaming) {
                task.status = {
                    state: 'failed',
                    message: {
                        role: 'agent',
                        parts: [
                            { type: 'text', text: `Task execution failed: ${err.message}` }
                        ]
                    },
                    timestamp: new Date().toISOString()
                };
                this.finalizeAgentNodeTelemetry(agentNode, task, err);
                return task;
            }

            // Append failed event and publish status via outbox
            await this.sessionManager?.appendEvent(tenantId as string, sessionId as string, 'task.failed', {
                taskId: sessionId,
                error: err.message,
                traceparent
            });
            await this.sessionManager?.enqueueOutbox(tenantId as string, 'task.status', sessionId as string, {
                taskId: sessionId,
                status: {
                    state: 'failed',
                    message: { role: 'agent', parts: [{ type: 'text', text: err.message }] },
                    timestamp: new Date().toISOString()
                },
                final: true,
                traceparent
            });

            // For streaming, emit a failure event directly
            task.status = {
                state: 'failed',
                message: {
                    role: 'agent',
                    parts: [{ type: 'text', text: err.message }]
                },
                timestamp: new Date().toISOString()
            };
            this.finalizeAgentNodeTelemetry(agentNode, task, err);
            eventBus.publish(taskChannel(task.id), {
                id: task.id,
                status: {
                    state: 'failed',
                    message: {
                        role: 'agent',
                        parts: [
                            { type: 'text', text: `Task execution failed: ${err.message}` }
                        ]
                    },
                    timestamp: new Date().toISOString()
                },
                final: true
            });
        }
    }

    /**
     * Resume a task on input (scaffold): append input event and publish status via outbox.
     * Real handler dispatch will be added with durable handler registry.
     */
    async resumeInput(params: { tenantId: string; taskId: string; token: string; input: unknown }): Promise<{ acknowledged: true }> {
        log.debug('Resume input processing started');
        const { tenantId, taskId, token, input } = params;
        // load snapshot
        const snap = await this.sessionManager?.load(tenantId, taskId);
        if (!snap) {
            throwInvariantError(
                'SESSION_NOT_FOUND',
                `Session ${taskId} not found`,
                { type: 'session_config', reason: 'session_not_found', taskId }
            );
        }

        const base = (snap.snapshot as Record<string, unknown>) || {};
        // Validate token existence/expiry
        try {
            const pend = getPendingInputs(base) as any;
            const entry = pend[token];
            if (!entry) {
                throwInvariantError(
                    'INPUT_TOKEN_NOT_FOUND',
                    `Input token ${token} not found for session ${taskId}`,
                    { type: 'token_validation', category: 'input', token, reason: 'missing', pendingSnapshot: pend }
                );
            }
            if (entry.expiresAt && Date.parse(entry.expiresAt) < Date.now()) {
                throwInvariantError(
                    'INPUT_TOKEN_EXPIRED',
                    `Input token ${token} expired for session ${taskId}`,
                    { type: 'token_validation', category: 'input', token, reason: 'expired', pendingSnapshot: pend }
                );
            }

        } catch (e) {
            throw e instanceof Error ? e : new Error('INPUT_TOKEN_INVALID');
        }
        const { next } = applyInputProvided(base, token, input);
        // Hydrate input if it contains artifacts (e.g. from resumeInput)
        if (input && typeof input === 'object') {
            const prisma = this.getSessionStorePrisma();
            if (prisma) {
                const cache = new AgentResultCache(prisma);
                hydrateArtifacts(input, cache, tenantId);
            }
        }
        const expected = snap?.wmVersion ?? BigInt(0);
        await this.sessionManager?.appendEvent(tenantId, taskId, 'task.input_provided', { token });
        await this.sessionManager?.saveSnapshot({ tenantId, sessionId: taskId, agentId: (next as any).meta?.agentId || 'default', expectedWmVersion: expected, snapshot: next });
        await this.sessionManager?.enqueueOutbox(tenantId, 'task.status', taskId, { taskId, status: { state: 'working', timestamp: new Date().toISOString() }, metadata: { inputProvided: true } });
        // Always auto-resume one loop turn to consume the provided input
        try {
            const agentName = (snap as any)?.agentId;
            const plugin = agentName ? PluginManager.findAgent(agentName) : null;
            // Build context for this resume turn; use provided input as the current turn input
            const ctx = this.createContext({ id: taskId, input: input as any });
            (ctx as any).tenantId = tenantId;
            if (agentName) (ctx as any).agentId = agentName;
            // Ensure replies in this resumed turn are streamed to chat
            try { extendContextWithStreaming(ctx, true); } catch { /* noop */ }

            // Attach requestInput implementation (same as in startTask) so agent can ask for more input
            const sessionId = taskId;
            if ((ctx as any).__a2aParent || (ctx as any).__preserveRequestInput) {
                // Keep existing A2A override
                try { (ctx as any).logger?.debug?.('TaskEngine.resumeInput: preserving A2A requestInput override'); } catch { }
            } else {
                (ctx as any).requestInput = async (promptOrParts: string | string[] | import('../shared/types/index.js').MessagePart | import('../shared/types/index.js').MessagePart[], opts?: { ttlMs?: number; schema?: unknown; onProvided?: string; onExpired?: string; __existingToken?: string; setToken?: boolean; setStage?: string }) => {
                    if (!this.sessionManager) throw new Error('Session manager not configured');
                    // Limits: cap max outstanding prompts
                    const maxPrompts = 100;
                    const snapL = await this.sessionManager.load(tenantId, sessionId);
                    const baseL = (snapL?.snapshot as Record<string, unknown>) || {};
                    const pendingNow = getPendingInputs(baseL);
                    if (Object.keys(pendingNow).length >= maxPrompts) {
                        throwInvariantError(
                            'LIMIT_MAX_PROMPTS_EXCEEDED',
                            `Maximum outstanding prompts reached (${maxPrompts})`,
                            { type: 'session_config', reason: 'limit_max_prompts_exceeded', limit: maxPrompts, actual: Object.keys(pendingNow).length }
                        );
                    }

                    const snap = await this.sessionManager.load(tenantId, sessionId);
                    const base = (snap?.snapshot as Record<string, unknown>) || {};
                    const token = opts?.__existingToken || uuidv7();
                    const expiresAt = opts?.ttlMs ? new Date(Date.now() + opts.ttlMs).toISOString() : undefined;
                    const pending = { ...getPendingInputs(base) };

                    // Normalize promptOrParts into parts[] and derive a fallback prompt string
                    const normalizeParts = (p: string | string[] | import('../shared/types/index.js').MessagePart | import('../shared/types/index.js').MessagePart[]): import('../shared/types/index.js').MessagePart[] => {
                        if (typeof p === 'string') return [{ type: 'text', text: p, format: 'markdown' } as any];
                        if (Array.isArray(p) && p.length > 0 && typeof p[0] === 'string') return (p as string[]).map(t => ({ type: 'text', text: t, format: 'markdown' } as any));
                        if (Array.isArray(p)) return (p as any[]).map(part => (part?.type === 'text' && !part?.format ? { ...part, format: 'markdown' } : part));
                        const one = p as any;
                        return [one?.type === 'text' && !one?.format ? { ...one, format: 'markdown' } : one];
                    };
                    const parts = normalizeParts(promptOrParts);
                    const prompt = (parts.find((x: any) => x?.type === 'text') as any)?.text as string | undefined;

                    // Only add to pending if it's a new token request
                    if (!opts?.__existingToken) {
                        pending[token] = {
                            schema: opts?.schema,
                            expiresAt,
                            handlerName: opts?.onProvided,
                            expiredHandlerName: opts?.onExpired
                        } as any;
                    }
                    // Helper to flush M and save snapshot
                    const flushMentalState = async () => {
                        try {
                            const snap = await this.sessionManager!.load(tenantId, sessionId);
                            const M = (snap?.snapshot as any)?.M;
                            if (M) {
                                const llmAny = (ctx as any).llm as any;
                                const llmStateFromSnap = (snap?.snapshot as any)?.llmState;
                                if (typeof llmStateFromSnap === 'undefined' && llmAny?.exportState) {
                                    return llmAny.exportState();
                                }
                            }
                        } catch { /* noop */ }
                        return undefined;
                    };
                    const controlUpdates: Array<[string, unknown]> = [];
                    const writeOnce = async (baseSnap: Record<string, unknown>, expectedVer: bigint) => {
                        let exportedLlm: unknown = undefined;
                        try { exportedLlm = await flushMentalState(); } catch { /* best-effort */ }
                        const latest = await this.sessionManager!.load(tenantId, sessionId);
                        const latestBase = (latest?.snapshot as Record<string, unknown>) || baseSnap;
                        let nextSnapshot = setPendingInputs(latestBase, pending);
                        if (exportedLlm) {
                            nextSnapshot.llmState = exportedLlm;
                        }
                        if (controlUpdates.length > 0) {
                            for (const [path, value] of controlUpdates) {
                                nextSnapshot = TaskStateUtils.applyControlVarToSnapshot(nextSnapshot, path, value);
                            }
                        }
                        const expectedNext = latest?.wmVersion ?? expectedVer;
                        await this.sessionManager!.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || 'default', expectedWmVersion: expectedNext, snapshot: nextSnapshot });
                        await this.sessionManager!.appendEvent(tenantId, sessionId, 'task.input_required', { token, prompt, parts, schema: opts?.schema, expiresAt });
                        await this.sessionManager!.enqueueOutbox(tenantId, 'task.input_required', sessionId, { taskId: sessionId, prompt, parts, token, schema: opts?.schema, expiresAt });
                    };
                    try {
                        const expected = snap?.wmVersion ?? BigInt(0);
                        await writeOnce(base, expected);
                    } catch (e) {
                        if ((e as Error).message === 'CAS_MISMATCH') {
                            try {
                                const snap2 = await this.sessionManager.load(tenantId, sessionId);
                                const base2 = (snap2?.snapshot as Record<string, unknown>) || {};
                                const pending2 = { ...getPendingInputs(base2), [token]: { schema: opts?.schema, expiresAt } } as any;
                                const expected2 = snap2?.wmVersion ?? BigInt(0);
                                let next2 = setPendingInputs(base2, pending2);
                                if (controlUpdates.length > 0) {
                                    for (const [path, value] of controlUpdates) {
                                        next2 = TaskStateUtils.applyControlVarToSnapshot(next2, path, value);
                                    }
                                }
                                await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || 'default', expectedWmVersion: expected2, snapshot: next2 });
                                await this.sessionManager.appendEvent(tenantId, sessionId, 'task.input_required', { token, prompt, parts, schema: opts?.schema, expiresAt });
                                await this.sessionManager.enqueueOutbox(tenantId, 'task.input_required', sessionId, { taskId: sessionId, prompt, parts, token, schema: opts?.schema, expiresAt });
                            } catch { /* swallow second failure */ }
                        } else {
                            throw e;
                        }
                    }
                    try { (ctx as any).logger?.info?.('requestInput: input_required emitted', { token, prompt, expiresAt }); } catch { }
                    // Emit prompt parts as a reply so chat UIs can render markup/buttons/etc.
                    try { await ctx.reply(parts as any); } catch { /* best-effort */ }
                    try {
                        ctx.progress({
                            state: 'input-required',
                            message: {
                                role: 'agent',
                                parts
                            },
                            timestamp: new Date().toISOString(),
                            metadata: { token }
                        } as any);
                    } catch { /* noop */ }
                    // Automatic token management (default: true)
                    if (opts?.setToken !== false) {
                        controlUpdates.push(['token', token]);
                        writeControlVar(ctx, 'token', token);
                    }

                    // Automatic stage management
                    if (opts?.setStage) {
                        try {
                            controlUpdates.push(['stage', opts.setStage]);
                            writeControlVar(ctx, 'stage', opts.setStage);
                        } catch (error) {
                            (ctx as any).logger?.warn?.('Failed to auto-set stage', { stage: opts.setStage, error });
                        }
                    }

                    (ctx as any).__wmSavedThisTurn = true;
                    const handle = new InputHandle(this.sessionManager, tenantId, sessionId, token);
                    return handle;
                };
            }
            // Load MentalState and pending for EnvironmentState
            const baseNow = (await this.sessionManager!.load(tenantId, taskId))?.snapshot as Record<string, unknown> || {};
            let M: MentalState = (baseNow as any).M as MentalState || initialM(ctx);
            M = (ArtifactHydrationService.hydrateMentalStateArtifacts(
                M,
                this.getSessionStorePrisma() || (this.sessionManager as any)?.prisma,
                tenantId,
                'requestInput.autoResume'
            ) as MentalState) || M;
            // Attach and restore LLM before running loop
            await this.attachAndRestoreLLM(ctx, agentName, M);
            const baseMeta = (baseNow as Record<string, unknown>)?.meta as Record<string, unknown> | undefined;
            const startTurnTotal = Number(baseMeta?.turn ?? 0) || 0;
            // Resolve runMode for resume
            const manifestRunMode = plugin?.resolved.runtimeManifest.runMode;
            const rawRunMode = (ctx as Record<string, unknown>).runMode;
            const runMode: 'loop' | 'legacy' = (rawRunMode === 'legacy' || rawRunMode === 'loop') ? rawRunMode : (manifestRunMode ?? 'loop');

            if (runMode === 'legacy') {
                await this.executeTaskHandler(ctx);
            } else {
                const taskResult = await this.turnRunner.runTurn(ctx, {
                    tenantId,
                    sessionId: taskId,
                    trigger: 'resume',
                    isStreaming: false,
                    input: { token } // Reflect input token in result if needed
                }, {
                    initialM: M,
                    snapshot: baseNow
                });

                const channel = taskChannel(taskId);
                try {
                    if (taskResult.status) {
                        eventBus.publish(channel, {
                            id: taskId,
                            status: taskResult.status,
                            final: taskResult.status.state === 'completed' || taskResult.status.state === 'failed'
                        } as any);
                    }
                } catch { }
            }
        } catch (e) {
            try { console.error('[TaskEngine] resumeInput auto-resume failed:', e instanceof Error ? e.message : String(e), e instanceof Error ? e.stack : ''); } catch { }
        }
        return { acknowledged: true };
    }

    /**
     * Handle tool completion (placeholder): removes pending tool token and invokes durable handler if present.
     */
    async handleToolCompleted(params: { tenantId: string; taskId: string; token: string; result: unknown }): Promise<void> {
        const { tenantId, taskId, token, result } = params;
        const snap = await this.sessionManager?.load(tenantId, taskId);
        if (!snap) return;
        const base = (snap.snapshot as Record<string, unknown>) || {};
        const tools = getPendingTools(base) as any;
        const entry = tools[token];
        if (!entry) return;
        delete tools[token];
        const next = setPendingTools(base, tools) as Record<string, unknown>;
        const toolObservation: EngineObservation = {
            source: 'tool',
            kind: 'tool.completed',
            payload: { token, result, tool: entry?.name },
            provenance: {
                ts: Date.now(),
                turn: Number((base as any)?.meta?.turn ?? 0) + 1,
                id: token,
                toolId: entry?.name,
                correlationId: token
            }
        };
        (next as any).inbox = InboxManager.addObservationToInbox((next as any).inbox, toolObservation);
        const saveResult = await this.sessionManager?.saveSnapshot({ tenantId, sessionId: taskId, agentId: (base as any)?.meta?.agentId || 'default', expectedWmVersion: snap.wmVersion ?? BigInt(0), snapshot: next });
        await this.sessionManager?.appendEvent(tenantId, taskId, 'task.tool_completed', { token });

        // Check if there's an active loop
        const activeCtx = LoopRegistry.__activeLoopContexts?.get(taskId);

        // ✅ FIX: If the original runLoop is still active, inject the tool result
        // into its inbox and let the loop's await_tool→continue logic handle it.
        // Do NOT start a redundant runTurn which creates a fresh context lacking
        // the original streaming transport, leading to process hangs.
        if (activeCtx) {
            log.debug('handleToolCompleted: Active loop exists, injecting into inbox only', { taskId, token });
            try {
                const activeInbox = (activeCtx as any).__activeLoopInbox;
                if (activeInbox) {
                    activeInbox.current.push(toolObservation);
                    activeInbox.all.push(toolObservation);
                }
            } catch { /* best-effort */ }
            return;
        }

        // No active loop — auto-resume one loop turn to consume the tool result
        try {
            const agentName = (snap as any)?.agentId;
            const ctx = this.createContext({ id: taskId, input: {} });
            (ctx as any).tenantId = tenantId; if (agentName) (ctx as any).agentId = agentName;

            // Use 'next' directly - it's the snapshot we just saved with the observation
            const baseNow = next as Record<string, unknown>;
            const M: MentalState = (baseNow as any).M as MentalState || initialM(ctx);
            // Attach and restore LLM before running loop
            await this.attachAndRestoreLLM(ctx, agentName, M);

            const taskResult = await this.turnRunner.runTurn(ctx, {
                tenantId,
                sessionId: taskId,
                trigger: 'tool',
                toolToken: token,
                toolResult: result,
                isStreaming: false
            }, {
                initialM: M,
                snapshot: baseNow
            });
            // Note: TurnRunner.runTurn already publishes the completion event via eventBus,
            // so we don't need to publish again here.
        } catch { /* ignore resume errors */ }
    }

    /**
     * Handle external event occurrence: removes pending event token and invokes durable handler if present.
     */
    async handleExternalEventOccurred(params: { tenantId: string; taskId: string; token: string; payload: unknown }): Promise<void> {
        const { tenantId, taskId, token, payload } = params;
        const snap = await this.sessionManager?.load(tenantId, taskId);
        if (!snap) return;
        const base = (snap.snapshot as Record<string, unknown>) || {};
        const events = getPendingExternalEvents(base) as any;
        const entry = events[token];
        if (!entry) return;
        delete events[token];
        const next = setPendingExternalEvents(base, events) as Record<string, unknown>;
        const externalObservation: EngineObservation = {
            source: 'env',
            kind: 'external.event',
            payload: { token, payload, type: entry?.type },
            provenance: {
                ts: Date.now(),
                turn: Number((base as any)?.meta?.turn ?? 0) + 1,
                id: token,
                correlationId: token
            }
        };
        (next as any).inbox = InboxManager.addObservationToInbox((next as any).inbox, externalObservation);
        await this.sessionManager?.saveSnapshot({ tenantId, sessionId: taskId, agentId: (base as any)?.meta?.agentId || 'default', expectedWmVersion: snap.wmVersion ?? BigInt(0), snapshot: next });
        await this.sessionManager?.appendEvent(tenantId, taskId, 'task.external_event_registered', { token, type: entry?.type });
        // Always auto-resume one loop turn to consume the external event
        try {
            const agentName = (snap as any)?.agentId;
            const ctx = this.createContext({ id: taskId, input: {} });
            (ctx as any).tenantId = tenantId; if (agentName) (ctx as any).agentId = agentName;

            const snapNow = await this.sessionManager!.load(tenantId, taskId);
            const baseNow = (snapNow?.snapshot as Record<string, unknown>) || {};
            const M: MentalState = (baseNow as any).M as MentalState || initialM(ctx);
            // Attach and restore LLM before running loop
            await this.attachAndRestoreLLM(ctx, agentName, M);

            const taskResult = await this.turnRunner.runTurn(ctx, {
                tenantId,
                sessionId: taskId,
                trigger: 'event',
                eventToken: token,
                eventType: entry?.type,
                eventPayload: payload,
                isStreaming: false
            }, {
                initialM: M,
                snapshot: baseNow
            });

            const channel = taskChannel(taskId);
            try {
                if (taskResult.status) {
                    eventBus.publish(channel, {
                        id: taskId,
                        status: taskResult.status,
                        final: taskResult.status.state === 'completed' || taskResult.status.state === 'failed'
                    } as any);
                }
            } catch { }
        } catch { }
    }

    /**
     * Stage child completion observation synchronously in the inbox.
     * This ensures the observation is available when the parent resumes, even for synchronous completions.
     */
    async stageChildCompletionObservation(params: { tenantId: string; parentTaskId: string; childToken?: string; childTaskId?: string; result: unknown; childAgentId?: string }): Promise<void> {
        const { tenantId, parentTaskId, childToken, childTaskId, result, childAgentId } = params;
        try {
            const snap = await this.sessionManager?.load(tenantId, parentTaskId);
            if (!snap) {
                log.warn('Cannot stage observation: snapshot not found', { parentTaskId });
                return;
            }
            const base = (snap.snapshot as Record<string, unknown>) || {};
            const tasks = getPendingTasks(base);
            const token = childToken || Object.keys(tasks).find(t => (tasks[t] as any)?.childTaskId === childTaskId);
            if (!token || (childToken && !tasks[childToken])) {
                log.warn('Cannot stage observation: token not found', {
                    parentTaskId,
                    childToken,
                    childTaskId,
                    pendingTaskKeys: Object.keys(tasks)
                });
                return;
            }

            log.debug('🔍 STAGING: Staging child completion observation', {
                parentTaskId,
                token,
                hasResult: !!result,
                pendingTaskKeys: Object.keys(tasks),
                tokenFound: !!token
            });

            const stagingPrisma = this.getSessionStorePrisma();
            if (stagingPrisma && result && typeof result === 'object') {
                log.debug('hydrating child result while staging observation', { parentTaskId, token });
                const cache = new AgentResultCache(stagingPrisma);
                ArtifactHydrationService.tryHydrateChildResult(result, cache, tenantId);
            }
            // Extract clean result from potentially wrapped TaskEntity
            // This fixes the confusing nested structure where result might be a TaskEntity wrapper
            const cleanChildResult = TaskStateUtils.extractCleanChildResult(result);
            const childObservation: EngineObservation = {
                source: 'child',
                kind: 'child.completed',
                payload: {
                    token,
                    childTaskId: cleanChildResult.childTaskId || childTaskId || token,
                    result: cleanChildResult.result, // Use clean extracted result
                    agentId: childAgentId,
                    executionMetadata: cleanChildResult.executionMetadata // Add execution metadata at payload level
                },
                provenance: {
                    ts: Date.now(),
                    turn: Number((base as any)?.meta?.turn ?? 0) + 1,
                    id: token,
                    correlationId: token
                }
            };

            const next = { ...base };
            (next as any).inbox = InboxManager.addObservationToInbox((next as any).inbox, childObservation);
            const parentAgentId = (snap as any)?.agentId || (base as any)?.meta?.agentId || 'default';

            // ✅ FIX: Handle CAS version conflicts by retrying with latest version
            // This is critical because the parent may save the snapshot after returning await_child
            let retryCount = 0;
            const maxRetries = 3;
            let saved = false;

            while (!saved && retryCount < maxRetries) {
                try {
                    const latestSnap = await this.sessionManager?.load(tenantId, parentTaskId);
                    if (!latestSnap) {
                        log.warn('Cannot stage observation: snapshot not found on retry', { parentTaskId, retryCount });
                        return;
                    }

                    // Merge observation into latest snapshot
                    const latestBase = (latestSnap.snapshot as Record<string, unknown>) || {};
                    const latestNext = { ...latestBase };
                    const latestInbox = InboxManager.normalizeInbox((latestNext as any)?.inbox);
                    const observationPredicate = (obs: EngineObservation) =>
                        obs?.kind === 'child.completed' &&
                        typeof obs === 'object' &&
                        obs !== null &&
                        (obs as any)?.payload &&
                        (obs as any).payload.token === token;

                    if (!latestInbox.all.some(observationPredicate)) {
                        (latestNext as any).inbox = InboxManager.addObservationToInbox((latestNext as any).inbox, childObservation);
                    } else {
                        // Observation already exists, no need to save
                        saved = true;
                        break;
                    }

                    await this.sessionManager?.saveSnapshot({
                        tenantId,
                        sessionId: parentTaskId,
                        agentId: parentAgentId,
                        expectedWmVersion: latestSnap.wmVersion ?? BigInt(0),
                        snapshot: latestNext
                    });

                    saved = true;
                    log.debug('✅ STAGING SUCCESS: Staged child completion observation synchronously', {
                        parentTaskId,
                        token,
                        resultStatus: (result as any)?.status,
                        retryCount,
                        inboxAllCount: latestInbox.all.length,
                        inboxCurrentCount: latestInbox.current.length,
                        hasObservation: latestInbox.all.some(observationPredicate)
                    });
                } catch (saveError) {
                    if ((saveError as Error).message === 'CAS_MISMATCH' && retryCount < maxRetries - 1) {
                        retryCount++;
                        await new Promise(resolve => setTimeout(resolve, 10 * retryCount)); // Exponential backoff
                    } else {
                        throw saveError;
                    }
                }
            }

            if (!saved) {
                log.error('❌ STAGING FAILED: Failed to stage child completion observation after retries', {
                    parentTaskId,
                    childToken,
                    retryCount
                });
            }
        } catch (error) {
            log.warn('Failed to stage child completion observation synchronously', {
                error: error instanceof Error ? error.message : String(error),
                parentTaskId,
                childToken
            });
        }
    }

    /**
     * Route child completion to parent's durable handler using pending task mappings.
     * Provide either childToken (preferred correlation) or childTaskId.
     */
    async handleChildCompleted(params: { tenantId: string; parentTaskId: string; childToken?: string; childTaskId?: string; result: unknown; childAgentId?: string }): Promise<void> {
        const { tenantId, parentTaskId, childToken, childTaskId, result, childAgentId } = params;
        const inflightKey = `${parentTaskId}:${childToken ?? childTaskId ?? 'n/a'}`;
        const callCount = (this.childCompletionInFlight.get(inflightKey) ?? 0) + 1;
        this.childCompletionInFlight.set(inflightKey, callCount);
        log.debug('Child completion processing started', {
            parentTaskId: parentTaskId.substring(0, 25),
            childToken: childToken?.substring(0, 15),
            callCount,
            inflightKey
        });
        if (callCount > 1) {
            log.warn('Duplicate child completion invocation detected', { inflightKey, callCount });
        }

        const detach = () => {
            this.childCompletionInFlight.delete(inflightKey);
        };

        let ctx: TaskContext | undefined;
        try {
            const snap = await this.sessionManager?.load(tenantId, parentTaskId);
            if (!snap) return;
            const base = (snap.snapshot as Record<string, unknown>) || {};
            const tasks = getPendingTasks(base);
            const token = childToken || Object.keys(tasks).find(t => (tasks[t] as any)?.childTaskId === childTaskId);
            if (!token) return;
            const entry = tasks[token] as any;
            const hadPendingEntry = Boolean(entry);
            const opts = entry?.options ?? {};
            const shouldSetToken = opts.setToken !== false;
            const shouldAutoClear = opts.autoClearToken !== false;
            const childTokenPath = opts.tokenPath ?? 'child.token';
            const shouldClearControlVar = shouldSetToken && shouldAutoClear;
            // If this child was awaited synchronously by the parent, skip auto-resume (already handled in-turn)
            if (entry && entry.handlers && entry.handlers.completed === undefined && entry.handlers.failed === undefined && entry.handlers.inputRequired === undefined && (result as any)?.status?.state !== 'input-required') {
                // Default await path: no handlers set and result is terminal -> no extra resume needed
                // Fall through to cleanup mapping only
            }
            const nextSnapshot = setPendingTasks(base, tasks) as Record<string, unknown> | undefined;
            let next = nextSnapshot ?? ({ ...(base || {}) } as Record<string, unknown>);
            (next as any).inbox = (next as any).inbox || { current: [], all: [] };
            const parentPrisma = this.getSessionStorePrisma();
            if (parentPrisma && result && typeof result === 'object') {
                log.debug('hydrating child result in handleChildCompleted', { parentTaskId, token });
                const cache = new AgentResultCache(parentPrisma);
                ArtifactHydrationService.tryHydrateChildResult(result, cache, tenantId);
            }
            // Extract clean result from potentially wrapped TaskEntity
            // This fixes the confusing nested structure where result might be a TaskEntity wrapper
            const cleanChildResult = TaskStateUtils.extractCleanChildResult(result);
            const childObservation: EngineObservation = {
                source: 'child',
                kind: 'child.completed',
                payload: {
                    token,
                    childTaskId: cleanChildResult.childTaskId || childTaskId || token,
                    result: cleanChildResult.result, // Use clean extracted result
                    agentId: childAgentId,
                    executionMetadata: cleanChildResult.executionMetadata // Add execution metadata at payload level
                },
                provenance: {
                    ts: Date.now(),
                    turn: Number((base as any)?.meta?.turn ?? 0) + 1,
                    id: token,
                    correlationId: token
                }
            };
            log.debug('Appending child completion event', {
                parentTaskId,
                token,
                resultStatus: (result as any)?.status,
            });
            const cleanupSnapshotForChild = (snapshot: Record<string, unknown>): Record<string, unknown> => {
                let updatedSnapshot = snapshot;
                if (hadPendingEntry && shouldAutoClear) {
                    const tasksMap = getPendingTasks(updatedSnapshot);
                    if (tasksMap[token]) {
                        delete tasksMap[token];
                        updatedSnapshot = setPendingTasks(updatedSnapshot, tasksMap);
                    }
                }
                if (shouldClearControlVar) {
                    updatedSnapshot = TaskStateUtils.removeControlVarFromSnapshot(updatedSnapshot, childTokenPath);
                }
                return updatedSnapshot;
            };
            next = cleanupSnapshotForChild(next);
            const observationPredicate = (obs: EngineObservation) =>
                obs?.kind === 'child.completed' &&
                typeof obs === 'object' &&
                obs !== null &&
                (obs as any)?.payload &&
                (obs as any).payload.token === token;
            (next as any).inbox = InboxManager.addObservationToInboxIfMissing((next as any).inbox, childObservation, observationPredicate);
            const parentAgentId = (snap as any)?.agentId || (base as any)?.meta?.agentId || 'default';
            let snapshotSaved = false;

            // ✅ FIX: Add CAS retry loop to handle race conditions with parent's concurrent save
            const maxSaveRetries = 5;
            let saveAttempt = 0;
            let currentSnap = snap;
            let currentNext = next;

            while (!snapshotSaved && saveAttempt < maxSaveRetries) {
                saveAttempt++;
                try {
                    await this.sessionManager?.saveSnapshot({
                        tenantId,
                        sessionId: parentTaskId,
                        agentId: parentAgentId,
                        expectedWmVersion: currentSnap.wmVersion ?? BigInt(0),
                        snapshot: currentNext
                    });
                    snapshotSaved = true;
                } catch (snapshotError) {
                    if ((snapshotError as Error).message === 'LIMIT_WM_SNAPSHOT_TOO_LARGE') {
                        try {
                            const { pruneMentalState } = await import('../loop/hygiene.js');
                            pruneMentalState((currentNext as any).M);
                            await this.sessionManager?.saveSnapshot({
                                tenantId,
                                sessionId: parentTaskId,
                                agentId: parentAgentId,
                                expectedWmVersion: currentSnap.wmVersion ?? BigInt(0),
                                snapshot: currentNext
                            });
                            snapshotSaved = true;
                        } catch (retryError) {
                            log.warn('Failed to save snapshot with child completion observation even after pruning', {
                                error: (retryError as Error).message,
                                parentTaskId,
                                childToken: token
                            });
                        }
                    } else if ((snapshotError as Error).message === 'CAS_MISMATCH' && saveAttempt < maxSaveRetries) {
                        // ✅ FIX: Reload snapshot and re-add observation on CAS conflict
                        log.debug('CAS_MISMATCH in handleChildCompleted, retrying', {
                            parentTaskId,
                            childToken: token,
                            attempt: saveAttempt
                        });
                        await new Promise(resolve => setTimeout(resolve, 20 * saveAttempt)); // Backoff

                        // Reload latest snapshot
                        const latestSnap = await this.sessionManager?.load(tenantId, parentTaskId);
                        if (!latestSnap) {
                            log.warn('Snapshot not found on CAS retry in handleChildCompleted', { parentTaskId });
                            break;
                        }
                        currentSnap = latestSnap;
                        const latestBase = (latestSnap.snapshot as Record<string, unknown>) || {};

                        // Re-build next with the observation added to latest snapshot
                        let latestNext = cleanupSnapshotForChild({ ...latestBase });
                        const latestInbox = InboxManager.normalizeInbox((latestNext as any)?.inbox);

                        // Check if observation already exists (maybe another path added it)
                        if (latestInbox.all.some(observationPredicate)) {
                            log.debug('Observation already exists in snapshot after CAS retry', { parentTaskId, token });
                            snapshotSaved = true;
                            break;
                        }

                        (latestNext as any).inbox = InboxManager.addObservationToInboxIfMissing(
                            (latestNext as any).inbox,
                            childObservation,
                            observationPredicate
                        );
                        currentNext = latestNext;
                    } else {
                        log.warn('Failed to save snapshot during child completion', {
                            error: (snapshotError as Error).message,
                            parentTaskId,
                            childToken: token
                        });
                        break;
                    }
                }
            }

            if (!snapshotSaved) {
                log.error('Failed to save child completion observation after all retries', {
                    parentTaskId,
                    childToken: token,
                    attempts: saveAttempt
                });
            }

            try {
                await this.sessionManager?.appendEvent(tenantId, parentTaskId, 'task.child_completed', { token, childTaskId, result });
            } catch (eventError) {
                log.warn('Failed to append child completion event, likely due to closed connection', {
                    error: (eventError as Error).message,
                    parentTaskId,
                    childToken: token
                });
            }

            try {
                const agentName = (snap as any)?.agentId;
                let plugin: AgentPlugin | null = null;
                if (agentName) {
                    const findAgent = (PluginManager as any)?.findAgent;
                    if (typeof findAgent === 'function') {
                        try {
                            plugin = findAgent.call(PluginManager, agentName);
                        } catch (pluginError) {
                            log.warn('Failed to resolve plugin before resuming child completion', {
                                error: pluginError instanceof Error ? pluginError.message : String(pluginError),
                                parentTaskId,
                                agentName
                            });
                        }
                    } else {
                        log.debug('PluginManager.findAgent unavailable while handling child completion', { agentName });
                    }
                }
                ctx = this.createContext({ id: parentTaskId, input: {} });
                (ctx as any).tenantId = tenantId; if (agentName) (ctx as any).agentId = agentName;
                if (!(ctx as any).task) {
                    (ctx as any).task = { id: parentTaskId, input: {} };
                }
                try { extendContextWithStreaming(ctx, true); } catch { /* noop */ }
                // --- START RETRY LOOP ---
                let resumeSuccess = false;
                let resumeRetryCount = 0;
                const resumeMaxRetries = 3;
                let shouldResumeParent = false;
                let resumeReason: string | undefined;

                while (!resumeSuccess && resumeRetryCount < resumeMaxRetries) {
                    try {
                        // OPTION 1: Version Coordination in Parent Resume
                        // After ALL saves in handleChildCompleted, load the final snapshot
                        // ✅ FIX: Load the latest snapshot AFTER staging observation to ensure we have it
                        const finalSnap = await this.sessionManager!.load(tenantId, parentTaskId);

                        // ✅ FIX: Guard against empty/missing snapshot to prevent phantom restarts (Turn 1 resets)
                        // ✅ FIX: Guard against empty/missing snapshot to prevent phantom restarts (Turn 1 resets)
                        if (!finalSnap || !finalSnap.snapshot) {
                            log.warn('handleChildCompleted: Final snapshot is empty. Aborting resume to prevent state corruption (phantom loop).', {
                                parentTaskId,
                                hasSnap: !!finalSnap,
                                hasData: !!finalSnap?.snapshot,
                                wmVersion: finalSnap?.wmVersion?.toString()
                            });
                            return;
                        }

                        if (!(finalSnap.snapshot as any).meta) {
                            log.warn('handleChildCompleted: Snapshot missing meta. Proceeding with caution (might be first turn or migration).', {
                                parentTaskId,
                                wmVersion: finalSnap?.wmVersion?.toString()
                            });
                        }

                        let baseNow = (finalSnap?.snapshot as Record<string, unknown>) || {};

                        // ✅ FIX: Always ensure inbox has the observation, even if snapshotSaved is true
                        // This handles race conditions where stageChildCompletionObservation saved but
                        // handleChildCompleted loaded an older version
                        const finalInbox = InboxManager.normalizeInbox((baseNow as any)?.inbox);
                        const finalPrisma = this.getSessionStorePrisma();
                        if (finalPrisma) {
                            const cache = new AgentResultCache(finalPrisma);
                            hydrateArtifacts(finalInbox, cache, tenantId);
                        }
                        const observationPredicateForCheck = (obs: EngineObservation) =>
                            obs?.kind === 'child.completed' &&
                            typeof obs === 'object' &&
                            obs !== null &&
                            (obs as any)?.payload &&
                            (obs as any).payload.token === token;
                        const hasObservation = finalInbox.all.some(observationPredicateForCheck);

                        if (!snapshotSaved || !hasObservation) {
                            // Merge next (which has the observation) with baseNow to ensure observation is present
                            baseNow = {
                                ...baseNow,
                                pending: (next as any).pending,
                                inbox: (next as any).inbox
                            } as Record<string, unknown>;
                        }

                        const prevMetaCheck = (baseNow as any).meta || {};
                        if (prevMetaCheck.lastChildToken === token) {
                            return;
                        }

                        // CRITICAL: Store the FINAL version in context for coordination
                        // This ensures all subsequent operations use the correct expected version
                        (ctx as any).__coordinatedVersion = finalSnap?.wmVersion ?? BigInt(0);

                        // ✅ FIX: Only extend context with memory if it doesn't already exist
                        // This prevents creating multiple PrismaClient instances and exhausting DB connections
                        // The context should already have memory set up from the initial task start
                        if (!(ctx as any).memory) {
                            try {
                                // ✅ FIX: Always use singleton PrismaClient to prevent connection exhaustion
                                const { getMemoryPrismaClient, setMemoryPrismaClient } = await import('@a2arium/callagent-memory-engine');
                                const singletonPrisma = await getMemoryPrismaClient();

                                // Try to reuse existing PrismaClient from session store if available, otherwise use singleton
                                const existingPrisma = (this.sessionManager as any)?.store?.prisma || singletonPrisma;

                                // If we got PrismaClient from session store, set it as singleton for future use
                                if ((this.sessionManager as any)?.store?.prisma && !singletonPrisma) {
                                    setMemoryPrismaClient((this.sessionManager as any).store.prisma);
                                }

                                const { createEmbeddingFunction, isEmbeddingAvailable } = await import('../llm/LLMFactory.js');
                                const embeddingFunction = isEmbeddingAvailable() ? await createEmbeddingFunction() : undefined;

                                const memoryRegistry = await createMemoryRegistry(
                                    tenantId,
                                    agentName || 'default',
                                    ctx,
                                    {
                                        ...(existingPrisma ? { database: { prismaClient: existingPrisma } } : {}),
                                        embeddingFunction
                                    }
                                );
                                // Extract semantic adapter from the registry - it's a MemoryRegistry object with backends
                                const semanticBackends = (memoryRegistry.semantic as any)?.backends;
                                const semanticAdapter = semanticBackends?.sql || semanticBackends?.mlo || undefined;

                                log.debug('Extending context with memory in handleChildCompleted', {
                                    parentTaskId,
                                    agentName,
                                    hasSemanticAdapter: !!semanticAdapter,
                                    hasMemoryRegistry: !!memoryRegistry,
                                    reusedPrisma: !!existingPrisma
                                });

                                await extendContextWithMemory(
                                    ctx,
                                    tenantId,
                                    agentName || 'default',
                                    plugin?.resolved.runtimeManifest || {},
                                    semanticAdapter,
                                    existingPrisma // ✅ FIX: Always pass PrismaClient to reuse it
                                );

                                log.debug('Context extended with memory successfully', {
                                    parentTaskId,
                                    agentName,
                                    hasMemory: !!(ctx as Record<string, unknown>).memory
                                });
                            } catch (memoryError) {
                                log.error('Failed to extend context with memory in handleChildCompleted', {
                                    error: memoryError instanceof Error ? memoryError.message : String(memoryError),
                                    stack: memoryError instanceof Error ? memoryError.stack : undefined,
                                    parentTaskId,
                                    agentName
                                });
                                // Continue without memory extension - ctx.memory will be undefined but loop should still work
                            }
                        } else {
                            log.debug('Context already has memory setup, skipping extendContextWithMemory', {
                                parentTaskId,
                                agentName,
                                hasMemory: !!(ctx as Record<string, unknown>).memory
                            });
                        }

                        // FINAL VERSION COORDINATION: Load the absolute latest version right before execution
                        // ✅ PERF FIX: Host snapshot load BEFORE attachWorkingMemory to prevent double-loading (OOM fix)
                        const absoluteLatestSnap = await this.sessionManager!.load(tenantId, parentTaskId);
                        (ctx as any).__coordinatedVersion = absoluteLatestSnap?.wmVersion ?? BigInt(0);

                        // ✅ FIX: Use the ABSOLUTE LATEST snapshot for MentalState loading
                        // This ensures we have the most recent MentalState including any updates
                        const latestBase = (absoluteLatestSnap?.snapshot as Record<string, unknown>) || {};
                        let M: MentalState = (latestBase as any).M as MentalState || initialM(ctx);

                        // Hydrate artifacts immediately
                        M = (ArtifactHydrationService.hydrateMentalStateArtifacts(
                            M,
                            this.getSessionStorePrisma() || (this.sessionManager as any)?.prisma,
                            tenantId,
                            'handleChildCompleted'
                        ) as MentalState) || M;

                        // Attach working memory using the ALREADY LOADED MentalState
                        // This also sets up orchestration APIs (sendTaskToAgent, requestInput, etc.)
                        await this.attachWorkingMemory(ctx, tenantId, parentTaskId, agentName || 'default', M);

                        // Load MentalState from latest snapshot
                        await this.attachAndRestoreLLM(ctx, agentName, M);

                        // ✅ FIX: Verify snapshot agentId to prevent cross-agent contamination
                        const snapshotAgentId = (latestBase as any)?.meta?.agentId || (finalSnap as any)?.agentId;
                        if (snapshotAgentId && agentName && snapshotAgentId !== agentName && snapshotAgentId !== 'default') {
                            log.warn('CRITICAL: Resume loaded snapshot with mismatched Agent ID', {
                                expected: agentName,
                                actual: snapshotAgentId,
                                parentTaskId
                            });
                            // In production, we might want to abort here, but for now we log heavily
                        }

                        const recordedTurn = Number((latestBase as any)?.meta?.turn) || 0;

                        // Log detailed state for debugging the "reset to turn 1" issue
                        log.debug('🔍 RESUME: Determining parent turn', {
                            parentTaskId,
                            metaTurn: (latestBase as any)?.meta?.turn,
                            recordedTurn,
                            nextTurn: recordedTurn + 1,
                            token,
                            snapshotAgentId,
                            snapshotKeys: Object.keys(latestBase),
                            wmVersion: finalSnap?.wmVersion?.toString()
                        });

                        const startTurnTotal2 = recordedTurn;
                        let envInbox = InboxManager.normalizeInbox((latestBase as any)?.inbox);
                        envInbox = ArtifactHydrationService.hydrateInboxArtifacts(
                            envInbox,
                            this.getSessionStorePrisma() || (this.sessionManager as any)?.prisma,
                            tenantId,
                            'handleChildCompleted'
                        );
                        log.debug('Child resume before helper', {
                            sessionId: parentTaskId,
                            currentLength: envInbox.current.length,
                            allLength: envInbox.all.length,
                            currentKinds: envInbox.current.map(o => o.kind),
                            allKinds: envInbox.all.map(o => o.kind),
                        });

                        // ✅ FIX: Always ensure the observation is in the inbox before resuming
                        // This is critical for synchronous completions where the observation must be available immediately
                        const observationPredicate = (obs: EngineObservation) =>
                            obs?.kind === 'child.completed' &&
                            typeof obs === 'object' &&
                            obs !== null &&
                            (obs as any)?.payload &&
                            (obs as any).payload.token === token;
                        envInbox = InboxManager.addObservationToInboxIfMissing(envInbox, childObservation, observationPredicate);

                        // ✅ FIX: Ensure observation is in current inbox - critical for preventing infinite loops
                        // If current is empty but observation exists in all, move it to current
                        if (envInbox.current.length === 0) {
                            const obsInAll = envInbox.all.find(observationPredicate);
                            if (obsInAll) {
                                envInbox.current = [obsInAll];
                                log.debug('Fixed: Moved observation from all to current inbox', { token });
                            } else {
                                // Last resort: add it directly
                                envInbox.current = [childObservation];
                                if (!envInbox.all.some(observationPredicate)) {
                                    envInbox.all.push(childObservation);
                                }
                                log.warn('CRITICAL: Had to add observation directly - this indicates a bug!', { token });
                            }
                        }

                        log.debug('Child resume after helper', {
                            sessionId: parentTaskId,
                            currentLength: envInbox.current.length,
                            allLength: envInbox.all.length,
                            currentKinds: envInbox.current.map(o => o.kind),
                            allKinds: envInbox.all.map(o => o.kind),
                        });

                        // ✅ FIX: ONLY resume if parent has explicitly saved await_child state for THIS token
                        //     OR we detected a pending entry before awaiting metadata could be persisted.
                        const awaiting = (latestBase as any)?.meta?.awaiting;
                        const awaitingKind = (awaiting as any)?.kind;
                        const awaitingToken = (awaiting as any)?.token;
                        const hasAwaitingMetadata = Boolean(awaitingKind || awaitingToken);
                        const resumeDueToMetadata = awaitingKind === 'await_child' && awaitingToken === token;
                        const resumeDueToPendingOnly = !hasAwaitingMetadata && hadPendingEntry;
                        const resumeReasonText = resumeDueToMetadata
                            ? 'awaiting metadata matched this child'
                            : resumeDueToPendingOnly
                                ? 'pending entry observed before awaiting metadata persisted'
                                : undefined;
                        shouldResumeParent = resumeDueToMetadata || resumeDueToPendingOnly;
                        resumeReason = resumeReasonText;

                        if (!shouldResumeParent) {
                            log.debug('handleChildCompleted: Not resuming parent - not explicitly awaiting this child', {
                                parentTaskId,
                                childToken: token,
                                awaiting: awaiting ? { kind: awaitingKind, token: awaitingToken } : 'undefined',
                                reason: awaiting ? 'awaiting different token' : 'awaiting metadata missing'
                            });
                            // The observation is already staged in the inbox
                            // The parent will pick it up when it finishes its current turn
                            detach();
                            return;
                        }

                        log.debug('handleChildCompleted: Resuming parent - explicitly awaiting this child', {
                            parentTaskId,
                            childToken: token,
                            recordedTurn,
                            nextTurn: recordedTurn + 1,
                            reason: resumeReasonText
                        });

                        const env: EnvironmentState = {
                            time: new Date().toISOString(),
                            sessionId: parentTaskId,
                            turn: recordedTurn, // Bug 1 Fix: Let loopRunner increment
                            budget: { maxTurns: Infinity, latencyMs: Infinity },
                            pending: {
                                inputs: ((latestBase as any)?.pending?.inputs) || {},
                                children: ((latestBase as any)?.pending?.children) || {},
                                tools: ((latestBase as any)?.pending?.tools) || {},
                                groups: ((latestBase as any)?.pending?.groups) || {},
                                controlVars: ((latestBase as any)?.pending?.controlVars) || {}
                            },
                            inbox: envInbox,
                            lastExec: (latestBase as any)?.meta?.lastExec || undefined,
                            externalEvents: undefined
                        };

                        const overrides = (plugin as { loop?: { modules?: Record<string, unknown> } })?.loop?.modules || {};

                        // Restore manifest provenance from parent snapshot
                        const latestMeta = (latestBase as Record<string, unknown>)?.meta as { manifestProvenance?: ManifestProvenance } | undefined;
                        if (latestMeta?.manifestProvenance) {
                            (ctx as InternalTaskContext).__manifestProvenance = latestMeta.manifestProvenance;
                        }

                        let loopOpts: { maxTurns?: number; latencyMs?: number; manifestProvenance?: ManifestProvenance } = {};
                        try {
                            // Restore budgets from snapshot first, then fallback to manifest
                            const persistedBudgets = (latestBase as Record<string, unknown>)?.meta as { maxTurns?: number; latencyMs?: number } | undefined;
                            const manifestBudgets = plugin?.resolved.runtimeManifest.budgets;
                            const hitl = plugin?.resolved.runtimeManifest.hitl;
                            if (hitl) { try { (M as any).hitl = hitl; } catch { } }

                            if (persistedBudgets && typeof persistedBudgets.maxTurns === 'number') {
                                loopOpts = persistedBudgets;
                            }

                            // ✅ FIX: Force reload budgets from manifest if missing or Infinity (regression fix)
                            if ((!loopOpts.maxTurns || loopOpts.maxTurns === Infinity) && manifestBudgets && typeof manifestBudgets === 'object') {
                                loopOpts = { maxTurns: manifestBudgets.maxTurns, latencyMs: manifestBudgets.latencyMs };
                                log.debug('Resume restored budgets from manifest', loopOpts);
                            } else if (!loopOpts.maxTurns) {
                                // Bug 2 Fix: Use default if manifest/snapshot missing
                                loopOpts = { maxTurns: 50 };
                            }

                            if (typeof loopOpts.maxTurns === 'number') {
                                env.budget = { maxTurns: loopOpts.maxTurns, latencyMs: loopOpts.latencyMs ?? Infinity };
                            }
                        } catch (err) {
                            try { (ctx as { logger?: { warn?: (msg: string, o?: unknown) => void } }).logger?.warn?.('Failed to restore budgets in handleChildCompleted', { error: err }); } catch { }
                        }
                        loopOpts.manifestProvenance = (ctx as InternalTaskContext).__manifestProvenance;
                        try {
                            const { taskStatus } = await TaskExecutor.executeTurn({
                                ctx, M, env, overrides, loopOpts,
                                sessionManager: this.sessionManager,
                                tenantId, sessionId: parentTaskId, agentId: agentName || 'default',
                                isStreaming: false,
                                getSessionStorePrisma: () => this.getSessionStorePrisma(),
                                throwOnSaveFailure: true // Rethrow CAS/save errors to trigger retry loop
                            });
                            const channel = taskChannel(parentTaskId);
                            try { eventBus.publish(channel, { id: parentTaskId, status: taskStatus, final: taskStatus.state === 'completed' || taskStatus.state === 'failed' } as any); } catch { }

                            resumeSuccess = true;
                        } catch (e) {
                            if ((e as Error).message === 'CAS_MISMATCH') {
                                // Allow outer retry loop to handle it
                                throw e;
                            }
                            // Log but convert other save errors to success (we don't retry non-CAS errors here usually)
                            try { (ctx as any).logger?.warn?.('Failed to save in handleChildCompleted', { error: e }); } catch { }
                            resumeSuccess = true; // Exit loop on non-CAS error
                        }
                    } catch (e) {
                        if ((e as Error).message === 'CAS_MISMATCH') {
                            resumeRetryCount++;
                            log.warn('handleChildCompleted: CAS Mismatch during parent resume, retrying with FRESH state...', {
                                parentTaskId,
                                retry: resumeRetryCount,
                                note: 'Will reload snapshot and recalculate turn on next iteration'
                            });
                            // Backoff before retry - the retry will reload fresh snapshot at line 3614
                            await new Promise(r => setTimeout(r, 50 * resumeRetryCount));
                            // IMPORTANT: The `continue` here goes back to the top of the while loop
                            // which reloads `finalSnap` and recalculates `recordedTurn` from fresh data
                            continue;
                        }
                        throw e; // Re-throw other errors
                    }
                }
                // --- END RETRY LOOP ---
            } catch (resumeError) {
                // If resume fails (e.g., database connection closed), log the error
                // This is expected when deferred notifications run after parent task completes
                log.warn('Failed to resume parent after child completion', {
                    error: (resumeError as Error).message,
                    parentTaskId,
                    childToken: token,
                    note: 'This may occur if the parent task completed before the deferred notification ran'
                });
            }

            // Update any pending group aggregations that include this child token
            const snap2 = await this.sessionManager?.load(tenantId, parentTaskId);
            if (snap2) {
                const base2 = (snap2.snapshot as Record<string, unknown>) || {};
                const groups = getPendingGroups(base2) || {};
                if (process.env.DEBUG_BACKGROUND_TASKS) {
                    console.log(`[TaskEngine.handleChildCompleted] Checking groups, token=${token}, groups=${Object.keys(groups).length}`);
                }
                let mutated = false;
                for (const [gToken, gEntry] of Object.entries(groups || {})) {
                    const g = gEntry as any;
                    if (g.childTokens?.includes(token)) {
                        if (process.env.DEBUG_BACKGROUND_TASKS) {
                            console.log(`[TaskEngine.handleChildCompleted] Found group ${gToken} with token ${token}, childTokens=${g.childTokens.length}`);
                        }
                        g.results = g.results || {} as any;
                        (g.results as any)[token] = { ok: true, value: result };
                        mutated = true;
                        // Check if all children have results recorded
                        const allDone = g.childTokens.every((ct: string) => (g.results as any)[ct] !== undefined);
                        if (process.env.DEBUG_BACKGROUND_TASKS) {
                            console.log(`[TaskEngine.handleChildCompleted] Group ${gToken} allDone=${allDone}, results=${Object.keys((g.results as any) || {}).length}/${g.childTokens.length}`);
                        }
                        if (allDone) {
                            // invoke group allCompleted handler if set
                            const handler = g.handlers?.allCompleted;
                            // remove group from snapshot
                            delete groups[gToken];
                            const next2 = setPendingGroups(base2, groups);
                            await this.sessionManager?.saveSnapshot({ tenantId, sessionId: parentTaskId, agentId: (base2 as any)?.meta?.agentId || 'default', expectedWmVersion: snap2.wmVersion ?? BigInt(0), snapshot: next2 });
                            if (process.env.DEBUG_BACKGROUND_TASKS) {
                                console.log(`[TaskEngine.handleChildCompleted] Firing group_completed event for group ${gToken}`);
                            }
                            await this.sessionManager?.appendEvent(tenantId, parentTaskId, 'task.group_completed', { groupToken: gToken });
                            if (handler && this.handlerInvoker) {
                                await this.handlerInvoker.invoke({ tenantId, taskId: parentTaskId, handlerName: handler, input: g.results });
                            }
                        }
                    }
                }
                if (mutated) {
                    // If not all done, persist interim results
                    const next2 = setPendingGroups(base2, groups);
                    const parentAgentId2 = (snap2 as any)?.agentId || (base2 as any)?.meta?.agentId || 'default';
                    await this.sessionManager?.saveSnapshot({ tenantId, sessionId: parentTaskId, agentId: parentAgentId2, expectedWmVersion: snap2.wmVersion ?? BigInt(0), snapshot: next2 });
                }
            }

        } finally {
            detach();
        }
    }

    /**
     * Route child input-required to parent's durable handler.
     */
    async handleChildInputRequired(params: { tenantId: string; parentTaskId: string; childToken?: string; childTaskId?: string; prompt: string; schema?: unknown; childOnProvided?: string; childInputToken?: string }): Promise<void> {
        const { tenantId, parentTaskId, childToken, childTaskId, prompt, schema, childOnProvided, childInputToken } = params;
        const snap = await this.sessionManager?.load(tenantId, parentTaskId);
        if (!snap) return;
        const base = (snap.snapshot as Record<string, unknown>) || {};
        const tasks = getPendingTasks(base);
        const token = childToken || Object.keys(tasks).find(t => (tasks[t] as any)?.childTaskId === childTaskId);
        if (!token) return;
        const entry = tasks[token] as any;
        const alreadyDelivered = !!entry?.deliveredInput;
        const handlerName = entry?.handlers?.inputRequired;

        // Handle automatic token and stage management if options are set
        if (entry?.options) {
            try {
                const parentSnap = await this.sessionManager?.load(tenantId, parentTaskId);
                if (parentSnap) {
                    let parentBase = (parentSnap.snapshot as Record<string, unknown>) || {};
                    const childTokenPath = entry.options.tokenPath ?? 'child.token';

                    if (entry.options.setToken && token) {
                        parentBase = TaskStateUtils.applyControlVarToSnapshot(parentBase, childTokenPath, token);
                    }

                    if (entry.options.setStage) {
                        parentBase = TaskStateUtils.applyControlVarToSnapshot(parentBase, 'stage', entry.options.setStage);
                    }

                    // Save the updated parent state
                    const expectedWmVersion = parentSnap?.wmVersion ?? BigInt(0);
                    await this.sessionManager?.saveSnapshot({
                        tenantId,
                        sessionId: parentTaskId,
                        agentId: (parentSnap as any)?.agentId || 'default',
                        expectedWmVersion,
                        snapshot: parentBase
                    });
                }
            } catch (error) {
                try { console.warn(`[TaskEngine] Failed to apply auto token/stage options:`, error); } catch { }
            }
        }

        await this.sessionManager?.appendEvent(tenantId, parentTaskId, 'task.child_input_required', { token, childTaskId, prompt, schema, childOnProvided });
        try { log.debug('Child input required processing', { token, handlerName, childOnProvided, childTaskId }); } catch { }
        if (!alreadyDelivered && handlerName && this.handlerInvoker) {
            log.debug('Invoking parent handler', { handlerName, token });
            const maybe = await this.handlerInvoker.invoke({ tenantId, taskId: parentTaskId, handlerName, input: { prompt, schema, token, childTaskId } });
            log.debug('Parent handler completed', { handlerName, hasResult: maybe !== undefined });
            if (typeof maybe !== 'undefined') {
                // Parent provided immediate answer; first try to invoke child's onProvided if available
                let finalChildResult: unknown = maybe;
                try {
                    const effectiveChildOnProvided = childOnProvided || (entry?.pendingInput?.childOnProvided as string | undefined);
                    if (effectiveChildOnProvided && childTaskId && this.handlerInvoker) {
                        log.debug('Invoking child onProvided', { childOnProvided: effectiveChildOnProvided, childTaskId });
                        try {
                            const _childResult = await this.handlerInvoker.invoke({ tenantId, taskId: childTaskId, handlerName: effectiveChildOnProvided, input: maybe });
                            log.debug('Child onProvided completed', { childTaskId, hasResult: _childResult !== undefined });
                            if (typeof _childResult !== 'undefined') {
                                finalChildResult = _childResult;
                            }
                        } catch (err) {
                            try { log.warn('Handler not found or error invoking child onProvided', { childOnProvided: effectiveChildOnProvided, error: err instanceof Error ? err.message : String(err) }); } catch { }
                        }
                    }
                } catch (e) {
                    // If invoking child's handler fails, fall back to using parent's value
                    try { log.debug('Child onProvided invocation failed; using parent value', { error: (e as Error).message }); } catch { }
                }
                // Resume the child loop once with env.input so it processes the provided value inside its own loop
                if (childTaskId && childInputToken) {
                    try {
                        await this.resumeInput({ tenantId, taskId: childTaskId, token: childInputToken, input: finalChildResult });
                        try { console.log(`[TaskEngine] resumed child '${childTaskId}' with input token=${childInputToken}`); } catch { }
                    } catch (err) {
                        try { console.warn(`[TaskEngine] resumeInput failed for childTaskId=${childTaskId}:`, err instanceof Error ? err.message : String(err)); } catch { }
                    }
                }
                try { console.log(`[TaskEngine] routing child completed to parent (token=${token}) result=${JSON.stringify(finalChildResult)}`); } catch { }
                await this.handleChildCompleted({ tenantId, parentTaskId, childToken: token, result: finalChildResult });
            }
            // mark delivered
            const snap3 = await this.sessionManager?.load(tenantId, parentTaskId);
            if (snap3) {
                const base3 = (snap3.snapshot as Record<string, unknown>) || {};
                const tasks3 = getPendingTasks(base3) as any;
                if (tasks3[token]) {
                    tasks3[token].deliveredInput = true;
                    const next3 = setPendingTasks(base3, tasks3);
                    await this.sessionManager?.saveSnapshot({ tenantId, sessionId: parentTaskId, agentId: (base3 as any)?.meta?.agentId || 'default', expectedWmVersion: snap3.wmVersion ?? BigInt(0), snapshot: next3 });
                }
            }
        }
        // If handler is not yet registered, persist pending input so it can be routed once handler is added
        if (!handlerName && !alreadyDelivered) {
            const snap2 = await this.sessionManager?.load(tenantId, parentTaskId);
            if (snap2) {
                const base2 = (snap2.snapshot as Record<string, unknown>) || {};
                const tasks2 = getPendingTasks(base2) as any;
                if (tasks2[token]) {
                    tasks2[token].pendingInput = { prompt, schema, childTaskId, childOnProvided };
                    const next2 = setPendingTasks(base2, tasks2);
                    try {
                        await this.sessionManager?.saveSnapshot({ tenantId, sessionId: parentTaskId, agentId: (base2 as any)?.meta?.agentId || 'default', expectedWmVersion: snap2.wmVersion ?? BigInt(0), snapshot: next2 });
                    } catch (e) {
                        if ((e as Error).message === 'LIMIT_WM_SNAPSHOT_TOO_LARGE') {
                            try {
                                const prunedNext2 = pruneSnapshot(next2 as any);
                                await this.sessionManager?.saveSnapshot({
                                    tenantId,
                                    sessionId: parentTaskId,
                                    agentId: (base2 as any)?.meta?.agentId || 'default',
                                    expectedWmVersion: snap2.wmVersion ?? BigInt(0),
                                    snapshot: prunedNext2
                                });
                            } catch { /* swallow */ }
                        } else if ((e as Error).message === 'CAS_MISMATCH') {
                            try {
                                const snap3 = await this.sessionManager?.load(tenantId, parentTaskId);
                                const base3 = (snap3?.snapshot as Record<string, unknown>) || {};
                                const tasks3 = getPendingTasks(base3) as any;
                                if (tasks3[token]) {
                                    tasks3[token].pendingInput = { prompt, schema };
                                    const next3 = setPendingTasks(base3, tasks3);
                                    await this.sessionManager?.saveSnapshot({ tenantId, sessionId: parentTaskId, agentId: (base3 as any)?.meta?.agentId || 'default', expectedWmVersion: snap3?.wmVersion ?? BigInt(0), snapshot: next3 });
                                }
                            } catch { /* swallow second failure */ }
                        }
                    }
                }
            }
        }
    }

    /**
     * Route child failure to parent's durable handler and update group aggregations.
     */
    async handleChildFailed(params: { tenantId: string; parentTaskId: string; childToken?: string; childTaskId?: string; error: unknown }): Promise<void> {
        const { tenantId, parentTaskId, childToken, childTaskId, error } = params;
        const snap = await this.sessionManager?.load(tenantId, parentTaskId);
        if (!snap) return;
        const base = (snap.snapshot as Record<string, unknown>) || {};
        const tasks = getPendingTasks(base);
        const token = childToken || Object.keys(tasks).find(t => (tasks[t] as any)?.childTaskId === childTaskId);
        if (!token) return;
        const entry = tasks[token];
        const handlerName = entry?.handlers?.failed;
        // Remove pending mapping for this token
        delete tasks[token];
        let next = setPendingTasks(base, tasks);
        await this.sessionManager?.saveSnapshot({ tenantId, sessionId: parentTaskId, agentId: (base as any)?.meta?.agentId || 'default', expectedWmVersion: snap.wmVersion ?? BigInt(0), snapshot: next });
        await this.sessionManager?.appendEvent(tenantId, parentTaskId, 'task.child_failed', { token, childTaskId, error: error instanceof Error ? error.message : String(error) });
        if (handlerName && this.handlerInvoker) {
            await this.handlerInvoker.invoke({ tenantId, taskId: parentTaskId, handlerName, input: error });
        }

        // Update group aggregations
        const snap2 = await this.sessionManager?.load(tenantId, parentTaskId);
        if (!snap2) return;
        const base2 = (snap2.snapshot as Record<string, unknown>) || {};
        const groups = getPendingGroups(base2);
        let mutated = false;
        for (const [gToken, gEntry] of Object.entries(groups)) {
            const g = gEntry as any;
            if (g.childTokens?.includes(token)) {
                g.results = g.results || {} as any;
                (g.results as any)[token] = { ok: false, error: error instanceof Error ? error.message : String(error) };
                mutated = true;
                // If anyFailed handler exists, invoke it once and optionally cancel remaining
                if (g.handlers?.anyFailed) {
                    const handler = g.handlers.anyFailed;
                    // remove group before invoking
                    delete groups[gToken];
                    const next2 = setPendingGroups(base2, groups);
                    await this.sessionManager?.saveSnapshot({ tenantId, sessionId: parentTaskId, agentId: (base2 as any)?.meta?.agentId || 'default', expectedWmVersion: snap2.wmVersion ?? BigInt(0), snapshot: next2 });
                    await this.sessionManager?.appendEvent(tenantId, parentTaskId, 'task.group_failed', { groupToken: gToken });
                    if (this.handlerInvoker) {
                        await this.handlerInvoker.invoke({ tenantId, taskId: parentTaskId, handlerName: handler, input: g.results });
                    }
                } else {
                    // Persist interim state
                    const next2 = setPendingGroups(base2, groups);
                    await this.sessionManager?.saveSnapshot({ tenantId, sessionId: parentTaskId, agentId: (base2 as any)?.meta?.agentId || 'default', expectedWmVersion: snap2.wmVersion ?? BigInt(0), snapshot: next2 });
                }
            }
        }
    }

    /**
     * Execute the task handler
     * In a real implementation, this would find and call the correct agent plugin
     */
    private async executeTaskHandler(ctx: TaskContext): Promise<void> {
        // 1. Try agent-scoped handleTask first
        const agentId = (ctx as any).agentId;
        if (agentId) {
            try {
                const { PluginManager } = await import('../plugin/pluginManager.js');
                const plugin = PluginManager.findAgent(agentId);
                if (plugin && typeof (plugin as any).handleTask === 'function') {
                    (ctx as any).logger?.info?.('TaskEngine.executeTaskHandler: invoking agent-scoped handleTask', { agentId, taskId: ctx.task.id });
                    await (plugin as any).handleTask(ctx, { input: ctx.task.input });
                    (ctx as any).logger?.info?.('TaskEngine.executeTaskHandler: agent-scoped handleTask returned', { agentId, taskId: ctx.task.id });
                    return;
                }
            } catch (err) {
                (ctx as any).logger?.error?.('TaskEngine.executeTaskHandler: agent-scoped handleTask failed', { taskId: ctx.task.id, error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
                // If the agent-scoped handler explicitly failed, don't fall back to global registry
                throw err;
            }
        }

        // 2. Fallback to durable 'handleTask' if registered in global registry
        try {
            (ctx as any).logger?.info?.('TaskEngine.executeTaskHandler: invoking durable handler handleTask from registry', { taskId: ctx.task.id });
            const { invokeHandler } = await import('./HandlerRegistry.js');
            await invokeHandler('handleTask', ctx, {
                input: ctx.task.input
            });
            (ctx as any).logger?.info?.('TaskEngine.executeTaskHandler: durable handleTask returned', { taskId: ctx.task.id });
            return;
        } catch (err) {
            // Fallback: placeholder
            const traceId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            if (err instanceof Error && err.message.includes('HANDLER_NOT_FOUND')) {
                (ctx as any).logger?.warn?.('TaskEngine.executeTaskHandler: no registered handleTask found, and no agent-scoped handler available', { taskId: ctx.task.id });
            } else {
                (ctx as any).logger?.error?.('TaskEngine.executeTaskHandler: durable handler invocation failed', { taskId: ctx.task.id, traceId, error: err instanceof Error ? err.message : String(err) });
            }
            console.log('Executing task handler (placeholder):', ctx.task.id);
        }
    }

    /**
     * Helper to attach and restore LLM for a context from persisted MentalState
     */
    private async attachAndRestoreLLM(ctx: TaskContext, agentName: string | undefined, M: MentalState | undefined, baseSnap?: Record<string, unknown>): Promise<void> {
        if (TaskEngine.testOverrides?.attachAndRestoreLLM) {
            return TaskEngine.testOverrides.attachAndRestoreLLM(ctx, agentName, M, baseSnap);
        }
        if (!agentName) return;

        try {
            const { PluginManager } = await import('../plugin/pluginManager.js');
            const plugin = PluginManager.findAgent(agentName);

            // Create/attach LLM
            if (plugin?.llmAdapter) {
                (ctx as any).llm = plugin.llmAdapter;
            } else if (plugin?.llmConfig) {
                const { createLLMForTask } = await import('../llm/LLMFactory.js');
                (ctx as any).llm = createLLMForTask(plugin.llmConfig, ctx as any);
            }

            // Restore/Clear LLM conversation state if available
            if (M) {
                try {
                    const llmAny = (ctx as any).llm as any;
                    const historyMode = (typeof llmAny?.getHistoryMode === 'function') ? llmAny.getHistoryMode() : 'full';

                    if (historyMode === 'stateless') {
                        if (typeof llmAny?.clearHistory === 'function') {
                            llmAny.clearHistory();
                            try { console.log('[TaskEngine] Cleared LLM history (stateless mode) for', agentName); } catch { }
                        }
                    } else {
                        // Pass snapshot explicitly to grab llmState
                        const finalLlmState = (baseSnap as Snapshot)?.llmState;

                        if (typeof finalLlmState !== 'undefined' && llmAny?.importState) {
                            llmAny.importState(finalLlmState);
                            try { console.log('[TaskEngine] Restored LLM history for', agentName); } catch { }
                        }
                    }
                } catch (e) {
                    try { console.log('[TaskEngine] Failed to restore/clear LLM state for', agentName, e); } catch { }
                }
            }
        } catch (e) {
            try { console.log('[TaskEngine] Failed to attach LLM for', agentName, e); } catch { }
        }
    }

    /**
     * Create a basic task context
     */
    private createContext(task: TaskEntity): TaskContext {
        // This is a simplified version - a real implementation would
        // inject all required dependencies like LLM, tools, etc.
        const ctx: TaskContext = {
            tenantId: 'default', // TODO: Get from agent/task context
            agentId: 'default', // TODO: Get from agent/task context
            task: {
                id: task.id,
                input: task.input as TaskInput
            },
            artifacts: {
                create: () => { throw new Error('Artifacts factory not attached'); },
                text: () => { throw new Error('Artifacts factory not attached'); },
                json: () => { throw new Error('Artifacts factory not attached'); }
            },
            // These will be replaced by the streaming context
            reply: async (parts) => {
                const { withSafety } = await import('../loop/effectSafety.js');
                await withSafety(async () => { /* real reply implementation is injected by streaming runner */ }, { timeoutMs: 5000, maxRetries: 1 });
            },
            progress: () => { },
            complete: () => { },
            fail: async () => { },
            // Add stub for recordUsage
            recordUsage: () => { console.warn('recordUsage called on base context'); },
            // Stub implementations for other required properties
            llm: {
                call: async () => [],
                stream: async function* () { },
                addToolResult: () => { },
                updateSettings: () => { }
            } as any,
            tools: {
                invoke: async <T>(toolName: string, args: unknown, options?: { onCompleted?: string; setToken?: boolean; setStage?: string }) => {
                    const { withSafety } = await import('../loop/effectSafety.js');
                    return withSafety(async () => ({} as unknown as T), { timeoutMs: 60000, maxRetries: 2 });
                }
            },
            memory: {
                semantic: {
                    getDefaultBackend: () => 'none',
                    setDefaultBackend: () => { },
                    backends: {},
                    get: async () => null,
                    set: async () => { },
                    read: async () => [],
                    delete: async () => { },
                    remove: async () => 0,
                    recognize: async () => { throw new Error('Semantic memory recognition not available in basic task engine'); },
                    enrich: async () => { throw new Error('Semantic memory enrichment not available in basic task engine'); },
                    add: async () => { },
                    readItems: async () => [],
                    removeItem: async () => { },
                },
                episodic: {
                    getDefaultBackend: () => 'none',
                    setDefaultBackend: () => { },
                    backends: {},
                    append: async () => { },
                    getEvents: async () => [],
                    deleteEvent: async () => { },
                },
                embed: {
                    getDefaultBackend: () => 'none',
                    setDefaultBackend: () => { },
                    backends: {},
                    upsert: async () => { },
                    queryByVector: async () => [],
                    delete: async () => { },
                }
            },
            cognitive: {
                loadWorkingMemory: () => { },
                plan: async () => ({}),
                record: () => { },
                flush: async () => { }
            },
            config: {},
            validate: () => { },
            retry: async (fn) => fn(),
            cache: {
                get: async () => null,
                set: async () => { },
                delete: async () => { }
            },
            emitEvent: async () => { },
            updateStatus: () => { },
            services: { get: () => undefined },
            getEnv: () => undefined,
            throw: (code, message, detail, context) => {
                throwInvariantError(code as InvariantErrorCode, message, detail as InvariantErrorDetail, context);
            },

            sendTaskToAgent: async () => { throw new Error('A2A not available in basic task engine'); },
            requestInput: async () => { throw new Error('requestInput not available in basic task engine'); },
            requestTool: async () => { throw new Error('requestTool not available in basic task engine'); },

            // (legacy methods removed)
            // (legacy goals API removed)
            recall: async () => { throw new Error('Memory not available in basic task engine'); },
            remember: async () => { throw new Error('Memory not available in basic task engine'); }
        };

        // Attach auto-executor for requestTool({ awaitCompletion: false })
        (ctx as any).__autoExecuteTool = async (tId: string, sId: string, token: string, toolName: string, args: unknown) => {
            try {
                let result: unknown;
                // Check if it's an MCP tool call (format: mcp:serverName.toolName)
                if (toolName.startsWith('mcp:')) {
                    const parts = toolName.slice(4).split('.');
                    if (parts.length >= 2) {
                        const serverName = parts[0];
                        const mcpToolName = parts.slice(1).join('.');
                        if (typeof (ctx as any).llm?.callMcpTool === 'function') {
                            result = await (ctx as any).llm.callMcpTool(serverName, mcpToolName, args as any);
                        } else {
                            throw new Error(`MCP execution not supported by current LLM adapter for tool: ${toolName}`);
                        }
                    } else {
                        throw new Error(`Invalid MCP tool name format: ${toolName}. Expected mcp:server.tool`);
                    }
                } else {
                    // Regular tool execution
                    result = await ctx.tools.invoke(toolName, args);
                }

                // Feed result back into the engine using handleToolCompleted
                await this.handleToolCompleted({ tenantId: tId, taskId: sId, token, result });
            } catch (error) {
                // Return error object as the result so the agent sees the failure
                const errorResult = {
                    error: true,
                    message: error instanceof Error ? error.message : String(error)
                };
                await this.handleToolCompleted({ tenantId: tId, taskId: sId, token, result: errorResult });
            }
        };

        // ✅ FIX: Attach session manager reference for loop to reload inbox on await_child
        // This enables the synchronous child completion detection in loopRunner
        (ctx as any)._sessionManager = this.sessionManager;

        return ctx;
    }

    private async restoreCtx(tenantId: string, taskId: string): Promise<TaskContext> {
        const task: TaskEntity = { id: taskId, input: {} };
        const ctx = this.createContext(task);
        (ctx as any).tenantId = tenantId;
        const snap = await this.sessionManager?.load(tenantId, taskId);
        const baseSnap = (snap?.snapshot as Record<string, unknown>) || {};
        // Expose MentalState on durable handler context
        try {
            const M = (baseSnap as any).M as MentalState | undefined;
            (ctx as any).__mental = M || initialM(ctx);
            (ctx as any).M = (ctx as any).__mental; // readonly view for handlers
        } catch { /* noop */ }
        // Reattach LLM for this agent if available AND restore its conversation state
        try {
            const agentName = snap?.agentId;
            if (agentName) {
                const { PluginManager } = await import('../plugin/pluginManager.js');
                const plugin = PluginManager.findAgent(agentName);
                if (plugin?.llmAdapter) {
                    (ctx as any).llm = plugin.llmAdapter;
                } else if (plugin?.llmConfig) {
                    const { createLLMForTask } = await import('../llm/LLMFactory.js');
                    (ctx as any).llm = createLLMForTask(plugin.llmConfig, ctx as any);
                }

                // Restore LLM state immediately after creating/attaching LLM
                try {
                    const llmAny = (ctx as any).llm as any;
                    const llmState = (baseSnap as Snapshot)?.llmState;

                    if (typeof llmState !== 'undefined' && llmAny?.importState) {
                        llmAny.importState(llmState);
                        try { console.log('[TaskEngine] restoreCtx restored LLM history'); } catch { }
                    }
                } catch (e) {
                    try { console.log('[TaskEngine] restoreCtx failed to restore LLM state', e); } catch { }
                }

                // ✅ FIX: Create memory registry with SQL backend for durable handler context
                // This ensures ctx.memory.semantic.backends is properly populated
                try {
                    const { createEmbeddingFunction, isEmbeddingAvailable } = await import('../llm/LLMFactory.js');
                    const embeddingFunction = isEmbeddingAvailable() ? await createEmbeddingFunction() : undefined;

                    // Get Prisma client from session manager or singleton
                    const { getMemoryPrismaClient } = await import('@a2arium/callagent-memory-engine');

                    // Only attempt to use SQL memory if we have a session prisma or a database URL is configured
                    const dbUrl = process.env.MEMORY_DATABASE_URL;
                    if (!dbUrl) throw new Error('MEMORY_DATABASE_URL is required for AgentResultCache');
                    const sessionPrisma = (this.sessionManager as any)?.store?.prisma;

                    if (sessionPrisma || dbUrl) {
                        const existingPrisma = sessionPrisma || await getMemoryPrismaClient();

                        const memoryRegistry = await createMemoryRegistry(
                            tenantId,
                            agentName,
                            ctx,
                            {
                                ...(existingPrisma ? { database: { prismaClient: existingPrisma } } : {}),
                                embeddingFunction
                            }
                        );

                        // Replace the stub memory object with the real one
                        (ctx as any).memory = memoryRegistry;

                        console.log('[TaskEngine] restoreCtx: Memory registry created with backends', {
                            agentName,
                            semanticBackends: Object.keys(memoryRegistry.semantic.backends),
                            hasSet: !!(memoryRegistry.semantic as any)?.set
                        });
                    } else {
                        try { console.log('[TaskEngine] restoreCtx: skipping memory registry initialization (no database config)'); } catch { }
                    }
                } catch (memErr) {
                    console.error('[TaskEngine] restoreCtx: Failed to create memory registry', {
                        error: memErr instanceof Error ? memErr.message : String(memErr),
                        agentName
                    });
                    // Keep the stub memory object if creation fails
                }
            }
            try { console.log('[TaskEngine] restoreCtx LLM type', (ctx as any).llm?.constructor?.name); } catch { }
        } catch { /* ignore LLM reattach failures */ }
        await this.apiBinder.attachOrchestrationAPIs(ctx, {
            tenantId,
            sessionId: taskId,
            agentId: (ctx as any).agentId || snap?.agentId || 'default',
            flushMentalState: async () => {
                await this.flushContextSnapshot(tenantId, taskId, (ctx as any).agentId || snap?.agentId || 'default', ctx);
            }
        });
        // Minimal namespaces for episodic, thoughts, world
        try {
            (ctx as any).episodic = {
                add: (e: any) => {
                    try {
                        const arr = ((((ctx as any).__mental?.memory as any)?.longTerm?.episodic) || []) as any[];
                        arr.push(e); (((ctx as any).__mental!.memory as any).longTerm as any).episodic = arr;
                    } catch { /* noop */ }
                }
            };
            (ctx as any).thoughts = { add: async (t: any) => { try { await (ctx as any).addThought(String((t?.text ?? t) || '')); } catch { /* noop */ } } };
            // Read-only world: deep clone so no shared refs; caller cannot mutate MentalState.worldModel
            const __mental = (ctx as Record<string, unknown>).__mental as { worldModel?: Record<string, unknown> } | undefined;
            const wm = __mental?.worldModel;
            (ctx as Record<string, unknown>).world = {
                read: (): Readonly<Record<string, unknown>> => {
                    if (!wm || typeof wm !== 'object') return Object.freeze({});
                    try {
                        const cloned = JSON.parse(JSON.stringify(wm)) as Record<string, unknown>;
                        return Object.freeze(cloned);
                    } catch {
                        return Object.freeze({ ...wm });
                    }
                }
            };
        } catch { /* noop */ }
        // LLM state restoration now happens immediately after LLM creation above (lines 1551-1564)
        // Ensure restored context can emit streaming events to the same task channel
        try { extendContextWithStreaming(ctx, true); } catch { /* noop */ }
        // Wire Goals API on durable handler context
        try {
            const goals = await import('../loop/goals.js');
            (ctx as any).addGoal = (node: any) => goals.addGoal(ctx as any, node);
            (ctx as any).updateGoal = (id: any, patch: any) => goals.updateGoal(ctx as any, id, patch);
            (ctx as any).moveGoal = (id: any, parentId?: any, order?: any) => goals.moveGoal(ctx as any, id, parentId, order);
            (ctx as any).completeGoal = (id: any, opts?: any) => goals.completeGoal(ctx as any, id, opts);
            (ctx as any).failGoal = (id: any) => goals.failGoal(ctx as any, id);
            (ctx as any).listGoals = (filter?: any) => goals.listGoals(ctx as any, filter);
            // Minimal goals namespace
            (ctx as any).goals = {
                add: (g: any) => goals.addGoal(ctx as any, g),
                update: (id: string, patch: any) => goals.updateGoal(ctx as any, id, patch),
                remove: (id: string) => goals.failGoal(ctx as any, id),
                clear: async (predicate?: (g: any) => boolean) => {
                    const all = await goals.listGoals(ctx as any, {});
                    for (const g of all) { if (!predicate || predicate(g as any)) await goals.failGoal(ctx as any, (g as any).id); }
                },
                read: (filter?: any) => goals.listGoals(ctx as any, filter)
            };
        } catch { /* noop */ }
        // Enable A2A from durable handler context - use the proper TaskEngine sendTaskToAgent implementation
        // NOTE: sendTaskToAgent is already defined in attachOrchestrationAPIs with the correct logic.
        // We do NOT need to override it here anymore.

        return ctx;
    }

    /**
     * Wait for all background task promises to complete
     * Useful for tests to ensure all background work finishes before test cleanup
     * @param timeoutMs Maximum time to wait (default: 5000ms)
     */
    async waitForBackgroundTasks(timeoutMs: number = 5000): Promise<void> {
        const initialCount = this.backgroundTaskPromises.size;
        if (initialCount === 0) {
            if (process.env.DEBUG_BACKGROUND_TASKS) {
                console.log('[TaskEngine] No background tasks to wait for');
            }
            return;
        }

        if (process.env.DEBUG_BACKGROUND_TASKS) {
            console.log(`[TaskEngine] Waiting for ${initialCount} background task(s), timeout=${timeoutMs}ms`);
            console.log(`[TaskEngine] Active handles before wait: ${(process as any)._getActiveHandles?.()?.length ?? 'unknown'}`);
            console.log(`[TaskEngine] Active requests before wait: ${(process as any)._getActiveRequests?.()?.length ?? 'unknown'}`);
        }

        const promises = Array.from(this.backgroundTaskPromises);
        const startTime = Date.now();
        await Promise.race([
            Promise.allSettled(promises),
            new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
        ]);
        const elapsed = Date.now() - startTime;

        const remainingCount = this.backgroundTaskPromises.size;
        if (process.env.DEBUG_BACKGROUND_TASKS) {
            console.log(`[TaskEngine] Wait completed after ${elapsed}ms, remaining promises=${remainingCount}`);
            console.log(`[TaskEngine] Active handles after wait: ${(process as any)._getActiveHandles?.()?.length ?? 'unknown'}`);
            console.log(`[TaskEngine] Active requests after wait: ${(process as any)._getActiveRequests?.()?.length ?? 'unknown'}`);
        }

        // Give a bit more time for async cleanup after promises resolve
        // This ensures resources like Prisma connections are closed
        await new Promise(resolve => setTimeout(resolve, 500));

        if (process.env.DEBUG_BACKGROUND_TASKS) {
            console.log(`[TaskEngine] Active handles after cleanup delay: ${(process as any)._getActiveHandles?.()?.length ?? 'unknown'}`);
            console.log(`[TaskEngine] Active requests after cleanup delay: ${(process as any)._getActiveRequests?.()?.length ?? 'unknown'}`);
        }
    }
}
