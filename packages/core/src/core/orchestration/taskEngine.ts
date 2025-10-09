import type { TaskContext, TaskInput } from '../../shared/types/index.js';
import type { TaskStatus, Artifact } from '../../shared/types/StreamingEvents.js';
import { eventBus } from '../../eventbus/inMemoryEventBus.js';
import { taskChannel } from '../../eventbus/taskEventEmitter.js';
import { extendContextWithStreaming } from '../context/StreamingContext.js';
import { SessionManager } from './SessionManager.js';
import type { IWorkingMemorySessionStore } from '../memory/stores/SessionStore.js';
import { decide } from './reducer.js';
import { applyInputProvided, getPendingInputs, setPendingInputs } from './DurableHandlerRegistry.js';
import type { DurableHandlerInvoker } from './DurableHandlerInvoker.js';
import { DurableHandlerInvokerCore } from './DurableHandlerInvoker.js';
import { InputHandle, createTaskHandle, createGroupHandle, GroupHandle } from './Handles.js';
import { getPendingTasks, setPendingTasks, getPendingGroups, setPendingGroups } from './Handles.js';
import { globalA2AService } from './A2AService.js';
import { v4 as uuidv4 } from 'uuid';
import { outboxPublisher } from '../../eventbus/outboxPublisher.js';
import { createTraceparent } from '../tracing/Tracing.js';
import type { MentalState } from '../../loop/types.js';
import { initialM } from '../../loop/init.js';
import { runLoop } from '../../loop/loopRunner.js';
import type { EnvironmentState } from '../../loop/types.js';
import { getPendingTools, setPendingTools } from './ToolsRegistry.js';
import { getPendingExternalEvents, setPendingExternalEvents } from './ExternalEventsRegistry.js';
import { PluginManager } from '../plugin/pluginManager.js';

/**
 * Task entity with the necessary properties for the task engine
 */
export type TaskEntity = {
    id: string;
    input: unknown;
    status?: TaskStatus;
    artifacts?: Artifact[];
};

/**
 * Parameters for starting a task
 */
export type StartTaskParams = {
    task: TaskEntity;
    isStreaming: boolean;
    agentId?: string;
    tenantId?: string;
    initialContext?: TaskContext; // use prebuilt context when provided
};

/**
 * A minimal task engine that handles task execution
 * This is a simplified implementation that would use XState in a full framework
 */
export class TaskEngine {
    private sessionManager?: SessionManager;
    private handlerInvoker?: DurableHandlerInvoker;

    constructor(opts?: { sessionStore?: IWorkingMemorySessionStore; handlerInvoker?: DurableHandlerInvoker }) {
        if (opts?.sessionStore) this.sessionManager = new SessionManager(opts.sessionStore);
        if (opts?.handlerInvoker) {
            this.handlerInvoker = opts.handlerInvoker;
        } else {
            // Default basic invoker using local restoreCtx
            this.handlerInvoker = new DurableHandlerInvokerCore(this.restoreCtx.bind(this));
        }
        // Ensure outbox publisher is running
        try { outboxPublisher.start(); } catch { /* noop */ }
    }

    // Persist a child's minimal context (e.g., vars) so durable handlers can restore it later
    public async persistChildContext(params: { tenantId: string; sessionId: string; agentId: string; vars?: Record<string, unknown> }): Promise<void> {
        if (!this.sessionManager) return;
        const { tenantId, sessionId, agentId, vars } = params;
        const snap = await this.sessionManager.load(tenantId, sessionId);
        const base = (snap?.snapshot as Record<string, unknown>) || {};
        const M = ((base as any).M || { memory: { vars: {} } }) as any;
        const currentVars = ((M.memory?.vars) || {}) as Record<string, unknown>;
        const nextM = { ...M, memory: { ...(M.memory || {}), vars: { ...currentVars, ...(vars || {}) } } };
        const snapshot = { ...base, M: nextM } as Record<string, unknown>;
        try {
            await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId, expectedWmVersion: BigInt(0), snapshot });
        } catch {
            // best-effort; a later write will win
        }
    }

    // Attach working memory var proxy to an existing context so that writes are CAS-persisted
    public attachWorkingMemory(ctx: TaskContext, tenantId: string, sessionId: string, agentId: string): void {
        if (!this.sessionManager) return;
        const varCache = new Map<string, unknown>();
        (ctx as any).vars = new Proxy({} as Record<string, unknown>, {
            get: (_t, prop: string) => varCache.get(prop),
            set: (_t, prop: string, value: unknown) => {
                varCache.set(prop, value);
                (async () => {
                    try {
                        const snapNow = await this.sessionManager!.load(tenantId, sessionId);
                        const base = (snapNow?.snapshot as Record<string, unknown>) || {};
                        const vars = ((base as any).vars ? { ...(base as any).vars } : {}) as Record<string, unknown>;
                        (vars as any)[prop] = value;
                        const next = { ...base, vars } as Record<string, unknown>;
                        const expected = snapNow?.wmVersion ?? BigInt(0);
                        await this.sessionManager!.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || agentId, expectedWmVersion: expected, snapshot: next });
                        await this.sessionManager!.appendEvent(tenantId, sessionId, 'wm.vars_updated', { key: String(prop) });
                    } catch { /* best-effort */ }
                })();
                return true;
            },
            has: (_t, prop: string) => varCache.has(prop),
            ownKeys: () => Array.from(varCache.keys()),
            getOwnPropertyDescriptor: (_t, prop: string) =>
                varCache.has(prop as string) ? { enumerable: true, configurable: true } : undefined
        });
    }

    // Flush current MentalState (preferred) or fallback vars/llm state into snapshot
    public async flushContextSnapshot(tenantId: string, sessionId: string, agentId: string, ctx: TaskContext): Promise<void> {
        if (!this.sessionManager) return;
        let plainVars: Record<string, unknown> = {};
        try {
            plainVars = JSON.parse(JSON.stringify((ctx as any).vars || {}));
        } catch {
            try { plainVars = { ...(ctx as any).vars } as Record<string, unknown>; } catch { plainVars = {}; }
        }
        // Prepare MentalState if available or compose one minimally
        const baseSnap = ((await this.sessionManager.load(tenantId, sessionId))?.snapshot as Record<string, unknown>) || {};
        let M: any = (baseSnap as any).M;
        if (!M) { try { M = (ctx as any).__mental; } catch { /* noop */ } }
        if (!M) { try { const { initialM } = await import('../../loop/init.js'); M = initialM(ctx); } catch { M = { memory: { vars: {}, sensory: {} }, goalState: { hierarchy: { nodes: {}, roots: [] } } } }; }
        // Merge vars
        try { M.memory = M.memory || {}; M.memory = { ...(M.memory || {}), vars: plainVars }; } catch { /* noop */ }
        // Attach LLM state into sensory
        try {
            const llmAny = (ctx as any).llm as any;
            let llmState: unknown = undefined;
            if (llmAny?.getMessages) {
                const messages = llmAny.getMessages(true);
                llmState = { messages } as unknown;
                try { console.log(`[TaskEngine] flushContextSnapshot messages count: ${Array.isArray(messages) ? messages.length : 'n/a'}`); } catch { }
            } else if (llmAny?.exportState) {
                llmState = llmAny.exportState();
            }
            const sensory = (M.memory as any).sensory || {};
            (M.memory as any).sensory = { ...sensory, llmState };
        } catch { /* ignore */ }
        try {
            const snap = await this.sessionManager.load(tenantId, sessionId);
            const expected = snap?.wmVersion ?? BigInt(0);
            const next = { ...(baseSnap as any), M } as Record<string, unknown>;
            await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || agentId, expectedWmVersion: expected, snapshot: next });
            try { /* saved */ } catch { /* noop */ }
            try { console.log(`[TaskEngine] flushContextSnapshot saved`); } catch { }
        } catch (e) {
            if ((e as Error).message === 'CAS_MISMATCH') {
                try {
                    const snap2 = await this.sessionManager.load(tenantId, sessionId);
                    const expected2 = snap2?.wmVersion ?? BigInt(0);
                    const next2 = { ...(((await this.sessionManager.load(tenantId, sessionId))?.snapshot as any) || {}), M } as Record<string, unknown>;
                    await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || agentId, expectedWmVersion: expected2, snapshot: next2 });
                    try { console.log(`[TaskEngine] flushContextSnapshot saved after retry`); } catch { }
                } catch { /* ignore */ }
            }
        }
    }
    /**
     * Start a task with either streaming or buffered mode
     * @returns The final task entity for buffered mode, or void for streaming mode
     */
    async startTask(params: StartTaskParams): Promise<TaskEntity | void> {
        const { task, isStreaming, agentId, tenantId: startTenantId, initialContext } = params;

        // Use provided context if present, otherwise create a basic one
        const ctx = initialContext ?? this.createContext(task);
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

        // Load session-scoped snapshot if available (tenantId/sessionId assumed on ctx for now)
        const tenantId = (ctx as any).tenantId || startTenantId || 'default';
        const sessionId = task.id;
        const session = await this.sessionManager?.load(tenantId, sessionId);
        // MentalState load (single source of truth)
        const baseSnap = (session?.snapshot as Record<string, unknown>) || {};
        let M: MentalState = (baseSnap as any).M as MentalState || initialM(ctx);
        // Ensure session agentId is correctly set for this task upfront
        try {
            const declaredAgentId = ((ctx as any).agentId || agentId || 'default') as string;
            const currentAgentId = (session as any)?.agentId as string | undefined;
            if (this.sessionManager && declaredAgentId && (!currentAgentId || currentAgentId === 'default')) {
                await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: declaredAgentId, expectedWmVersion: session?.wmVersion ?? BigInt(0), snapshot: baseSnap });
            }
        } catch { /* best-effort */ }
        // One-time migration from legacy snapshot.vars
        try {
            const legacyVars = (baseSnap as any).vars as Record<string, unknown> | undefined;
            const hasVars = M?.memory && (M.memory as any) && Object.keys(((M.memory as any) as any).vars || {}).length > 0;
            if (legacyVars && !hasVars) {
                (M.memory as any) = { ...((M.memory as any) || {}), vars: { ...(legacyVars as Record<string, unknown>) } };
            }
        } catch { /* ignore migration errors */ }
        // Expose MentalState on context for in-turn cognitive operations (e.g., goals API)
        (ctx as any).__mental = M;
        // Build ctx.vars proxy over M.memory.vars with turn-level flush
        const currentVars = ((M.memory as any)?.vars || {}) as Record<string, unknown>;
        const varCache = new Map<string, unknown>(Object.entries(currentVars));
        (ctx as any).__wmVersion = session?.wmVersion;
        (ctx as any).__varsDirty = false;
        const assignVarsIntoMental = () => {
            (M.memory as any) = { ...((M.memory as any) || {}), vars: Object.fromEntries(varCache) };
            (M as any).vars = (M.memory as any).vars;
        };
        const updateLlmInMental = () => {
            try {
                const llmAny = (ctx as any).llm as any;
                let llmState: unknown = undefined;
                if (llmAny?.getMessages) {
                    const messages = llmAny.getMessages(true);
                    llmState = { messages } as unknown;
                } else if (llmAny?.exportState) {
                    llmState = llmAny.exportState();
                }
                const sensory = (M.memory as any).sensory || {};
                (M.memory as any).sensory = { ...sensory, llmState };
            } catch { /* ignore */ }
        };
        const flushMentalState = async () => {
            if (!this.sessionManager) return;
            try {
                assignVarsIntoMental();
                updateLlmInMental();
                const snapNow = await this.sessionManager.load(tenantId, sessionId);
                const base = (snapNow?.snapshot as Record<string, unknown>) || {};
                const next = { ...base, M } as Record<string, unknown>;
                const expected = snapNow?.wmVersion ?? BigInt(0);
                await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || 'default', expectedWmVersion: expected, snapshot: next });
                (ctx as any).__varsDirty = false;
            } catch (e) {
                if ((e as Error).message === 'CAS_MISMATCH') {
                    try {
                        const snapNow2 = await this.sessionManager.load(tenantId, sessionId);
                        const base2 = (snapNow2?.snapshot as Record<string, unknown>) || {};
                        const next2 = { ...base2, M } as Record<string, unknown>;
                        const expected2 = snapNow2?.wmVersion ?? BigInt(0);
                        await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || 'default', expectedWmVersion: expected2, snapshot: next2 });
                        (ctx as any).__varsDirty = false;
                    } catch { /* ignore second failure */ }
                } else {
                    throw e;
                }
            }
        };
        (ctx as any).vars = {
            get: (key: string) => varCache.get(key),
            set: (key: string, value: unknown) => { varCache.set(key, value); (ctx as any).__varsDirty = true; assignVarsIntoMental(); },
            merge: (patch: Record<string, unknown>) => { for (const [k, v] of Object.entries(patch)) varCache.set(k, v); (ctx as any).__varsDirty = true; assignVarsIntoMental(); },
            update: (key: string, fn: (prev: unknown) => unknown) => { const next = fn(varCache.get(key)); varCache.set(key, next); (ctx as any).__varsDirty = true; assignVarsIntoMental(); },
            delete: (key: string) => { varCache.delete(key); (ctx as any).__varsDirty = true; assignVarsIntoMental(); },
            keys: () => Array.from(varCache.keys()),
            has: (key: string) => varCache.has(key)
        } as any;
        // Ensure alias is initialized before loop modules read mentalState.vars
        try { assignVarsIntoMental(); } catch { /* noop */ }

        // Wire Goals API to operate on __mental.goalState
        try {
            const goals = await import('../../loop/goals.js');
            (ctx as any).addGoal = (node: any) => goals.addGoal(ctx as any, node);
            (ctx as any).updateGoal = (id: any, patch: any) => goals.updateGoal(ctx as any, id, patch);
            (ctx as any).moveGoal = (id: any, parentId?: any, order?: any) => goals.moveGoal(ctx as any, id, parentId, order);
            (ctx as any).completeGoal = (id: any, opts?: any) => goals.completeGoal(ctx as any, id, opts);
            (ctx as any).failGoal = (id: any) => goals.failGoal(ctx as any, id);
            (ctx as any).listGoals = (filter?: any) => goals.listGoals(ctx as any, filter);
            // Minimal goals namespace with read helper
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

        // Semantic facade wired to memory.semantic, supporting tags/entities (fail fast on errors)
        if (!(ctx as any).semantic) (ctx as any).semantic = {
            add: async (item: { id: string; value: unknown; tags?: string[]; entities?: Record<string, unknown> }) => {
                await (ctx.memory as any)?.semantic?.set?.(item.id, item.value, { tags: item.tags, entities: item.entities });
            },
            read: async (filter?: { id?: string | string[]; tag?: string; tags?: string[]; limit?: number }) => {
                const res = await (ctx.memory as any)?.semantic?.getMany?.('*');
                const mapped = Array.isArray(res)
                    ? res.map((r: any) => ({ id: r?.key ?? r?.id, value: r?.value, tags: r?.tags, entities: r?.entities }))
                    : [];
                if (!filter) return mapped;
                const byIds = filter.id
                    ? mapped.filter(m => Array.isArray(filter.id) ? filter.id.includes(m.id) : m.id === filter.id)
                    : mapped;
                const tagSet = filter.tags || (filter.tag ? [filter.tag] : undefined);
                const byTags = tagSet && tagSet.length
                    ? byIds.filter(m => {
                        const mt = new Set(m.tags || []);
                        return tagSet!.every(t => mt.has(t));
                    })
                    : byIds;
                return typeof filter.limit === 'number' ? byTags.slice(0, Math.max(0, filter.limit)) : byTags;
            },
            remove: async (idOrPredicate: string | ((item: { id: string; value: unknown; tags?: string[]; entities?: Record<string, unknown> }) => boolean)) => {
                if (typeof idOrPredicate === 'string') {
                    await (ctx.memory as any)?.semantic?.delete?.(idOrPredicate);
                    return;
                }
                const res = await (ctx.memory as any)?.semantic?.getMany?.('*');
                if (!Array.isArray(res)) return;
                for (const r of res) {
                    const item = { id: r?.key ?? r?.id, value: r?.value, tags: r?.tags, entities: r?.entities } as any;
                    if ((idOrPredicate as any)(item)) {
                        await (ctx.memory as any)?.semantic?.delete?.(item.id);
                    }
                }
            }
        };

        // Provide requestInput implementation (non-blocking; persists pending handler and emits input_required)
        // Respect A2A override when parent correlation is present
        if ((ctx as any).__a2aParent || (ctx as any).__preserveRequestInput) {
            // Keep existing override set by A2A; do not replace
            try { (ctx as any).logger?.debug?.('TaskEngine.startTask: preserving A2A requestInput override'); } catch { }
        } else {
            (ctx as any).requestInput = async (prompt: string, opts?: { ttlMs?: number; schema?: unknown; onProvided?: string; onExpired?: string; __existingToken?: string; setToken?: boolean; setStage?: string }) => {
                if (!this.sessionManager) throw new Error('Session manager not configured');
                // Limits: cap max outstanding prompts
                const maxPrompts = 100; // TODO: configurable
                const snapL = await this.sessionManager.load(tenantId, sessionId);
                const baseL = (snapL?.snapshot as Record<string, unknown>) || {};
                const pendingNow = getPendingInputs(baseL);
                if (Object.keys(pendingNow).length >= maxPrompts) {
                    throw new Error('LIMIT_MAX_PROMPTS_EXCEEDED');
                }
                const snap = await this.sessionManager.load(tenantId, sessionId);
                const base = (snap?.snapshot as Record<string, unknown>) || {};
                const token = opts?.__existingToken || uuidv4();
                const expiresAt = opts?.ttlMs ? new Date(Date.now() + opts.ttlMs).toISOString() : undefined;
                const pending = { ...getPendingInputs(base) };

                // Only add to pending if it's a new token request
                if (!opts?.__existingToken) {
                    pending[token] = {
                        schema: opts?.schema,
                        expiresAt,
                        handlerName: opts?.onProvided,
                        expiredHandlerName: opts?.onExpired
                    } as any;
                }
                const writeOnce = async (baseSnap: Record<string, unknown>, expectedVer: bigint) => {
                    try { await flushMentalState(); } catch { /* best-effort */ }
                    // Reload latest snapshot after flush to avoid overwriting newer M
                    const latest = await this.sessionManager!.load(tenantId, sessionId);
                    const latestBase = (latest?.snapshot as Record<string, unknown>) || baseSnap;
                    const nextSnapshot = setPendingInputs(latestBase, pending);
                    const expectedNext = latest?.wmVersion ?? expectedVer;
                    await this.sessionManager!.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || 'default', expectedWmVersion: expectedNext, snapshot: nextSnapshot });
                    await this.sessionManager!.appendEvent(tenantId, sessionId, 'task.input_required', { token, prompt, schema: opts?.schema, expiresAt });
                    await this.sessionManager!.enqueueOutbox(tenantId, 'task.input_required', sessionId, { taskId: sessionId, prompt, token, schema: opts?.schema, expiresAt });
                };
                try {
                    const expected = snap?.wmVersion ?? BigInt(0);
                    await writeOnce(base, expected);
                } catch (e) {
                    if ((e as Error).message === 'CAS_MISMATCH') {
                        try {
                            const snap2 = await this.sessionManager.load(tenantId, sessionId);
                            const base2 = (snap2?.snapshot as Record<string, unknown>) || {};
                            // Merge into latest view
                            const pending2 = { ...getPendingInputs(base2), [token]: { schema: opts?.schema, expiresAt } } as any;
                            const expected2 = snap2?.wmVersion ?? BigInt(0);
                            const next2 = setPendingInputs(base2, pending2);
                            await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || 'default', expectedWmVersion: expected2, snapshot: next2 });
                            await this.sessionManager.appendEvent(tenantId, sessionId, 'task.input_required', { token, prompt, schema: opts?.schema, expiresAt });
                            await this.sessionManager.enqueueOutbox(tenantId, 'task.input_required', sessionId, { taskId: sessionId, prompt, token, schema: opts?.schema, expiresAt });
                        } catch { /* swallow second failure */ }
                    } else {
                        throw e;
                    }
                }
                try { (ctx as any).logger?.info?.('requestInput: input_required emitted', { token, prompt, expiresAt }); } catch { }
                // Emit a streaming status so local runner shows the prompt
                try {
                    ctx.progress({
                        state: 'input-required',
                        message: {
                            role: 'agent',
                            parts: [{ type: 'text', text: `Input required: ${prompt}` }]
                        },
                        timestamp: new Date().toISOString(),
                        metadata: { token }
                    } as any);
                } catch { /* noop */ }
                // Automatic token management (default: true)
                if (opts?.setToken !== false) {
                    ctx.vars.set('token', token);
                }

                // Automatic stage management
                if (opts?.setStage) {
                    try {
                        // Import createStageFacade dynamically to avoid circular deps
                        const { createStageFacade } = await import('../../loop/stageHelpers.js');
                        const Stage = createStageFacade();
                        Stage.setStage(ctx, opts.setStage);
                    } catch (error) {
                        (ctx as any).logger?.warn?.('Failed to auto-set stage', { stage: opts.setStage, error });
                    }
                }

                // Mark that we've persisted WM this turn to avoid duplicate final snapshot
                (ctx as any).__wmSavedThisTurn = true;
                const handle = new InputHandle(this.sessionManager, tenantId, sessionId, token);
                return handle;
            };
        }

        // Provide requestTool implementation for async tool callbacks (non-blocking)
        (ctx as any).requestTool = async (toolName: string, args: unknown, opts?: { onCompleted: string }) => {
            if (!this.sessionManager) throw new Error('Session manager not configured');
            const snap = await this.sessionManager.load(tenantId, sessionId);
            const base = (snap?.snapshot as Record<string, unknown>) || {};
            const token = uuidv4();
            const toolsNow = getPendingTools(base) as any;
            toolsNow[token] = { name: toolName, args, handlers: { completed: opts?.onCompleted } };
            try { await flushMentalState(); } catch { /* best-effort */ }
            const expected = snap?.wmVersion ?? BigInt(0);
            const next = setPendingTools(base, toolsNow);
            await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || 'default', expectedWmVersion: expected, snapshot: next });
            await this.sessionManager.appendEvent(tenantId, sessionId, 'task.tool_requested', { token, toolName });
            // Emit local progress hint
            try {
                ctx.progress({ state: 'working', timestamp: new Date().toISOString(), metadata: { token, toolName, awaiting: 'tool' } } as any);
            } catch { /* noop */ }
            (ctx as any).__wmSavedThisTurn = true;
            return { token } as any;
        };

        // Register an external event to be delivered to a durable handler (turn-boundary interrupt)
        (ctx as any).registerExternalEvent = async (eventType: string, data: unknown, opts?: { onOccurred: string }) => {
            if (!this.sessionManager) throw new Error('Session manager not configured');
            const snap = await this.sessionManager.load(tenantId, sessionId);
            const base = (snap?.snapshot as Record<string, unknown>) || {};
            const token = uuidv4();
            const eventsNow = getPendingExternalEvents(base) as any;
            eventsNow[token] = { type: eventType, data, handlers: { occurred: opts?.onOccurred } };
            try { await flushMentalState(); } catch { /* best-effort */ }
            const expected = snap?.wmVersion ?? BigInt(0);
            const next = setPendingExternalEvents(base, eventsNow);
            await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || 'default', expectedWmVersion: expected, snapshot: next });
            await this.sessionManager.appendEvent(tenantId, sessionId, 'task.external_event_registered', { token, eventType });
            (ctx as any).__wmSavedThisTurn = true;
            return { token } as any;
        };

        (ctx as any).sendTaskToAgent = async (agent: string, childInput: unknown, options?: { awaitCompletion?: boolean; streaming?: boolean; onCompleted?: string; onFailed?: string; onInputRequired?: string }) => {
            if (!this.sessionManager) throw new Error('Session manager not configured');
            // Limits: cap max children
            const maxChildren = 50; // TODO: make configurable
            const snapLimits = await this.sessionManager.load(tenantId, sessionId);
            const baseLimits = (snapLimits?.snapshot as Record<string, unknown>) || {};
            const tasksNow = getPendingTasks(baseLimits);
            if (Object.keys(tasksNow).length >= maxChildren) {
                throw new Error('LIMIT_MAX_CHILDREN_EXCEEDED');
            }
            // Persist pending child mapping and return a handle; do not dispatch yet
            const { handle, token } = await createTaskHandle(this.sessionManager, tenantId, sessionId, agent, childInput);
            // If handler names provided, register them atomically before dispatch
            if (options?.onInputRequired) { try { await (handle as any).onInputRequired(options.onInputRequired); } catch { } }
            if (options?.onCompleted) { try { await (handle as any).onCompleted(options.onCompleted); } catch { } }
            if (options?.onFailed) { try { await (handle as any).onFailed(options.onFailed); } catch { } }
            const minimalCtx = ctx as any; // current task context as source
            // Inject dispatcher to be executed on handle.run()
            const dispatch = async (runOpts?: { awaitCompletion?: boolean; streaming?: boolean }) => {
                (ctx as any).logger?.info?.('Child dispatch', { parentTaskId: sessionId, childAgent: agent, token });
                try { await flushMentalState(); } catch { /* best-effort */ }
                const a2aOptions = { tenantId, streaming: (runOpts?.streaming ?? options?.streaming) === true } as any;
                try { console.log(`[TaskEngine] sendTaskToAgent dispatch: tenantId=${tenantId} sessionId=${sessionId} token=${token} agent=${agent}`); } catch { }
                try {
                    const result = await globalA2AService.sendTaskToAgent(minimalCtx, agent, childInput as any, {
                        ...(options || {}),
                        ...a2aOptions,
                        parentTenantId: tenantId,
                        parentTaskId: sessionId,
                        parentChildToken: token
                    } as any);
                    // If child requested input, do not synthesize completion
                    if (result && typeof result === 'object' && (result as any).status === 'input_required') {
                        (ctx as any).logger?.info?.('Child input_required', { parentTaskId: sessionId, childAgent: agent, token });
                        return;
                    }
                    // Determine await behavior: default to true when no completed handler is registered
                    const snapNow = await this.sessionManager!.load(tenantId, sessionId);
                    const baseNow = (snapNow?.snapshot as Record<string, unknown>) || {};
                    const tasksNow2 = getPendingTasks(baseNow) as any;
                    const entry = tasksNow2[token];
                    const hasCompleted = !!entry?.handlers?.completed;
                    const awaitCompletion = runOpts?.awaitCompletion ?? options?.awaitCompletion ?? (!hasCompleted);
                    if (awaitCompletion) {
                        await this.handleChildCompleted({ tenantId, parentTaskId: sessionId, childToken: token, result });
                        return result;
                    }
                    return;
                } catch (e) {
                    (ctx as any).logger?.error?.('Child dispatch failed', e, { parentTaskId: sessionId, childAgent: agent, token });
                    await this.sessionManager!.enqueueOutbox(tenantId, 'task.child_dispatch', sessionId, {
                        taskId: sessionId,
                        childAgent: agent,
                        error: e instanceof Error ? e.message : String(e)
                    });
                    return;
                }
            };
            // Auto-dispatch now; if no onCompleted registered, return result synchronously
            const result = await dispatch({});
            return result ?? handle;
        };

        // Group orchestration API: allTasks
        (ctx as any).allTasks = async (children: Array<{ agent: string; input: unknown }>, opts?: { withTimeoutMs?: number; cancelRemaining?: boolean; onAllCompleted?: string; onAnyFailed?: string }) => {
            if (!this.sessionManager) throw new Error('Session manager not configured');
            // Limits: cap max group size
            const maxGroup = 50; // TODO: make configurable
            if (children.length > maxGroup) throw new Error('LIMIT_MAX_GROUP_CHILDREN_EXCEEDED');
            // create N child handles and dispatch
            const childTokens: string[] = [];
            for (const child of children) {
                const { handle, token } = await createTaskHandle(this.sessionManager, tenantId, sessionId, child.agent);
                childTokens.push(token);
                // fire-and-forget child dispatch
                globalA2AService.sendTaskToAgent(ctx as any, child.agent, child.input as any, {
                    tenantId,
                    parentTenantId: tenantId,
                    parentTaskId: sessionId,
                    parentChildToken: token
                } as any).catch(async (e) => {
                    await this.sessionManager!.enqueueOutbox(tenantId, 'task.child_dispatch', sessionId, {
                        taskId: sessionId,
                        childAgent: child.agent,
                        error: e instanceof Error ? e.message : String(e)
                    });
                });
            }
            const { handle: groupHandle, groupToken } = await createGroupHandle(this.sessionManager, tenantId, sessionId, childTokens);
            // store timeout/cancel policies
            const snap = await this.sessionManager.load(tenantId, sessionId);
            const base = (snap?.snapshot as Record<string, unknown>) || {};
            const groups = getPendingGroups(base);
            const g = groups[groupToken] || { childTokens: childTokens, results: {}, handlers: {} };
            if (opts?.withTimeoutMs) g.timeoutMs = opts.withTimeoutMs;
            if (opts?.cancelRemaining !== undefined) g.cancelRemaining = opts.cancelRemaining;
            if (opts?.onAllCompleted) { g.handlers = g.handlers || {}; (g.handlers as any).allCompleted = opts.onAllCompleted; }
            if (opts?.onAnyFailed) { g.handlers = g.handlers || {}; (g.handlers as any).anyFailed = opts.onAnyFailed; }
            groups[groupToken] = g;
            const next = setPendingGroups(base, groups);
            await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: (base as any)?.meta?.agentId || 'default', expectedWmVersion: snap?.wmVersion ?? BigInt(0), snapshot: next });
            return groupHandle as GroupHandle;
        };

        // Append start event and publish status via outbox; reducer entrypoint
        const traceparent = createTraceparent();
        await this.sessionManager?.appendEvent(tenantId, sessionId, 'task.started', { taskId: sessionId, traceparent });
        await this.sessionManager?.enqueueOutbox(tenantId, 'task.status', sessionId, { taskId: sessionId, status: { state: 'working', timestamp: new Date().toISOString() }, traceparent });
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
        if (!(ctx as any).runMode) { (ctx as any).runMode = 'loop'; }

        try {
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
            const runMode: 'loop' | 'legacy' = (ctx as any).runMode || 'loop';
            try { console.log(`[TaskEngine] runMode=${runMode} agentId=${(ctx as any).agentId}`); } catch { }

            const runLegacy = async () => {
                if (isStreaming) {
                    this.executeTaskHandler(ctx).catch(error => {
                        console.error('Task handler error:', error);
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
                // Build EnvironmentState from snapshot and context
                const base = (session?.snapshot as any) || {};
                const startTurnTotal = Number(base?.meta?.turn) || 0;
                const env: EnvironmentState = {
                    time: new Date().toISOString(),
                    input: ctx.task.input,
                    sessionId,
                    turn: startTurnTotal + 1,
                    pending: {
                        inputs: (base?.pending?.inputs) || {},
                        children: (base?.pending?.children) || {},
                        tools: (base?.pending?.tools) || {},
                        groups: (base?.pending?.groups) || {}
                    },
                    lastExec: (base?.meta?.lastExec) || undefined,
                    externalEvents: undefined
                };
                // Load agent plugin and get agent-local loop module overrides
                const agentId = (ctx as any).agentId;
                const plugin = agentId ? PluginManager.findAgent(agentId) : null;
                const overrides = (plugin as any)?.loop?.modules || {};
                try {
                    console.log(`[TaskEngine] plugin keys:`, Object.keys((plugin as any) || {}));
                    console.log(`[TaskEngine] plugin.loop:`, (plugin as any)?.loop ? 'present' : 'absent');
                    console.log(`[TaskEngine] loop module keys from agent '${agentId}': ${Object.keys(overrides).join(',') || '(none)'}`);
                } catch { }
                // Derive default budgets and hitl from manifest if available
                let loopOpts: { maxTurns?: number; latencyMs?: number } = {};
                try {
                    const b = (plugin?.manifest as any)?.budgets;
                    const hitl = (plugin?.manifest as any)?.hitl;
                    if (hitl) { try { (M as any).hitl = hitl; } catch { /* noop */ } }
                    if (isStreaming && b && typeof b === 'object') loopOpts = { maxTurns: (b as any).maxTurns, latencyMs: (b as any).latencyMs };
                } catch { /* ignore */ }
                console.log('loopOpts:', loopOpts);
                const { M: mNext, outcome, metrics } = await runLoop(ctx, M, env, overrides, loopOpts);
                // Ensure meta.turn is persisted after initial runLoop
                try {
                    if (this.sessionManager) {
                        const snapAfterStart = await this.sessionManager.load(tenantId, sessionId);
                        const expectedAfterStart = (snapAfterStart?.wmVersion ?? BigInt(0)) as bigint;
                        const baseAfterStart = ((snapAfterStart?.snapshot as Record<string, unknown>) || {}) as Record<string, unknown>;
                        const prevMetaAfterStart = ((baseAfterStart as any).meta || {}) as Record<string, unknown>;
                        const turnToSave = Number((env as any).turn) || 1;
                        const nextMetaAfterStart = { ...prevMetaAfterStart, turn: turnToSave } as Record<string, unknown>;
                        const nextAfterStart = { ...baseAfterStart, M: (baseAfterStart as any).M ?? mNext, meta: nextMetaAfterStart } as Record<string, unknown>;
                        await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: ((ctx as any).agentId || 'default') as string, expectedWmVersion: expectedAfterStart, snapshot: nextAfterStart });
                    }
                } catch { /* noop */ }
                console.log('Outcome from runLoop:', outcome.kind);
                console.log('Outcome details:', outcome, 'kind type:', typeof outcome.kind, 'kind value:', outcome.kind);
                // Aggregate metrics for convenience
                const timingsArray = metrics?.timings || [];
                const rewardsArray = metrics?.rewards || [];
                const timingsAgg = (() => {
                    if (!timingsArray.length) return undefined;
                    const keys = new Set<string>();
                    for (const t of timingsArray) Object.keys(t).forEach(k => keys.add(k));
                    const result: Record<string, { sum: number; avg: number }> = {};
                    for (const k of keys) {
                        let s = 0; let c = 0;
                        for (const t of timingsArray) {
                            const v = (t as any)[k];
                            if (typeof v === 'number' && Number.isFinite(v)) { s += v; c += 1; }
                        }
                        if (c > 0) result[k] = { sum: s, avg: s / c };
                    }
                    return result;
                })();
                const rewardsAgg = (() => {
                    if (!rewardsArray.length) return undefined;
                    const sum = rewardsArray.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
                    const avg = sum / rewardsArray.length;
                    return { sum, avg };
                })();
                // Persist MentalState at the end of this invocation if not already saved
                if (this.sessionManager) {
                    try {
                        if (!(ctx as any).__wmSavedThisTurn) {
                            // Ensure ctx.vars writes are merged into MentalState before saving
                            try {
                                const vars = (ctx as any).vars;
                                if (vars && typeof vars === 'object') {
                                    const st = ((mNext as any)?.memory) || {};
                                    (mNext as any).memory = { ...st, vars: { ...(st.vars || {}), ...(vars as Record<string, unknown>) } };
                                }
                            } catch { /* noop */ }
                            // Apply hygiene caps before saving to bound snapshot size
                            try {
                                const { pruneMentalState } = await import('../../loop/hygiene.js');
                                pruneMentalState(mNext);
                            } catch { /* noop */ }
                            const snapNow = await this.sessionManager.load(tenantId, sessionId);
                            const expected = snapNow?.wmVersion ?? BigInt(0);
                            const baseNow = (snapNow?.snapshot as Record<string, unknown>) || {};
                            const prevMeta = (baseNow as any).meta || {};
                            const nextMeta = { ...prevMeta, turn: env.turn };
                            const next = { ...baseNow, M: mNext, meta: nextMeta } as Record<string, unknown>;
                            await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || 'default', expectedWmVersion: expected, snapshot: next });
                        } else {
                            // Even if M was saved earlier in the turn, increment turnTotal meta
                            const snapNow = await this.sessionManager.load(tenantId, sessionId);
                            const expected = snapNow?.wmVersion ?? BigInt(0);
                            const baseNow = (snapNow?.snapshot as Record<string, unknown>) || {};
                            const prevMeta = (baseNow as any).meta || {};
                            const nextMeta = { ...prevMeta, turn: env.turn };
                            const next = { ...baseNow, meta: nextMeta } as Record<string, unknown>;
                            await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || 'default', expectedWmVersion: expected, snapshot: next });
                        }
                    } catch { /* noop */ }
                }
                console.log('isStreaming:', isStreaming);
                if (!isStreaming) {
                    if (outcome.kind === 'await_input') {
                        console.log('Handling outcome: await_input');
                        task.status = { state: 'input-required', timestamp: new Date().toISOString(), metadata: { token: outcome.token, awaitExtra: { kind: outcome.kind }, timings: metrics?.timings, rewards: metrics?.rewards, timingsAgg, rewardsAgg } } as any;
                        return task;
                    }
                    if (outcome.kind === 'await_child' || outcome.kind === 'await_tool') {
                        console.log('Handling outcome: await_child or await_tool');
                        const token = (outcome as any).token;
                        const extra = { kind: outcome.kind, token };
                        task.status = { state: 'working', timestamp: new Date().toISOString(), metadata: { awaiting: outcome.kind, token, awaitExtra: extra, timings: metrics?.timings, rewards: metrics?.rewards, timingsAgg, rewardsAgg } } as any;
                        return task;
                    }
                    if (outcome.kind === 'fail') {
                        console.log('Handling outcome: fail, reason:', outcome.reason);
                        task.status = {
                            state: 'failed',
                            timestamp: new Date().toISOString(),
                            message: { role: 'agent', parts: [{ type: 'text', text: `Loop failed: ${outcome.reason}` }] },
                            metadata: { reason: outcome.reason, timings: metrics?.timings, rewards: metrics?.rewards, timingsAgg, rewardsAgg }
                        } as any;
                        return task;
                    }
                    if (outcome.kind === 'complete') {
                        console.log('Handling outcome: complete');
                        task.status = {
                            state: 'completed',
                            timestamp: new Date().toISOString(),
                            metadata: { result: outcome.result, timings: metrics?.timings, rewards: metrics?.rewards, timingsAgg, rewardsAgg }
                        } as any;
                        return task;
                    }
                }
                // Fall through to completion artifacts handling below
            }

            // After handler: flush MentalState once (skip if already flushed earlier in this turn)
            if (this.sessionManager && !(ctx as any).__wmSavedThisTurn) {
                try { await flushMentalState(); } catch (e) {
                    if ((e as Error).message === 'LIMIT_WM_SNAPSHOT_TOO_LARGE') {
                        await this.sessionManager.appendEvent(tenantId, sessionId, 'wm.snapshot_limit', { size: 'unknown' });
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
                return task;
            }

            // Append completed event and publish status via outbox
            await this.sessionManager?.appendEvent(tenantId, sessionId, 'task.completed', {
                taskId: sessionId,
                artifactsCount: Array.isArray(task.artifacts) ? task.artifacts.length : 0,
                traceparent
            });
            await this.sessionManager?.enqueueOutbox(tenantId, 'task.status', sessionId, {
                taskId: sessionId,
                status: { state: 'completed', timestamp: new Date().toISOString() },
                final: true,
                traceparent
            });

            // Return the updated task
            return task;
        } catch (error) {
            console.error('Task engine error:', error);

            // Set failure status for non-streaming mode
            if (!isStreaming) {
                task.status = {
                    state: 'failed',
                    message: {
                        role: 'agent',
                        parts: [
                            { type: 'text', text: `Task execution failed: ${error instanceof Error ? error.message : String(error)}` }
                        ]
                    },
                    timestamp: new Date().toISOString()
                };
                return task;
            }

            // Append failed event and publish status via outbox
            await this.sessionManager?.appendEvent(tenantId, sessionId, 'task.failed', {
                taskId: sessionId,
                error: error instanceof Error ? error.message : String(error),
                traceparent
            });
            await this.sessionManager?.enqueueOutbox(tenantId, 'task.status', sessionId, {
                taskId: sessionId,
                status: {
                    state: 'failed',
                    message: { role: 'agent', parts: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] },
                    timestamp: new Date().toISOString()
                },
                final: true,
                traceparent
            });

            // For streaming, emit a failure event directly
            eventBus.publish(taskChannel(task.id), {
                id: task.id,
                status: {
                    state: 'failed',
                    message: {
                        role: 'agent',
                        parts: [
                            { type: 'text', text: `Task execution failed: ${error instanceof Error ? error.message : String(error)}` }
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
        const { tenantId, taskId, token, input } = params;
        // load snapshot
        const snap = await this.sessionManager?.load(tenantId, taskId);
        if (!snap) {
            throw new Error('SESSION_NOT_FOUND');
        }
        const base = (snap.snapshot as Record<string, unknown>) || {};
        // Validate token existence/expiry
        try {
            const pend = getPendingInputs(base) as any;
            const entry = pend[token];
            if (!entry) throw new Error('INPUT_TOKEN_NOT_FOUND');
            if (entry.expiresAt && Date.parse(entry.expiresAt) < Date.now()) throw new Error('INPUT_TOKEN_EXPIRED');
        } catch (e) {
            throw e instanceof Error ? e : new Error('INPUT_TOKEN_INVALID');
        }
        const { next } = applyInputProvided(base, token, input);
        const expected = snap?.wmVersion ?? BigInt(0);
        await this.sessionManager?.appendEvent(tenantId, taskId, 'task.input_provided', { token });
        await this.sessionManager?.saveSnapshot({ tenantId, sessionId: taskId, agentId: (next as any).meta?.agentId || 'default', expectedWmVersion: expected, snapshot: next });
        await this.sessionManager?.enqueueOutbox(tenantId, 'task.status', taskId, { taskId, status: { state: 'working', timestamp: new Date().toISOString() }, metadata: { inputProvided: true } });
        // Always auto-resume one loop turn to consume the provided input
        try {
            const agentName = (snap as any)?.agentId;
            const plugin = agentName ? PluginManager.findAgent(agentName) : null;
            // Build minimal context for this resume turn
            const ctx = this.createContext({ id: taskId, input: {} });
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
                (ctx as any).requestInput = async (prompt: string, opts?: { ttlMs?: number; schema?: unknown; onProvided?: string; onExpired?: string; __existingToken?: string; setToken?: boolean; setStage?: string }) => {
                    if (!this.sessionManager) throw new Error('Session manager not configured');
                    // Limits: cap max outstanding prompts
                    const maxPrompts = 100;
                    const snapL = await this.sessionManager.load(tenantId, sessionId);
                    const baseL = (snapL?.snapshot as Record<string, unknown>) || {};
                    const pendingNow = getPendingInputs(baseL);
                    if (Object.keys(pendingNow).length >= maxPrompts) {
                        throw new Error('LIMIT_MAX_PROMPTS_EXCEEDED');
                    }
                    const snap = await this.sessionManager.load(tenantId, sessionId);
                    const base = (snap?.snapshot as Record<string, unknown>) || {};
                    const token = opts?.__existingToken || uuidv4();
                    const expiresAt = opts?.ttlMs ? new Date(Date.now() + opts.ttlMs).toISOString() : undefined;
                    const pending = { ...getPendingInputs(base) };

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
                            const M = ((await this.sessionManager!.load(tenantId, sessionId))?.snapshot as any)?.M;
                            if (M) {
                                const llmStateFromM = (((M.memory as any)?.sensory as any)?.llmState);
                                const llmAny = (ctx as any).llm as any;
                                if (typeof llmStateFromM === 'undefined' && llmAny?.exportState) {
                                    const exported = llmAny.exportState();
                                    if (M.memory) {
                                        (M.memory as any).sensory = (M.memory as any).sensory || {};
                                        (M.memory as any).sensory.llmState = exported;
                                    }
                                }
                            }
                        } catch { /* noop */ }
                    };
                    const writeOnce = async (baseSnap: Record<string, unknown>, expectedVer: bigint) => {
                        try { await flushMentalState(); } catch { /* best-effort */ }
                        const latest = await this.sessionManager!.load(tenantId, sessionId);
                        const latestBase = (latest?.snapshot as Record<string, unknown>) || baseSnap;
                        const nextSnapshot = setPendingInputs(latestBase, pending);
                        const expectedNext = latest?.wmVersion ?? expectedVer;
                        await this.sessionManager!.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || 'default', expectedWmVersion: expectedNext, snapshot: nextSnapshot });
                        await this.sessionManager!.appendEvent(tenantId, sessionId, 'task.input_required', { token, prompt, schema: opts?.schema, expiresAt });
                        await this.sessionManager!.enqueueOutbox(tenantId, 'task.input_required', sessionId, { taskId: sessionId, prompt, token, schema: opts?.schema, expiresAt });
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
                                const next2 = setPendingInputs(base2, pending2);
                                await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || 'default', expectedWmVersion: expected2, snapshot: next2 });
                                await this.sessionManager.appendEvent(tenantId, sessionId, 'task.input_required', { token, prompt, schema: opts?.schema, expiresAt });
                                await this.sessionManager.enqueueOutbox(tenantId, 'task.input_required', sessionId, { taskId: sessionId, prompt, token, schema: opts?.schema, expiresAt });
                            } catch { /* swallow second failure */ }
                        } else {
                            throw e;
                        }
                    }
                    try { (ctx as any).logger?.info?.('requestInput: input_required emitted', { token, prompt, expiresAt }); } catch { }
                    try {
                        ctx.progress({
                            state: 'input-required',
                            message: {
                                role: 'agent',
                                parts: [{ type: 'text', text: `Input required: ${prompt}` }]
                            },
                            timestamp: new Date().toISOString(),
                            metadata: { token }
                        } as any);
                    } catch { /* noop */ }
                    // Automatic token management (default: true)
                    if (opts?.setToken !== false) {
                        ctx.vars.set('token', token);
                    }

                    // Automatic stage management
                    if (opts?.setStage) {
                        try {
                            // Import createStageFacade dynamically to avoid circular deps
                            const { createStageFacade } = await import('../../loop/stageHelpers.js');
                            const Stage = createStageFacade();
                            Stage.setStage(ctx, opts.setStage);
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
            // Attach and restore LLM before running loop
            await this.attachAndRestoreLLM(ctx, agentName, M);
            // Reattach working variables facade linked to this MentalState (resume path)
            try {
                const currentVars = ((M as any)?.memory?.vars || {}) as Record<string, unknown>;
                const varCache = new Map<string, unknown>(Object.entries(currentVars));
                const assignVarsIntoMental = () => {
                    (M as any).memory = (M as any).memory || {};
                    (M as any).memory = {
                        ...(((M as any).memory || {}) || {}),
                        vars: Object.fromEntries(varCache)
                    };
                    (M as any).vars = (M as any).memory.vars;
                };
                (ctx as any).vars = {
                    get: (key: string) => varCache.get(key),
                    set: (key: string, value: unknown) => { varCache.set(key, value); assignVarsIntoMental(); },
                    merge: (patch: Record<string, unknown>) => { for (const [k, v] of Object.entries(patch)) varCache.set(k, v); assignVarsIntoMental(); },
                    update: (key: string, fn: (prev: unknown) => unknown) => { const next = fn(varCache.get(key)); varCache.set(key, next); assignVarsIntoMental(); },
                    delete: (key: string) => { varCache.delete(key); assignVarsIntoMental(); },
                    keys: () => Array.from(varCache.keys()),
                    has: (key: string) => varCache.has(key)
                } as any;
            } catch { /* noop */ }
            const env: EnvironmentState = {
                time: new Date().toISOString(),
                input: { kind: 'input', token, value: input },
                pending: {
                    inputs: ((baseNow as any)?.pending?.inputs) || {},
                    children: ((baseNow as any)?.pending?.children) || {},
                    tools: ((baseNow as any)?.pending?.tools) || {},
                    groups: ((baseNow as any)?.pending?.groups) || {}
                },
                lastExec: (baseNow as any)?.meta?.lastExec || undefined,
                externalEvents: undefined
            } as EnvironmentState;
            // Ensure input token is reflected in working variables for this resume turn
            try {
                const st = ((((M as any).memory || {})) || {}) as any;
                const v = { ...(st.vars || {}) } as Record<string, unknown>;
                if (typeof v.inputToken === 'undefined') {
                    v.inputToken = token;
                    if ((M as any).memory) (M as any).memory = { ...st, vars: v };
                    (ctx as any).vars?.set?.('inputToken', token);
                }
            } catch { /* noop */ }
            const overrides = (plugin as any)?.loop?.modules || (plugin as any)?.loop || {};
            // Budgets
            let loopOpts: { maxTurns?: number; latencyMs?: number } = {};
            try {
                const b = (plugin?.manifest as any)?.budgets;
                const hitl = (plugin?.manifest as any)?.hitl;
                if (hitl) { try { (M as any).hitl = hitl; } catch { } }
                if (b && typeof b === 'object') loopOpts = { maxTurns: (b as any).maxTurns, latencyMs: (b as any).latencyMs };
            } catch { }
            const { M: mNext, outcome, metrics } = await runLoop(ctx, M, env, overrides, loopOpts);
            // Persist updated M
            try {
                const snapAfter = await this.sessionManager!.load(tenantId, taskId);
                const expectedNow = snapAfter?.wmVersion ?? BigInt(0);
                const baseSnap = (snapAfter?.snapshot as Record<string, unknown>) || {};
                const nextSnap = { ...baseSnap, M: mNext } as Record<string, unknown>;
                await this.sessionManager!.saveSnapshot({ tenantId, sessionId: taskId, agentId: agentName || 'default', expectedWmVersion: expectedNow, snapshot: nextSnap });
            } catch { /* noop */ }
            // Emit status event for the resumed turn
            const channel = taskChannel(taskId);
            const status: TaskStatus = (() => {
                if (outcome.kind === 'await_input') return { state: 'input-required', timestamp: new Date().toISOString(), metadata: { token: (outcome as any).token, awaitExtra: { kind: outcome.kind }, timings: metrics?.timings, rewards: metrics?.rewards } } as any;
                if (outcome.kind === 'await_child' || outcome.kind === 'await_tool') return { state: 'working', timestamp: new Date().toISOString(), metadata: { awaiting: outcome.kind, token: (outcome as any).token, awaitExtra: { kind: outcome.kind } } } as any;
                if (outcome.kind === 'fail') return { state: 'failed', timestamp: new Date().toISOString(), message: { role: 'agent', parts: [{ type: 'text', text: `Loop failed: ${outcome.reason}` }] }, metadata: { reason: outcome.reason } } as any;
                if (outcome.kind === 'complete') return { state: 'completed', timestamp: new Date().toISOString(), metadata: { result: (outcome as any).result } } as any;
                return { state: 'working', timestamp: new Date().toISOString() } as any;
            })();
            try { eventBus.publish(channel, { id: taskId, status, final: status.state === 'completed' || status.state === 'failed' } as any); } catch { }
        } catch { /* swallow resume errors to avoid blocking ack */ }
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
        const next = setPendingTools(base, tools);
        await this.sessionManager?.saveSnapshot({ tenantId, sessionId: taskId, agentId: (base as any)?.meta?.agentId || 'default', expectedWmVersion: snap.wmVersion ?? BigInt(0), snapshot: next });
        await this.sessionManager?.appendEvent(tenantId, taskId, 'task.tool_completed', { token });
        // Always auto-resume one loop turn to consume the tool result
        try {
            const agentName = (snap as any)?.agentId;
            const plugin = agentName ? PluginManager.findAgent(agentName) : null;
            const ctx = this.createContext({ id: taskId, input: {} });
            (ctx as any).tenantId = tenantId; if (agentName) (ctx as any).agentId = agentName;
            const snapNow = await this.sessionManager!.load(tenantId, taskId);
            const baseNow = (snapNow?.snapshot as Record<string, unknown>) || {};
            let M: MentalState = (baseNow as any).M as MentalState || initialM(ctx);
            // Attach and restore LLM before running loop
            await this.attachAndRestoreLLM(ctx, agentName, M);
            const startTurnTool = Number((baseNow as any)?.meta?.turn) || 0;
            const env: EnvironmentState = {
                time: new Date().toISOString(),
                input: { kind: 'tool', token, result },
                sessionId: taskId,
                turn: startTurnTool + 1,
                pending: {
                    inputs: ((baseNow as any)?.pending?.inputs) || {},
                    children: ((baseNow as any)?.pending?.children) || {},
                    tools: ((baseNow as any)?.pending?.tools) || {},
                    groups: ((baseNow as any)?.pending?.groups) || {}
                },
                lastExec: (baseNow as any)?.meta?.lastExec || undefined,
                externalEvents: undefined
            } as EnvironmentState;
            const overrides = (plugin as any)?.loop?.modules || (plugin as any)?.loop || {};
            let loopOpts: { maxTurns?: number; latencyMs?: number } = {};
            try {
                const b = (plugin?.manifest as any)?.budgets; const hitl = (plugin?.manifest as any)?.hitl;
                if (hitl) { try { (M as any).hitl = hitl; } catch { } }
                if (b && typeof b === 'object') loopOpts = { maxTurns: (b as any).maxTurns, latencyMs: (b as any).latencyMs };
            } catch { }
            const { M: mNext, outcome, metrics } = await runLoop(ctx, M, env, overrides, loopOpts);
            // Persist and emit status
            try {
                const snapAfter = await this.sessionManager!.load(tenantId, taskId);
                const expectedNow = snapAfter?.wmVersion ?? BigInt(0);
                const baseSnap = (snapAfter?.snapshot as Record<string, unknown>) || {};
                const nextSnap = { ...baseSnap, M: mNext } as Record<string, unknown>;
                await this.sessionManager!.saveSnapshot({ tenantId, sessionId: taskId, agentId: agentName || 'default', expectedWmVersion: expectedNow, snapshot: nextSnap });
            } catch { /* noop */ }
            const channel = taskChannel(taskId);
            const status: TaskStatus = (() => {
                if (outcome.kind === 'await_input') return { state: 'input-required', timestamp: new Date().toISOString(), metadata: { token: (outcome as any).token, awaitExtra: { kind: outcome.kind }, timings: metrics?.timings, rewards: metrics?.rewards } } as any;
                if (outcome.kind === 'await_child' || outcome.kind === 'await_tool') return { state: 'working', timestamp: new Date().toISOString(), metadata: { awaiting: outcome.kind, token: (outcome as any).token, awaitExtra: { kind: outcome.kind } } } as any;
                if (outcome.kind === 'fail') return { state: 'failed', timestamp: new Date().toISOString(), message: { role: 'agent', parts: [{ type: 'text', text: `Loop failed: ${outcome.reason}` }] }, metadata: { reason: outcome.reason } } as any;
                if (outcome.kind === 'complete') return { state: 'completed', timestamp: new Date().toISOString(), metadata: { result: (outcome as any).result } } as any;
                return { state: 'working', timestamp: new Date().toISOString() } as any;
            })();
            try { eventBus.publish(channel, { id: taskId, status, final: status.state === 'completed' || status.state === 'failed' } as any); } catch { }
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
        const next = setPendingExternalEvents(base, events);
        await this.sessionManager?.saveSnapshot({ tenantId, sessionId: taskId, agentId: (base as any)?.meta?.agentId || 'default', expectedWmVersion: snap.wmVersion ?? BigInt(0), snapshot: next });
        await this.sessionManager?.appendEvent(tenantId, taskId, 'task.external_event_occurred', { token, type: entry?.type });
        // Always auto-resume one loop turn to consume the external event
        try {
            const agentName = (snap as any)?.agentId;
            const plugin = agentName ? PluginManager.findAgent(agentName) : null;
            const ctx = this.createContext({ id: taskId, input: {} });
            (ctx as any).tenantId = tenantId; if (agentName) (ctx as any).agentId = agentName;
            const snapNow = await this.sessionManager!.load(tenantId, taskId);
            const baseNow = (snapNow?.snapshot as Record<string, unknown>) || {};
            let M: MentalState = (baseNow as any).M as MentalState || initialM(ctx);
            // Attach and restore LLM before running loop
            await this.attachAndRestoreLLM(ctx, agentName, M);
            const startTurnTotal = Number((baseNow as any)?.meta?.turn) || 0;
            const env: EnvironmentState = {
                time: new Date().toISOString(),
                input: { kind: 'event', token, payload, type: entry?.type },
                sessionId: taskId,
                turn: startTurnTotal + 1,
                pending: {
                    inputs: ((baseNow as any)?.pending?.inputs) || {},
                    children: ((baseNow as any)?.pending?.children) || {},
                    tools: ((baseNow as any)?.pending?.tools) || {},
                    groups: ((baseNow as any)?.pending?.groups) || {}
                },
                lastExec: (baseNow as any)?.meta?.lastExec || undefined,
                externalEvents: undefined
            } as EnvironmentState;
            const overrides = (plugin as any)?.loop?.modules || {};
            let loopOpts: { maxTurns?: number; latencyMs?: number } = { maxTurns: 1 };
            try {
                const b = (plugin?.manifest as any)?.budgets; const hitl = (plugin?.manifest as any)?.hitl;
                if (hitl) { try { (M as any).hitl = hitl; } catch { } }
                if (b && typeof b === 'object') loopOpts = { maxTurns: (b as any).maxTurns ?? 1, latencyMs: (b as any).latencyMs };
            } catch { }
            const { M: mNext, outcome, metrics } = await runLoop(ctx, M, env, overrides, loopOpts);
            try {
                const snapAfter = await this.sessionManager!.load(tenantId, taskId);
                const expectedNow = snapAfter?.wmVersion ?? BigInt(0);
                const baseSnap = (snapAfter?.snapshot as Record<string, unknown>) || {};
                const executedTurns = 1;
                const prevMeta = (baseSnap as any).meta || {};
                const nextMeta = { ...prevMeta, turnTotal: (Number(prevMeta.turnTotal) || 0) + executedTurns };
                const nextSnap = { ...baseSnap, M: mNext, meta: nextMeta } as Record<string, unknown>;
                await this.sessionManager!.saveSnapshot({ tenantId, sessionId: taskId, agentId: agentName || 'default', expectedWmVersion: expectedNow, snapshot: nextSnap });
            } catch { /* noop */ }
            const channel = taskChannel(taskId);
            const status: TaskStatus = (() => {
                if (outcome.kind === 'await_input') return { state: 'input-required', timestamp: new Date().toISOString(), metadata: { token: (outcome as any).token, awaitExtra: { kind: outcome.kind }, timings: metrics?.timings, rewards: metrics?.rewards } } as any;
                if (outcome.kind === 'await_child' || outcome.kind === 'await_tool') return { state: 'working', timestamp: new Date().toISOString(), metadata: { awaiting: outcome.kind, token: (outcome as any).token, awaitExtra: { kind: outcome.kind } } } as any;
                if (outcome.kind === 'fail') return { state: 'failed', timestamp: new Date().toISOString(), message: { role: 'agent', parts: [{ type: 'text', text: `Loop failed: ${outcome.reason}` }] }, metadata: { reason: outcome.reason } } as any;
                if (outcome.kind === 'complete') return { state: 'completed', timestamp: new Date().toISOString(), metadata: { result: (outcome as any).result } } as any;
                return { state: 'working', timestamp: new Date().toISOString() } as any;
            })();
            try { eventBus.publish(channel, { id: taskId, status, final: status.state === 'completed' || status.state === 'failed' } as any); } catch { }
        } catch { }
    }

    /**
     * Route child completion to parent's durable handler using pending task mappings.
     * Provide either childToken (preferred correlation) or childTaskId.
     */
    async handleChildCompleted(params: { tenantId: string; parentTaskId: string; childToken?: string; childTaskId?: string; result: unknown; childAgentId?: string }): Promise<void> {
        const { tenantId, parentTaskId, childToken, childTaskId, result, childAgentId } = params;
        const snap = await this.sessionManager?.load(tenantId, parentTaskId);
        if (!snap) return;
        const base = (snap.snapshot as Record<string, unknown>) || {};
        const tasks = getPendingTasks(base);
        // Find entry
        const token = childToken || Object.keys(tasks).find(t => (tasks[t] as any)?.childTaskId === childTaskId);
        if (!token) return;
        const entry = tasks[token] as any;
        // If this child was awaited synchronously by the parent, skip auto-resume (already handled in-turn)
        if (entry && entry.handlers && entry.handlers.completed === undefined && entry.handlers.failed === undefined && entry.handlers.inputRequired === undefined && (result as any)?.status?.state !== 'input-required') {
            // Default await path: no handlers set and result is terminal -> no extra resume needed
            // Fall through to cleanup mapping only
        }
        // Remove mapping and auto-resume a loop turn with the child result
        delete tasks[token];
        const next = setPendingTasks(base, tasks);
        // Preserve the parent agent id on the session to ensure resumed turns use the parent's loop modules
        const parentAgentId = (snap as any)?.agentId || (base as any)?.meta?.agentId || 'default';
        await this.sessionManager?.saveSnapshot({ tenantId, sessionId: parentTaskId, agentId: parentAgentId, expectedWmVersion: snap.wmVersion ?? BigInt(0), snapshot: next });
        await this.sessionManager?.appendEvent(tenantId, parentTaskId, 'task.child_completed', { token, childTaskId, result });
        try {
            const agentName = (snap as any)?.agentId;
            const plugin = agentName ? PluginManager.findAgent(agentName) : null;
            try { console.log(`[TaskEngine] handleChildCompleted: resume parent agent='${agentName}' pluginFound=${!!plugin}`); } catch { }
            const ctx = this.createContext({ id: parentTaskId, input: {} });
            (ctx as any).tenantId = tenantId; if (agentName) (ctx as any).agentId = agentName;
            // Ensure replies in this resumed parent turn are streamed to console
            try { extendContextWithStreaming(ctx, true); } catch { /* noop */ }
            const snapNow = await this.sessionManager!.load(tenantId, parentTaskId);
            const baseNow = (snapNow?.snapshot as Record<string, unknown>) || {};

            const prevMetaCheck = (baseNow as any).meta || {};
            if (prevMetaCheck.lastChildToken === token) {
                console.log(`[TaskEngine] Skipping duplicate handleChildCompleted for token ${token}`);
                return;
            }

            let M: MentalState = (baseNow as any).M as MentalState || initialM(ctx);
            // Attach and restore LLM before running loop
            await this.attachAndRestoreLLM(ctx, agentName, M);
            const recordedTurn = Number((baseNow as any)?.meta?.turn) || 0;
            const startTurnTotal2 = recordedTurn === 0 ? 1 : recordedTurn; // assume initial run counted as 1 even if not persisted
            const env: EnvironmentState = {
                time: new Date().toISOString(),
                input: { kind: 'child', token, childTaskId, result, agentId: childAgentId },
                sessionId: parentTaskId,
                turn: startTurnTotal2 + 1,
                pending: {
                    inputs: ((baseNow as any)?.pending?.inputs) || {},
                    children: ((baseNow as any)?.pending?.children) || {},
                    tools: ((baseNow as any)?.pending?.tools) || {},
                    groups: ((baseNow as any)?.pending?.groups) || {}
                },
                lastExec: (baseNow as any)?.meta?.lastExec || undefined,
                externalEvents: undefined
            } as EnvironmentState;

            const overrides = (plugin as any)?.loop?.modules || {};
            try { console.log(`[TaskEngine] handleChildCompleted: loop overrides keys=`, Object.keys(overrides || {})); } catch { }
            let loopOpts: { maxTurns?: number; latencyMs?: number } = { maxTurns: 1 };
            try {
                const b = (plugin?.manifest as any)?.budgets; const hitl = (plugin?.manifest as any)?.hitl;
                if (hitl) { try { (M as any).hitl = hitl; } catch { } }
                if (b && typeof b === 'object') loopOpts = { maxTurns: (b as any).maxTurns ?? 1, latencyMs: (b as any).latencyMs };
            } catch { }
            const { M: mNext, outcome, metrics } = await runLoop(ctx, M, env, overrides, loopOpts);
            try {
                const snapAfter = await this.sessionManager!.load(tenantId, parentTaskId);
                const expectedNow = snapAfter?.wmVersion ?? BigInt(0);
                const baseSnap = (snapAfter?.snapshot as Record<string, unknown>) || {};
                const prevMeta = (baseSnap as any).meta || {};
                const nextMeta = { ...prevMeta, turn: env.turn, lastChildToken: token };
                const nextSnap = { ...baseSnap, M: mNext, meta: nextMeta } as Record<string, unknown>;
                await this.sessionManager!.saveSnapshot({ tenantId, sessionId: parentTaskId, agentId: agentName || 'default', expectedWmVersion: expectedNow, snapshot: nextSnap });
            } catch (e) { /* noop */ }
            const channel = taskChannel(parentTaskId);
            const status: TaskStatus = (() => {
                if (outcome.kind === 'await_input') return { state: 'input-required', timestamp: new Date().toISOString(), metadata: { token: (outcome as any).token, awaitExtra: { kind: outcome.kind }, timings: metrics?.timings, rewards: metrics?.rewards } } as any;
                if (outcome.kind === 'await_child' || outcome.kind === 'await_tool') return { state: 'working', timestamp: new Date().toISOString(), metadata: { awaiting: outcome.kind, token: (outcome as any).token, awaitExtra: { kind: outcome.kind } } } as any;
                if (outcome.kind === 'fail') return { state: 'failed', timestamp: new Date().toISOString(), message: { role: 'agent', parts: [{ type: 'text', text: `Loop failed: ${outcome.reason}` }] }, metadata: { reason: outcome.reason } } as any;
                if (outcome.kind === 'complete') return { state: 'completed', timestamp: new Date().toISOString(), metadata: { result: (outcome as any).result } } as any;
                return { state: 'working', timestamp: new Date().toISOString() } as any;
            })();
            try { eventBus.publish(channel, { id: parentTaskId, status, final: status.state === 'completed' || status.state === 'failed' } as any); } catch { }
        } catch { }

        // Update any pending group aggregations that include this child token
        const snap2 = await this.sessionManager?.load(tenantId, parentTaskId);
        if (snap2) {
            const base2 = (snap2.snapshot as Record<string, unknown>) || {};
            const groups = getPendingGroups(base2);
            let mutated = false;
            for (const [gToken, g] of Object.entries(groups)) {
                if (g.childTokens?.includes(token)) {
                    g.results = g.results || {} as any;
                    (g.results as any)[token] = { ok: true, value: result };
                    mutated = true;
                    // Check if all children have results recorded
                    const allDone = g.childTokens.every(ct => (g.results as any)[ct] !== undefined);
                    if (allDone) {
                        // invoke group allCompleted handler if set
                        const handler = g.handlers?.allCompleted;
                        // remove group from snapshot
                        delete groups[gToken];
                        const next2 = setPendingGroups(base2, groups);
                        await this.sessionManager?.saveSnapshot({ tenantId, sessionId: parentTaskId, agentId: (base2 as any)?.meta?.agentId || 'default', expectedWmVersion: snap2.wmVersion ?? BigInt(0), snapshot: next2 });
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
                const parentAgentId = (snap2 as any)?.agentId || (base2 as any)?.meta?.agentId || 'default';
                await this.sessionManager?.saveSnapshot({ tenantId, sessionId: parentTaskId, agentId: parentAgentId, expectedWmVersion: snap2.wmVersion ?? BigInt(0), snapshot: next2 });
            }
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
        await this.sessionManager?.appendEvent(tenantId, parentTaskId, 'task.child_input_required', { token, childTaskId, prompt, schema, childOnProvided });
        try { console.log(`[TaskEngine] child input_required: token=${token} handler='${handlerName}' childOnProvided='${childOnProvided}' childTaskId=${childTaskId} prompt='${prompt}'`); } catch { }
        if (!alreadyDelivered && handlerName && this.handlerInvoker) {
            try { console.log(`[TaskEngine] invoking parent handler '${handlerName}' for token=${token}`); } catch { }
            const maybe = await this.handlerInvoker.invoke({ tenantId, taskId: parentTaskId, handlerName, input: { prompt, schema, token, childTaskId } });
            try { console.log(`[TaskEngine] parent handler '${handlerName}' returned: ${JSON.stringify(maybe)}`); } catch { }
            if (typeof maybe !== 'undefined') {
                // Parent provided immediate answer; first try to invoke child's onProvided if available
                let finalChildResult: unknown = maybe;
                try {
                    const effectiveChildOnProvided = childOnProvided || (entry?.pendingInput?.childOnProvided as string | undefined);
                    if (effectiveChildOnProvided && childTaskId && this.handlerInvoker) {
                        try { console.log(`[TaskEngine] invoking child onProvided='${effectiveChildOnProvided}' for childTaskId=${childTaskId} with value=${JSON.stringify(maybe)}`); } catch { }
                        try {
                            const _childResult = await this.handlerInvoker.invoke({ tenantId, taskId: childTaskId, handlerName: effectiveChildOnProvided, input: maybe });
                            try { console.log(`[TaskEngine] child onProvided result for childTaskId=${childTaskId}: ${JSON.stringify(_childResult)}`); } catch { }
                            if (typeof _childResult !== 'undefined') {
                                finalChildResult = _childResult;
                            }
                        } catch (err) {
                            try { console.warn(`[TaskEngine] HANDLER_NOT_FOUND or error invoking child onProvided='${effectiveChildOnProvided}'`, err instanceof Error ? err.message : String(err)); } catch { }
                        }
                    }
                } catch (e) {
                    // If invoking child's handler fails, fall back to using parent's value
                    try { console.log(`[TaskEngine] Child onProvided invocation failed; using parent value. Error: ${(e as Error).message}`); } catch { }
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
                        if ((e as Error).message === 'CAS_MISMATCH') {
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
        for (const [gToken, g] of Object.entries(groups)) {
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
        // If a durable 'handleTask' is registered, invoke it as the entrypoint
        try {
            (ctx as any).logger?.info?.('TaskEngine.executeTaskHandler: invoking durable handler handleTask', { taskId: ctx.task.id });
            const { invokeHandler } = await import('./HandlerRegistry.js');
            await invokeHandler('handleTask', ctx, { input: ctx.task.input });
            (ctx as any).logger?.info?.('TaskEngine.executeTaskHandler: durable handleTask returned', { taskId: ctx.task.id });
            return;
        } catch (err) {
            // Fallback: placeholder
            const traceId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            (ctx as any).logger?.warn?.('TaskEngine.executeTaskHandler: durable handler invocation failed, falling back to placeholder', { taskId: ctx.task.id, traceId, error: err instanceof Error ? err.message : String(err) });
            console.log('Executing task handler (placeholder):', ctx.task.id);
        }
    }

    /**
     * Helper to attach and restore LLM for a context from persisted MentalState
     */
    private async attachAndRestoreLLM(ctx: TaskContext, agentName: string | undefined, M: MentalState | undefined): Promise<void> {
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

            // Restore LLM conversation state if available
            if (M) {
                try {
                    const llmStateFromM = (((M.memory as any)?.sensory as any)?.llmState);
                    const llmAny = (ctx as any).llm as any;
                    if (typeof llmStateFromM !== 'undefined' && llmAny?.importState) {
                        llmAny.importState(llmStateFromM);
                        try { console.log('[TaskEngine] Restored LLM history for', agentName); } catch { }
                    }
                } catch (e) {
                    try { console.log('[TaskEngine] Failed to restore LLM state for', agentName, e); } catch { }
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
        return {
            tenantId: 'default', // TODO: Get from agent/task context
            agentId: 'default', // TODO: Get from agent/task context
            task: {
                id: task.id,
                input: task.input as TaskInput
            },
            // These will be replaced by the streaming context
            reply: async (parts) => {
                const { withSafety } = await import('../../loop/effectSafety.js');
                await withSafety(async () => { /* real reply implementation is injected by streaming runner */ }, { timeoutMs: 5000, maxRetries: 1 });
            },
            progress: () => { },
            complete: () => { },
            fail: async () => { },
            // Add stub for recordUsage
            recordUsage: () => { console.warn('recordUsage called on base context'); },
            // Stub implementations for other required properties
            llm: {} as any,
            tools: {
                invoke: async <T>(toolName: string, args: unknown) => {
                    const { withSafety } = await import('../../loop/effectSafety.js');
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
            logger: {
                debug: (_event: string, _data?: Record<string, unknown>) => { },
                info: (_event: string, _data?: Record<string, unknown>) => { },
                warn: (_event: string, _data?: Record<string, unknown>) => { },
                error: (_event: string, _data?: Record<string, unknown>) => { }
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
            throw: (code, message) => { throw new Error(`${code}: ${message}`); },
            sendTaskToAgent: async () => { throw new Error('A2A not available in basic task engine'); },
            requestInput: async () => { throw new Error('requestInput not available in basic task engine'); },

            // (legacy methods removed)
            vars: {
                get: () => undefined,
                set: () => { },
                merge: () => { },
                update: () => { },
                delete: () => { },
                keys: () => [],
                has: () => false
            } as any,
            // (legacy goals API removed)
            recall: async () => { throw new Error('Memory not available in basic task engine'); },
            remember: async () => { throw new Error('Memory not available in basic task engine'); }
        };
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
                    const M = (baseSnap as any).M as MentalState | undefined;
                    const llmStateFromM = M ? (((M.memory as any)?.sensory as any)?.llmState) : undefined;
                    const legacyLlm = (baseSnap as any)?.llm;
                    const llmState = typeof llmStateFromM !== 'undefined' ? llmStateFromM : legacyLlm;
                    const llmAny = (ctx as any).llm as any;
                    if (typeof llmState !== 'undefined' && llmAny?.importState) {
                        llmAny.importState(llmState);
                        try { console.log('[TaskEngine] restoreCtx restored LLM history'); } catch { }
                    }
                } catch (e) {
                    try { console.log('[TaskEngine] restoreCtx failed to restore LLM state', e); } catch { }
                }
            }
            try { console.log('[TaskEngine] restoreCtx LLM type', (ctx as any).llm?.constructor?.name); } catch { }
        } catch { /* ignore LLM reattach failures */ }
        // Rehydrate vars from MentalState if present; fallback to legacy vars
        try {
            const M = (baseSnap as any).M as MentalState | undefined;
            const vars = M ? (((M.memory as any)?.vars) || {}) : ((baseSnap as any)?.vars || {});
            // Merge into facade instead of overwriting it
            try { (ctx as any).vars.merge(vars); } catch { (ctx as any).vars = { ...(ctx as any).vars, ...vars }; }
        } catch {
            (ctx as any).vars = ((baseSnap as any)?.vars || {}) as Record<string, unknown>;
        }
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
            (ctx as any).semantic = {
                add: async (item: { id: string; value: unknown; tags?: string[]; entities?: Record<string, unknown> }) => {
                    try { await (ctx.memory as any)?.semantic?.set?.(item.id, item.value, { tags: item.tags, entities: item.entities }); } catch { /* noop */ }
                },
                remove: async (idOrPredicate: string | ((f: { id: string; value: unknown; tags?: string[]; entities?: Record<string, unknown> }) => boolean)) => {
                    try {
                        if (typeof idOrPredicate === 'string') {
                            await (ctx.memory as any)?.semantic?.delete?.(idOrPredicate);
                            return;
                        }
                        const all = await (ctx.memory as any)?.semantic?.getMany?.('*');
                        if (Array.isArray(all)) {
                            for (const item of all) {
                                const mapped = { id: item?.key ?? item?.id, value: item?.value, tags: item?.tags, entities: item?.entities } as any;
                                if ((idOrPredicate as any)(mapped)) await (ctx.memory as any)?.semantic?.delete?.(mapped.id);
                            }
                        }
                    } catch { /* noop */ }
                },
                read: async (filter?: { id?: string | string[]; tag?: string; tags?: string[]; limit?: number }) => {
                    try {
                        const all = await (ctx.memory as any)?.semantic?.getMany?.('*');
                        const mapped = Array.isArray(all) ? all.map((x: any) => ({ id: x?.key ?? x?.id, value: x?.value, tags: x?.tags, entities: x?.entities })) : [];
                        if (!filter) return mapped;
                        const byIds = filter.id ? mapped.filter(m => Array.isArray(filter.id) ? filter.id.includes(m.id) : m.id === filter.id) : mapped;
                        const tagSet = filter.tags || (filter.tag ? [filter.tag] : undefined);
                        const byTags = tagSet && tagSet.length ? byIds.filter(m => (tagSet as string[]).every(t => new Set(m.tags || []).has(t))) : byIds;
                        return typeof filter.limit === 'number' ? byTags.slice(0, Math.max(0, filter.limit)) : byTags;
                    } catch { return []; }
                }
            };
            (ctx as any).decisions = {
                add: (key: string, value: unknown, reasoning?: string) => {
                    try {
                        const d = (((ctx as any).vars.get('decisions')) || {}) as Record<string, any>;
                        d[key] = { value, reasoning, ts: new Date().toISOString() };
                        (ctx as any).vars.set('decisions', d);
                        (ctx as any).thoughts?.add?.(`Decision: ${key} ${String(value)}${reasoning ? ' (' + reasoning + ')' : ''}`);
                    } catch { /* noop */ }
                },
                get: (key: string) => {
                    try { const d = ((ctx as any).vars.get('decisions') || {}) as Record<string, any>; return d[key]?.value; } catch { return undefined; }
                },
                read: (_filter?: { prefix?: string }) => {
                    try {
                        const d = ((ctx as any).vars.get('decisions') || {}) as Record<string, any>;
                        return Object.entries(d).map(([k, v]) => ({ key: k, value: (v as any).value, reasoning: (v as any).reasoning, ts: (v as any).ts }));
                    } catch { return []; }
                },
                remove: (key: string) => {
                    try { const d = ((ctx as any).vars.get('decisions') || {}) as Record<string, any>; delete d[key]; (ctx as any).vars.set('decisions', d); } catch { /* noop */ }
                },
                clear: () => { try { (ctx as any).vars.set('decisions', {}); } catch { /* noop */ } }
            };
            (ctx as any).world = { update: (fn: (wm: any) => void) => { try { fn(((ctx as any).__mental as any).worldModel); } catch { /* noop */ } }, patch: (p: Record<string, unknown>) => { try { Object.assign(((ctx as any).__mental as any).worldModel, p); } catch { /* noop */ } } };
        } catch { /* noop */ }
        // LLM state restoration now happens immediately after LLM creation above (lines 1551-1564)
        // Ensure restored context can emit streaming events to the same task channel
        try { extendContextWithStreaming(ctx, true); } catch { /* noop */ }
        // Wire Goals API on durable handler context
        try {
            const goals = await import('../../loop/goals.js');
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
        try {
            const engine = this;
            (ctx as any).sendTaskToAgent = async (agent: string, childInput: unknown, options?: { awaitCompletion?: boolean; streaming?: boolean; onCompleted?: string; onFailed?: string; onInputRequired?: string }) => {
                if (!engine.sessionManager) throw new Error('Session manager not configured');
                const tenantId = (ctx as any).tenantId;
                const sessionId = taskId;

                // Use the same logic as the main TaskEngine implementation
                const { handle, token } = await createTaskHandle(engine.sessionManager, tenantId, sessionId, agent, childInput);
                // If handler names provided, register them atomically before dispatch
                if (options?.onInputRequired) { try { await (handle as any).onInputRequired(options.onInputRequired); } catch { } }
                if (options?.onCompleted) { try { await (handle as any).onCompleted(options.onCompleted); } catch { } }
                if (options?.onFailed) { try { await (handle as any).onFailed(options.onFailed); } catch { } }

                const minimalCtx = ctx as any;
                const a2aOptions = { tenantId, streaming: (options?.streaming) === true } as any;
                try {
                    const result = await globalA2AService.sendTaskToAgent(minimalCtx, agent, childInput as any, {
                        ...(options || {}),
                        ...a2aOptions,
                        parentTenantId: tenantId,
                        parentTaskId: sessionId,
                        parentChildToken: token
                    } as any);

                    // If child requested input, do not synthesize completion
                    if (result && typeof result === 'object' && (result as any).status === 'input_required') {
                        return;
                    }

                    // For durable handlers, default to awaiting completion
                    const awaitCompletion = options?.awaitCompletion !== false;
                    if (awaitCompletion) {
                        await engine.handleChildCompleted({ tenantId, parentTaskId: sessionId, childToken: token, result });
                        return result;
                    }
                    return result;
                } catch (e) {
                    await engine.sessionManager!.enqueueOutbox(tenantId, 'task.child_dispatch', sessionId, {
                        taskId: sessionId,
                        childAgent: agent,
                        error: e instanceof Error ? e.message : String(e)
                    });
                    throw e;
                }
            };
        } catch { /* noop */ }
        return ctx;
    }
}

// Export a singleton instance
export const taskEngine = new TaskEngine(); 