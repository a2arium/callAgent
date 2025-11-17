import type { TaskContext, TaskInput } from '../../shared/types/index.js';
import type { TaskStatus, Artifact } from '../../shared/types/StreamingEvents.js';
import { eventBus } from '../../eventbus/inMemoryEventBus.js';
import { taskChannel } from '../../eventbus/taskEventEmitter.js';
import { extendContextWithStreaming } from '../context/StreamingContext.js';
import { SessionManager } from './SessionManager.js';
import { InMemorySessionManager } from './InMemorySessionManager.js';
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
import { logger } from '@a2arium/callagent-utils';
import { runLoop } from '../../loop/loopRunner.js';
import type { EnvironmentState, ObservationInbox } from '../../loop/types.js';
import type { Observation } from '../../loop/oneTurn.js';
import { getPendingTools, setPendingTools } from './ToolsRegistry.js';
import { getPendingExternalEvents, setPendingExternalEvents } from './ExternalEventsRegistry.js';
import { PluginManager } from '../plugin/pluginManager.js';
import { extendContextWithMemory } from '../memory/types/working/context/workingMemoryContext.js';
import { createMemoryRegistry } from '../memory/createMemoryRegistry.js';

type WorkingVarHookRegistrarFn = (hooks?: {
    onChange?: (key: string, value: unknown) => void;
    onDelete?: (key: string) => void;
    onClear?: () => void;
}) => void;

const normalizeInbox = (value: unknown): ObservationInbox => {
    if (Array.isArray(value)) {
        const arr = value as Observation[];
        return { current: [...arr], all: [...arr] };
    }
    if (value && typeof value === 'object') {
        const candidate = value as Partial<ObservationInbox>;
        const current = Array.isArray(candidate.current) ? [...candidate.current] : [];
        const all = Array.isArray(candidate.all) ? [...candidate.all] : [];
        return { current, all };
    }
    return { current: [], all: [] };
};

const addObservationToInbox = (inboxValue: unknown, observation: Observation): ObservationInbox => {
    const inbox = normalizeInbox(inboxValue);
    inbox.current.push(observation);
    inbox.all.push(observation);
    return inbox;
};

const addObservationToInboxIfMissing = (
    inboxValue: unknown,
    observation: Observation,
    predicate: (obs: Observation) => boolean
): ObservationInbox => {
    const inbox = normalizeInbox(inboxValue);
    const hasInAll = inbox.all.some(predicate);
    const hasInCurrent = inbox.current.some(predicate);

    if (!hasInAll) {
        inbox.all.push(observation);
    }
    if (!hasInCurrent) {
        inbox.current.push(observation);
    }

    return inbox;
};

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

const log = logger.createLogger({ prefix: 'TaskEngine' });

export class TaskEngine {
    private sessionManager?: SessionManager;
    private handlerInvoker?: DurableHandlerInvoker;
    private readonly childCompletionInFlight = new Map<string, number>();

    constructor(opts?: { sessionStore?: IWorkingMemorySessionStore; handlerInvoker?: DurableHandlerInvoker }) {
        if (opts?.sessionStore) {
            this.sessionManager = new SessionManager(opts.sessionStore);
        } else {
            // Default to in-memory session manager for testing/CLI
            log.warn('No SessionStore configured - using IN-MEMORY mode');
            log.warn('⚠️  IN-MEMORY MODE IS NOT SUITABLE FOR PRODUCTION');
            log.warn('For production, configure a database-backed SessionStore');
            log.warn('See: docs/a2a/production-setup.md');
            this.sessionManager = new SessionManager(new InMemorySessionManager());
        }
        if (opts?.handlerInvoker) {
            this.handlerInvoker = opts.handlerInvoker;
        } else {
            // Default basic invoker using local restoreCtx
            this.handlerInvoker = new DurableHandlerInvokerCore(this.restoreCtx.bind(this));
        }
        // Ensure outbox publisher is running
        try { outboxPublisher.start(); } catch { /* noop */ }
    }

    private iterateMentalTargets(
        ctx: TaskContext,
        fn: (args: { target: Record<string, unknown>; memory: Record<string, unknown>; vars: Record<string, unknown> }) => void
    ): void {
        const candidates: unknown[] = [
            (ctx as any).__mental,
            (ctx as any).M
        ];

        for (const mental of candidates) {
            if (!mental || typeof mental !== 'object') continue;
            const target = mental as Record<string, unknown>;
            let memory = target.memory;
            if (!memory || typeof memory !== 'object' || Array.isArray(memory)) {
                memory = {};
                target.memory = memory as Record<string, unknown>;
            }
            let vars = (memory as Record<string, unknown>).vars;
            if (!vars || typeof vars !== 'object' || Array.isArray(vars)) {
                vars = {};
                (memory as Record<string, unknown>).vars = vars;
            }
            fn({ target, memory: memory as Record<string, unknown>, vars: vars as Record<string, unknown> });
        }
    }

    private setNestedValueClone(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
        if (!path.includes('.')) {
            return { ...obj, [path]: value };
        }
        const parts = path.split('.');
        const clone = { ...obj };
        let current = clone;
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            const existing = current[part];
            if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
                current[part] = {};
            } else {
                current[part] = { ...(existing as Record<string, unknown>) };
            }
            current = current[part] as Record<string, unknown>;
        }
        current[parts[parts.length - 1]] = value;
        return clone;
    }

    private deleteNestedValueClone(obj: Record<string, unknown>, path: string): { next: Record<string, unknown>; changed: boolean } {
        if (!path.includes('.')) {
            if (!Object.prototype.hasOwnProperty.call(obj, path)) {
                return { next: obj, changed: false };
            }
            const clone = { ...obj };
            delete clone[path];
            return { next: clone, changed: true };
        }
        const parts = path.split('.');
        const clone = { ...obj };
        let currentClone: Record<string, unknown> = clone;
        let currentOrig: Record<string, unknown> | undefined = obj;
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            const nextOrig = currentOrig?.[part];
            if (!nextOrig || typeof nextOrig !== 'object' || Array.isArray(nextOrig)) {
                return { next: obj, changed: false };
            }
            const nextClone = { ...(nextOrig as Record<string, unknown>) };
            currentClone[part] = nextClone;
            currentClone = nextClone;
            currentOrig = nextOrig as Record<string, unknown>;
        }
        const leafKey = parts[parts.length - 1];
        if (!currentOrig || !Object.prototype.hasOwnProperty.call(currentOrig, leafKey)) {
            return { next: obj, changed: false };
        }
        delete currentClone[leafKey];
        return { next: clone, changed: true };
    }

    private syncWorkingVarIntoMental(ctx: TaskContext, key: string, value: unknown): void {
        log.debug('syncWorkingVarIntoMental', { key, hasValue: value !== undefined });
        this.iterateMentalTargets(ctx, ({ target, memory, vars }) => {
            const nextVars = this.setNestedValueClone(vars, key, value);
            memory.vars = nextVars;
            target.vars = { ...nextVars };
        });
        try { (ctx as any).__varsDirty = true; } catch { /* noop */ }
    }

    private removeWorkingVarFromMental(ctx: TaskContext, key: string): void {
        this.iterateMentalTargets(ctx, ({ target, memory, vars }) => {
            const { next, changed } = this.deleteNestedValueClone(vars, key);
            if (!changed) return;
            memory.vars = next;
            target.vars = { ...next };
        });
        try { (ctx as any).__varsDirty = true; } catch { /* noop */ }
    }

    private clearWorkingVarsInMental(ctx: TaskContext): void {
        this.iterateMentalTargets(ctx, ({ target, memory }) => {
            memory.vars = {};
            target.vars = {};
        });
        try { (ctx as any).__varsDirty = true; } catch { /* noop */ }
    }

    private registerWorkingVarHooks(ctx: TaskContext, varsObject: unknown, varCache?: Map<string, unknown>): void {
        const registerFn: WorkingVarHookRegistrarFn | undefined = (varsObject as any)?.__registerWorkingVarHooks;
        const hasRegisterFn = typeof registerFn === 'function';
        log.debug('registerWorkingVarHooks', { hasRegisterFn });
        if (!hasRegisterFn) {
            this.wrapLegacyWorkingVarsProxy(ctx, varsObject, varCache);
            return;
        }
        registerFn({
            onChange: (key, value) => {
                if (varCache) {
                    if (key.includes('.')) {
                        const baseKey = key.split('.')[0];
                        const existing = (varCache.get(baseKey) as Record<string, unknown>) || {};
                        varCache.set(baseKey, this.setNestedValueClone(existing, key.substring(key.indexOf('.') + 1), value));
                    } else {
                        varCache.set(key, value);
                    }
                }
                this.syncWorkingVarIntoMental(ctx, key, value);
            },
            onDelete: key => {
                if (varCache) {
                    if (key.includes('.')) {
                        const baseKey = key.split('.')[0];
                        const existing = (varCache.get(baseKey) as Record<string, unknown>) || {};
                        const { next, changed } = this.deleteNestedValueClone(existing, key.substring(key.indexOf('.') + 1));
                        if (changed) {
                            varCache.set(baseKey, next);
                        }
                    } else {
                        varCache.delete(key);
                    }
                }
                this.removeWorkingVarFromMental(ctx, key);
            },
            onClear: () => {
                varCache?.clear();
                this.clearWorkingVarsInMental(ctx);
            }
        });
    }

    private wrapLegacyWorkingVarsProxy(ctx: TaskContext, varsObject: unknown, varCache?: Map<string, unknown>): void {
        if (!varsObject || typeof varsObject !== 'object') return;
        const marker = '__a2aLegacyVarSyncWrapped';
        if ((varsObject as Record<string, unknown>)[marker]) return;
        if (!(varsObject as any).__varsId) {
            (varsObject as any).__varsId = `vars-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        }

        const mapLike = varsObject as Record<string, unknown> & {
            set?: (key: string, value: unknown) => unknown;
            delete?: (key: string) => unknown;
            clear?: () => unknown;
        };

        const wrapKey = (key: string): { base: string; path?: string } => {
            if (!key.includes('.')) return { base: key };
            return { base: key.split('.')[0], path: key.substring(key.indexOf('.') + 1) };
        };
        const readFromVarCache = (key: string): { exists: boolean; value?: unknown } => {
            if (!varCache) return { exists: false };
            const { base, path } = wrapKey(key);
            if (!varCache.has(base)) return { exists: false };
            const baseValue = varCache.get(base);
            if (!path) {
                return { exists: true, value: baseValue };
            }
            if (!baseValue || typeof baseValue !== 'object') {
                return { exists: false };
            }
            const segments = path.split('.');
            let current: unknown = baseValue;
            for (const segment of segments) {
                if (!current || typeof current !== 'object' || !(segment in (current as Record<string, unknown>))) {
                    return { exists: false };
                }
                current = (current as Record<string, unknown>)[segment];
            }
            return { exists: true, value: current };
        };

        if (typeof mapLike.set === 'function') {
            const originalSet = mapLike.set.bind(varsObject);
            mapLike.set = (key: string, value: unknown) => {
                const result = originalSet(key, value);
                if (varCache) {
                    const { base, path } = wrapKey(key);
                    if (path) {
                        const existing = (varCache.get(base) as Record<string, unknown>) || {};
                        varCache.set(base, this.setNestedValueClone(existing, path, value));
                    } else {
                        varCache.set(base, value);
                    }
                }
                this.syncWorkingVarIntoMental(ctx, key, value);
                return result;
            };
        }

        if (typeof mapLike.delete === 'function') {
            const originalDelete = mapLike.delete.bind(varsObject);
            mapLike.delete = (key: string) => {
                const result = originalDelete(key);
                if (varCache) {
                    const { base, path } = wrapKey(key);
                    if (path) {
                        const existing = (varCache.get(base) as Record<string, unknown>) || {};
                        const { next, changed } = this.deleteNestedValueClone(existing, path);
                        if (changed) varCache.set(base, next);
                    } else {
                        varCache.delete(base);
                    }
                }
                this.removeWorkingVarFromMental(ctx, key);
                return result;
            };
        }

        if (typeof mapLike.clear === 'function') {
            const originalClear = mapLike.clear.bind(varsObject);
            mapLike.clear = () => {
                const result = originalClear();
                varCache?.clear();
                this.clearWorkingVarsInMental(ctx);
                return result;
            };
        }

        const originalGet = typeof mapLike.get === 'function' ? mapLike.get.bind(varsObject) : undefined;
        mapLike.get = (key: string) => {
            if (varCache) {
                const fromCache = readFromVarCache(key);
                if (fromCache.exists) return fromCache.value;
            }
            return originalGet ? originalGet(key) : undefined;
        };

        const originalHas = typeof mapLike.has === 'function' ? mapLike.has.bind(varsObject) : undefined;
        mapLike.has = (key: string) => {
            if (varCache && readFromVarCache(key).exists) return true;
            return originalHas ? originalHas(key) : false;
        };

        const originalEntries = typeof mapLike.entries === 'function' ? mapLike.entries.bind(varsObject) : undefined;
        mapLike.entries = () => {
            if (varCache) return varCache.entries();
            return originalEntries ? originalEntries() : [][Symbol.iterator]();
        };

        const originalKeys = typeof mapLike.keys === 'function' ? mapLike.keys.bind(varsObject) : undefined;
        mapLike.keys = () => {
            if (varCache) return varCache.keys();
            return originalKeys ? originalKeys() : [][Symbol.iterator]();
        };

        const originalValues = typeof mapLike.values === 'function' ? mapLike.values.bind(varsObject) : undefined;
        mapLike.values = () => {
            if (varCache) return varCache.values();
            return originalValues ? originalValues() : [][Symbol.iterator]();
        };

        const originalForEach = typeof mapLike.forEach === 'function' ? mapLike.forEach.bind(varsObject) : undefined;
        mapLike.forEach = (callback: (value: unknown, key: string, map: unknown) => void) => {
            if (varCache) {
                varCache.forEach((value, key) => {
                    callback(value, key, mapLike);
                });
            } else if (originalForEach) {
                originalForEach(callback);
            }
        };

        const originalSizeDescriptor = Object.getOwnPropertyDescriptor(mapLike, 'size');
        Object.defineProperty(mapLike, 'size', {
            get: () => {
                if (varCache) return varCache.size;
                if (originalSizeDescriptor?.get) return originalSizeDescriptor.get.call(varsObject);
                if (typeof (mapLike as any).__legacySize === 'number') return (mapLike as any).__legacySize;
                return 0;
            },
            configurable: true
        });

        (mapLike as any)[marker] = true;
    }

    private mergeVarsIntoMental(source: MentalState, target: MentalState): MentalState {
        try {
            const sourceVars = (((source as any)?.memory as any)?.vars) || {};
            const targetVars = (((target as any)?.memory as any)?.vars) || {};
            if ((sourceVars && typeof sourceVars === 'object') || (targetVars && typeof targetVars === 'object')) {
                const mem = (((target as any).memory) || {}) as Record<string, unknown>;
                // ✅ FIX: MERGE vars from both source and target, don't overwrite
                // target (mNext) has Learning's changes, source (M) has ctx.vars changes
                const merged = { ...(targetVars as Record<string, unknown>), ...(sourceVars as Record<string, unknown>) };
                (target as any).memory = { ...mem, vars: merged };
            }
        } catch { /* noop */ }
        return target;
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

    private async attachOrchestrationAPIs(
        ctx: TaskContext,
        params: { tenantId: string; sessionId: string; agentId?: string; flushMentalState: () => Promise<void> }
    ): Promise<void> {
        if (!this.sessionManager) {
            throw new Error('TaskEngine requires a configured session manager for orchestration APIs');
        }

        const { tenantId, sessionId } = params;
        const agentId = params.agentId ?? ((ctx as any).agentId as string) ?? 'default';
        const flushMentalState = params.flushMentalState;

        // Goals API facade
        try {
            const goals = await import('../../loop/goals.js');
            (ctx as any).addGoal = (node: any) => goals.addGoal(ctx as any, node);
            (ctx as any).updateGoal = (id: any, patch: any) => goals.updateGoal(ctx as any, id, patch);
            (ctx as any).moveGoal = (id: any, parentId?: any, order?: any) => goals.moveGoal(ctx as any, id, parentId, order);
            (ctx as any).completeGoal = (id: any, opts?: any) => goals.completeGoal(ctx as any, id, opts);
            (ctx as any).failGoal = (id: any) => goals.failGoal(ctx as any, id);
            (ctx as any).listGoals = (filter?: any) => goals.listGoals(ctx as any, filter);
            (ctx as any).goals = {
                add: (g: any) => goals.addGoal(ctx as any, g),
                update: (goalId: string, patch: any) => goals.updateGoal(ctx as any, goalId, patch),
                remove: (goalId: string) => goals.failGoal(ctx as any, goalId),
                clear: async (predicate?: (g: any) => boolean) => {
                    const all = await goals.listGoals(ctx as any, {});
                    for (const g of all) {
                        if (!predicate || predicate(g as any)) {
                            await goals.failGoal(ctx as any, (g as any).id);
                        }
                    }
                },
                read: (filter?: any) => goals.listGoals(ctx as any, filter)
            };
        } catch { /* noop */ }

        // Semantic facade (only attach if caller has not provided their own)
        if (!(ctx as any).semantic) {
            (ctx as any).semantic = {
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
        }

        const hasPreservedRequestInput = (ctx as any).__a2aParent || (ctx as any).__preserveRequestInput;
        if (!hasPreservedRequestInput) {
            (ctx as any).requestInput = async (
                promptOrParts: string | string[] | import('../../shared/types/index.js').MessagePart | import('../../shared/types/index.js').MessagePart[],
                opts?: { ttlMs?: number; schema?: unknown; onProvided?: string; onExpired?: string; __existingToken?: string; setToken?: boolean; setStage?: string }
            ) => {
                if (!this.sessionManager) throw new Error('Session manager not configured');
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

                const normalizeParts = (
                    p: string | string[] | import('../../shared/types/index.js').MessagePart | import('../../shared/types/index.js').MessagePart[]
                ): import('../../shared/types/index.js').MessagePart[] => {
                    if (typeof p === 'string') return [{ type: 'text', text: p, format: 'markdown' } as any];
                    if (Array.isArray(p) && p.length > 0 && typeof p[0] === 'string') {
                        return (p as string[]).map(t => ({ type: 'text', text: t, format: 'markdown' } as any));
                    }
                    if (Array.isArray(p)) {
                        return (p as any[]).map(part => (part?.type === 'text' && !part?.format ? { ...part, format: 'markdown' } : part));
                    }
                    const one = p as any;
                    return [one?.type === 'text' && !one?.format ? { ...one, format: 'markdown' } : one];
                };

                const parts = normalizeParts(promptOrParts);
                const prompt = (parts.find((x: any) => x?.type === 'text') as any)?.text as string | undefined;

                try { await ctx.reply(parts as any); } catch { /* best-effort */ }

                if (!opts?.__existingToken) {
                    pending[token] = {
                        schema: opts?.schema,
                        expiresAt,
                        handlerName: opts?.onProvided,
                        expiredHandlerName: opts?.onExpired
                    } as any;
                }

                const writeOnce = async (baseSnap: Record<string, unknown>, expectedVer: bigint) => {
                    const mental = (ctx as any).__mental;
                    try { await flushMentalState(); } catch { /* best-effort */ }
                    const latest = await this.sessionManager!.load(tenantId, sessionId);
                    const latestBase = (latest?.snapshot as Record<string, unknown>) || baseSnap;
                    const nextSnapshot = setPendingInputs(latestBase, pending);
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
                            const next2 = setPendingInputs(base2, pending2);
                            await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || 'default', expectedWmVersion: expected2, snapshot: next2 });
                            await this.sessionManager.appendEvent(tenantId, sessionId, 'task.input_required', { token, prompt, parts, schema: opts?.schema, expiresAt });
                            await this.sessionManager.enqueueOutbox(tenantId, 'task.input_required', sessionId, { taskId: sessionId, prompt, parts, token, schema: opts?.schema, expiresAt });
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
                            parts
                        },
                        timestamp: new Date().toISOString(),
                        metadata: { token }
                    } as any);
                } catch { /* noop */ }

                if (opts?.setToken !== false) {
                    ctx.vars.set('token', token);
                }

                if (opts?.setStage) {
                    try {
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

        (ctx as any).requestTool = async (toolName: string, args: unknown, opts?: { onCompleted?: string; setToken?: boolean; setStage?: string }) => {
            if (!this.sessionManager) throw new Error('Session manager not configured');
            const snap = await this.sessionManager.load(tenantId, sessionId);
            const base = (snap?.snapshot as Record<string, unknown>) || {};
            const token = uuidv4();
            const toolsNow = getPendingTools(base) as any;
            toolsNow[token] = { name: toolName, args, handlers: { completed: opts?.onCompleted } };

            if (opts?.setToken || opts?.setStage) {
                toolsNow[token].options = {
                    setToken: opts.setToken,
                    setStage: opts.setStage
                };
            }

            try { await flushMentalState(); } catch { /* best-effort */ }
            const expected = snap?.wmVersion ?? BigInt(0);
            const next = setPendingTools(base, toolsNow);
            await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || 'default', expectedWmVersion: expected, snapshot: next });
            await this.sessionManager.appendEvent(tenantId, sessionId, 'task.tool_requested', { token, toolName });

            if (opts?.setToken || opts?.setStage) {
                try {
                    const currentSnap = await this.sessionManager.load(tenantId, sessionId);
                    if (currentSnap) {
                        const currentBase = (currentSnap.snapshot as Record<string, unknown>) || {};
                        const currentM = currentBase.M as any;

                        if (opts.setToken && token && currentM?.vars) {
                            const setNestedValue = (obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> => {
                                const pathParts = path.split('.');
                                let current = obj;
                                for (let i = 0; i < pathParts.length - 1; i++) {
                                    const part = pathParts[i];
                                    if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) {
                                        current[part] = {};
                                    }
                                    current = current[part] as Record<string, unknown>;
                                }
                                current[pathParts[pathParts.length - 1]] = value;
                                return obj;
                            };

                            const updatedVars = setNestedValue(
                                { ...(currentM.vars as Record<string, unknown> || {}) },
                                'toolToken',
                                token
                            );
                            currentM.vars = updatedVars;
                            (currentM.memory as any) = { ...((currentM.memory as any) || {}), vars: updatedVars };
                        }

                        if (opts.setStage && currentM?.control) {
                            const currentStage = currentM.control.stage;
                            const targetStage = opts.setStage;

                            if (typeof targetStage === 'string' && targetStage.length > 0) {
                                currentM.control.stage = targetStage;
                                try { log.info('Auto stage transition', { from: currentStage, to: targetStage, trigger: 'tool_invoked' }); } catch { }
                            }
                        }

                        const expectedWmVersion = currentSnap?.wmVersion ?? BigInt(0);
                        await this.sessionManager.saveSnapshot({
                            tenantId,
                            sessionId,
                            agentId: (currentSnap as any)?.agentId || 'default',
                            expectedWmVersion,
                            snapshot: currentBase
                        });
                    }
                } catch (error) {
                    try { log.warn('Failed to apply tool auto token/stage options', { error: error instanceof Error ? error.message : String(error) }); } catch { }
                }
            }

            try {
                ctx.progress({ state: 'working', timestamp: new Date().toISOString(), metadata: { token, toolName, awaiting: 'tool' } } as any);
            } catch { /* noop */ }
            (ctx as any).__wmSavedThisTurn = true;
            return { token } as any;
        };

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

        (ctx as any).sendTaskToAgent = async (
            agent: string,
            childInput: unknown,
            options?: {
                awaitCompletion?: boolean;
                streaming?: boolean;
                onCompleted?: string;
                onFailed?: string;
                onInputRequired?: string;
                setToken?: boolean;
                tokenPath?: string;
                autoClearToken?: boolean;
                setStage?: string;
            }
        ) => {
            if (!this.sessionManager) throw new Error('Session manager not configured');
            const maxChildren = 50; // TODO: make configurable
            const snapLimits = await this.sessionManager.load(tenantId, sessionId);
            const baseLimits = (snapLimits?.snapshot as Record<string, unknown>) || {};
            const tasksNow = getPendingTasks(baseLimits);
            if (Object.keys(tasksNow).length >= maxChildren) {
                throw new Error('LIMIT_MAX_CHILDREN_EXCEEDED');
            }
            const { handle, token } = await createTaskHandle(this.sessionManager, tenantId, sessionId, agent, childInput);

            const tokenPath = options?.tokenPath ?? 'child.token';
            const shouldSetToken = options?.setToken !== false;
            const autoClearToken = options?.autoClearToken !== false;

            if (shouldSetToken) {
                try { ctx.vars.set(tokenPath, token); } catch { /* noop */ }
            }
            if (options?.setStage) {
                try { ctx.vars.set('stage', options.setStage); } catch { /* noop */ }
            }

            const snapOptions = await this.sessionManager.load(tenantId, sessionId);
            const baseOptions = (snapOptions?.snapshot as Record<string, unknown>) || {};
            const tasks = getPendingTasks(baseOptions);
            if (tasks[token]) {
                tasks[token].options = {
                    setToken: shouldSetToken,
                    tokenPath,
                    autoClearToken,
                    setStage: options?.setStage
                };
                const next = setPendingTasks(baseOptions, tasks);
                // Option 1B: Retry-based coordination - load latest version and retry on CAS failure
                let retryCount = 0;
                const maxRetries = 3;
                let success = false;

                while (!success && retryCount < maxRetries) {
                    try {
                        const latestSnap = await this.sessionManager.load(tenantId, sessionId);
                        const nextExpected = latestSnap?.wmVersion ?? BigInt(0);
                        await this.sessionManager.saveSnapshot({
                            tenantId,
                            sessionId,
                            agentId: (latestSnap as any)?.agentId || 'default',
                            expectedWmVersion: nextExpected,
                            snapshot: next
                        });
                        success = true;
                    } catch (error) {
                        if ((error as Error).message === 'CAS_MISMATCH' && retryCount < maxRetries - 1) {
                            retryCount++;
                            // Small delay before retry
                            await new Promise(resolve => setTimeout(resolve, 10));
                        } else {
                            throw error;
                        }
                    }
                }

                if (!success) {
                    throw new Error('CAS_MISMATCH after max retries');
                }
            }

            if (options?.onInputRequired) { try { await (handle as any).onInputRequired(options.onInputRequired); } catch { } }
            if (options?.onCompleted) { try { await (handle as any).onCompleted(options.onCompleted); } catch { } }
            if (options?.onFailed) { try { await (handle as any).onFailed(options.onFailed); } catch { } }
            const minimalCtx = ctx as any;

            const dispatch = async (runOpts?: { awaitCompletion?: boolean; streaming?: boolean }) => {
                (ctx as any).logger?.info?.('Child dispatch', { parentTaskId: sessionId, childAgent: agent, token });
                try { await flushMentalState(); } catch { /* best-effort */ }

                // ✅ FIX: Determine awaitCompletion BEFORE calling sendTaskToAgent
                // This is critical so A2AService can stage the observation synchronously
                const snapBefore = await this.sessionManager!.load(tenantId, sessionId);
                const baseBefore = (snapBefore?.snapshot as Record<string, unknown>) || {};
                const tasksBefore = getPendingTasks(baseBefore) as any;
                const entryBefore = tasksBefore[token];
                const hasCompleted = !!entryBefore?.handlers?.completed;
                const awaitCompletion = runOpts?.awaitCompletion ?? options?.awaitCompletion ?? (!hasCompleted);

                const a2aOptions = {
                    tenantId,
                    streaming: (runOpts?.streaming ?? options?.streaming) === true,
                    awaitCompletion // ✅ Pass awaitCompletion explicitly
                } as any;
                try { log.info('A2A dispatch', { tenantId, sessionId, token, agent, awaitCompletion }); } catch { }
                try {
                    const result = await globalA2AService.sendTaskToAgent(minimalCtx, agent, childInput as any, {
                        ...(options || {}),
                        ...a2aOptions,
                        parentTenantId: tenantId,
                        parentTaskId: sessionId,
                        parentChildToken: token
                    } as any);
                    if (result && typeof result === 'object' && (result as any).status === 'input_required') {
                        (ctx as any).logger?.info?.('Child input_required', { parentTaskId: sessionId, childAgent: agent, token });
                        return;
                    }
                    // awaitCompletion already determined above
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

            const result = await dispatch({});
            return result ?? handle;
        };

        (ctx as any).allTasks = async (
            children: Array<{ agent: string; input: unknown }>,
            opts?: { withTimeoutMs?: number; cancelRemaining?: boolean; onAllCompleted?: string; onAnyFailed?: string }
        ) => {
            if (!this.sessionManager) throw new Error('Session manager not configured');
            const maxGroup = 50; // TODO: make configurable
            if (children.length > maxGroup) throw new Error('LIMIT_MAX_GROUP_CHILDREN_EXCEEDED');
            const childTokens: string[] = [];
            for (const child of children) {
                const { handle, token } = await createTaskHandle(this.sessionManager, tenantId, sessionId, child.agent);
                childTokens.push(token);
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
    }

    // Attach working memory var proxy to an existing context so that writes are CAS-persisted
    public async attachWorkingMemory(ctx: TaskContext, tenantId: string, sessionId: string, agentId: string): Promise<void> {
        if (!this.sessionManager) return;

        // ✅ FIX Bug #1 Issue 1A: Load existing vars from snapshot (like startTask does)
        const snapshot = await this.sessionManager.load(tenantId, sessionId);
        const M = (snapshot?.snapshot as any)?.M;
        const currentVars = ((M?.memory as any)?.vars || {}) as Record<string, unknown>;
        const varCache = new Map<string, unknown>(Object.entries(currentVars));
        if (!(ctx as any).__ctxId) (ctx as any).__ctxId = `ctx-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const ensureVarsId = () => {
            const varsObj = (ctx as any).vars;
            if (varsObj && !(varsObj as any).__varsId) {
                (varsObj as any).__varsId = `vars-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            }
        };
        ensureVarsId();
        log.debug('attachWorkingMemory loaded vars', {
            sessionId,
            agentId,
            count: varCache.size,
            keys: Array.from(varCache.keys())
        });


        if (!(ctx as any).tenantId) (ctx as any).tenantId = tenantId;
        if (!(ctx as any).agentId) (ctx as any).agentId = agentId;
        if (M && !(ctx as any).__mental) {
            (ctx as any).__mental = M;
        }

        // ✅ FIX: Only set up ctx.vars if it doesn't already exist (e.g., from extendContextWithMemory)
        // This prevents overwriting a working vars proxy that was already set up
        if (!(ctx as any).vars) {
            const changeHooks = new Set<(key: string, value: unknown) => void>();
            const deleteHooks = new Set<(key: string) => void>();
            const clearHooks = new Set<() => void>();

            const registerHooks: WorkingVarHookRegistrarFn = hooks => {
                if (!hooks) return;
                if (hooks.onChange) changeHooks.add(hooks.onChange);
                if (hooks.onDelete) deleteHooks.add(hooks.onDelete);
                if (hooks.onClear) clearHooks.add(hooks.onClear);
            };

            const notifyChange = (key: string, value: unknown): void => {
                for (const handler of changeHooks) {
                    try { handler(key, value); } catch { /* noop */ }
                }
            };

            const notifyDelete = (key: string): void => {
                for (const handler of deleteHooks) {
                    try { handler(key); } catch { /* noop */ }
                }
            };

            const notifyClear = (): void => {
                for (const handler of clearHooks) {
                    try { handler(); } catch { /* noop */ }
                }
            };

            (ctx as any).vars = new Proxy({} as Record<string, unknown>, {
                get: (_t, prop: string) => {
                    // Handle Map-like method access
                    if (prop === 'get') return (key: string) => varCache.get(key);
                    if (prop === 'set') return (key: string, value: unknown) => {
                        varCache.set(key, value);
                        notifyChange(key, value);
                        (async () => {
                            try {
                                const snapNow = await this.sessionManager!.load(tenantId, sessionId);
                                const base = (snapNow?.snapshot as Record<string, unknown>) || {};
                                // Store vars in M.memory.vars to align with APLRET framework expectations
                                let M = (base as any).M;
                                if (!M) {
                                    // Initialize M if it doesn't exist
                                    const { initialM } = await import('../../loop/init.js');
                                    M = initialM(ctx);
                                }
                                M.memory = M.memory || {};
                                M.memory.vars = M.memory.vars || {};
                                (M.memory.vars as any)[key] = value;
                                const next = { ...base, M } as Record<string, unknown>;
                                // Option 1B: Retry-based coordination for vars saves
                                let varRetryCount = 0;
                                const varMaxRetries = 3;
                                let varSuccess = false;

                                while (!varSuccess && varRetryCount < varMaxRetries) {
                                    try {
                                        const latestVarSnap = await this.sessionManager!.load(tenantId, sessionId);
                                        const varExpected = latestVarSnap?.wmVersion ?? BigInt(0);
                                        await this.sessionManager!.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || agentId, expectedWmVersion: varExpected, snapshot: next });
                                        varSuccess = true;
                                        // Update coordinated version to reflect the new save
                                        (ctx as any).__coordinatedVersion = varExpected + BigInt(1);
                                    } catch (varError) {
                                        log.warn('ctx.vars CAS retry failed', {
                                            key,
                                            attempt: varRetryCount,
                                            error: (varError as Error).message
                                        });
                                        if ((varError as Error).message === 'CAS_MISMATCH' && varRetryCount < varMaxRetries - 1) {
                                            varRetryCount++;
                                            await new Promise(resolve => setTimeout(resolve, 5));
                                        } else {
                                            throw varError;
                                        }
                                    }
                                }

                                if (varSuccess) {
                                    await this.sessionManager!.appendEvent(tenantId, sessionId, 'wm.vars_updated', { key: String(key) });
                                } else {
                                    log.error('ctx.vars CAS retries exhausted', { key });
                                }
                            } catch { /* best-effort */ }
                        })();
                        return true;
                    };
                    if (prop === 'has') return (key: string) => varCache.has(key);
                    if (prop === 'delete') return (key: string) => {
                        varCache.delete(key);
                        notifyDelete(key);
                        return true;
                    };
                    if (prop === 'keys') return () => varCache.keys();
                    if (prop === 'values') return () => varCache.values();
                    if (prop === 'entries') return () => varCache.entries();
                    if (prop === 'clear') return () => {
                        varCache.clear();
                        notifyClear();
                    };
                    if (prop === 'size') return varCache.size;
                    if (prop === 'forEach') return (callback: (value: unknown, key: string) => void) => varCache.forEach(callback);
                    if (prop === '__registerWorkingVarHooks') return registerHooks;
                    // Handle normal property access
                    return varCache.get(prop);
                },
                set: (_t, prop: string, value: unknown) => {
                    varCache.set(prop, value);
                    notifyChange(String(prop), value);
                    (async () => {
                        try {
                            const snapNow = await this.sessionManager!.load(tenantId, sessionId);
                            const base = (snapNow?.snapshot as Record<string, unknown>) || {};
                            // Store vars in M.memory.vars to align with APLRET framework expectations
                            let M = (base as any).M;
                            if (!M) {
                                // Initialize M if it doesn't exist
                                const { initialM } = await import('../../loop/init.js');
                                M = initialM(ctx);
                            }
                            M.memory = M.memory || {};
                            M.memory.vars = M.memory.vars || {};
                            (M.memory.vars as any)[prop] = value;
                            const next = { ...base, M } as Record<string, unknown>;
                            const expected = snapNow?.wmVersion ?? BigInt(0);
                            await this.sessionManager!.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || agentId, expectedWmVersion: expected, snapshot: next });
                            await this.sessionManager!.appendEvent(tenantId, sessionId, 'wm.vars_updated', { key: String(prop) });
                        } catch { /* best-effort */ }
                    })();
                    return true;
                },
                has: (_t, prop: string) => varCache.has(prop),
                deleteProperty: (_t, prop: string) => {
                    varCache.delete(prop);
                    notifyDelete(String(prop));
                    (async () => {
                        try {
                            const snapNow = await this.sessionManager!.load(tenantId, sessionId);
                            const base = (snapNow?.snapshot as Record<string, unknown>) || {};
                            const M = (base as any).M;
                            if (!M?.memory?.vars) return;
                            delete (M.memory.vars as Record<string, unknown>)[prop];
                            const next = { ...base, M } as Record<string, unknown>;
                            const expected = snapNow?.wmVersion ?? BigInt(0);
                            await this.sessionManager!.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || agentId, expectedWmVersion: expected, snapshot: next });
                            await this.sessionManager!.appendEvent(tenantId, sessionId, 'wm.vars_updated', { key: String(prop), deleted: true });
                        } catch { /* best-effort */ }
                    })();
                    return true;
                },
                ownKeys: () => Array.from(varCache.keys()),
                getOwnPropertyDescriptor: (_t, prop: string) =>
                    varCache.has(prop as string) ? { enumerable: true, configurable: true } : undefined
            });
            log.debug('attachWorkingMemory created fallback vars proxy', {
                sessionId,
                agentId,
                hasRegisterFn: typeof ((ctx as any).vars as any).__registerWorkingVarHooks === 'function'
            });
        } else {
            // ctx.vars already exists (from extendContextWithMemory), sync existing vars into it
            try {
                const existingVars = (ctx as any).vars;
                ensureVarsId();
                if (existingVars && typeof existingVars.set === 'function') {
                    log.debug('attachWorkingMemory seeding existing vars', {
                        sessionId,
                        count: varCache.size
                    });
                    for (const [key, value] of varCache.entries()) {
                        try {
                            existingVars.set(key, value);
                        } catch { /* best-effort sync */ }
                    }
                    this.registerWorkingVarHooks(ctx, existingVars, varCache);
                }
            } catch { /* best-effort sync */ }
        }

        await this.attachOrchestrationAPIs(ctx, {
            tenantId,
            sessionId,
            agentId,
            flushMentalState: async () => {
                await this.flushContextSnapshot(tenantId, sessionId, agentId, ctx);
            }
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
        const mentalFromCtx = (() => { try { return (ctx as any).__mental; } catch { return undefined; } })();
        if (!M && mentalFromCtx) { M = mentalFromCtx; }
        if (!M) { try { const { initialM } = await import('../../loop/init.js'); M = initialM(ctx); } catch { M = { memory: { vars: {}, sensory: {} }, goalState: { hierarchy: { nodes: {}, roots: [] } } } }; }
        // Merge vars without dropping Learning's contributions
        try {
            const snapshotVars = (((M.memory as any)?.vars) || {}) as Record<string, unknown>;
            const mentalVars = (((mentalFromCtx as any)?.memory as any)?.vars) || {} as Record<string, unknown>;
            const mergedVars = { ...mentalVars, ...snapshotVars, ...plainVars } as Record<string, unknown>;
            M.memory = { ...(M.memory || {}), vars: mergedVars };
        } catch { /* noop */ }
        // Attach LLM state into sensory
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
        try {
            const snap = await this.sessionManager.load(tenantId, sessionId);
            const expected = snap?.wmVersion ?? BigInt(0);
            const next = { ...(baseSnap as any), M } as Record<string, unknown>;
            await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || agentId, expectedWmVersion: expected, snapshot: next });
        } catch (e) {
            if ((e as Error).message === 'CAS_MISMATCH') {
                try {
                    const snap2 = await this.sessionManager.load(tenantId, sessionId);
                    const expected2 = snap2?.wmVersion ?? BigInt(0);
                    const next2 = { ...(((await this.sessionManager.load(tenantId, sessionId))?.snapshot as any) || {}), M } as Record<string, unknown>;
                    await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || agentId, expectedWmVersion: expected2, snapshot: next2 });
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

        // 🔍 DEBUG: Check what session was loaded
        log.debug('🔍 DEBUG: Session loaded', {
            tenantId,
            sessionId,
            hasSession: !!session,
            hasSnapshot: !!session?.snapshot,
            metaTurn: (session?.snapshot as any)?.meta?.turn,
            wmVersion: session?.wmVersion?.toString()
        });

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

        const assignVarsIntoMental = () => {
            const varsObject = Object.fromEntries(varCache) as Record<string, unknown>;
            const mergedVars: Record<string, unknown> = {};
            iterMentalTargets(({ existing }) => {
                Object.assign(mergedVars, existing);
            });
            Object.assign(mergedVars, varsObject);
            iterMentalTargets(({ target, memory }) => {
                try {
                    log.debug('Variable assignment completed', {
                        mergedKeysCount: Object.keys(mergedVars).length
                    });
                } catch { /* noop */ }
                (memory as Record<string, unknown>).vars = { ...mergedVars };
                target.vars = { ...mergedVars };
            });
        };

        const deleteNestedValue = (obj: Record<string, unknown>, path: string): { next: Record<string, unknown>; changed: boolean } => {
            const pathParts = path.split('.');
            if (pathParts.length === 0) {
                return { next: { ...obj }, changed: false };
            }

            const clone = { ...obj } as Record<string, unknown>;
            let currentClone: Record<string, unknown> = clone;
            let currentOrig: Record<string, unknown> | undefined = obj;

            for (let i = 0; i < pathParts.length - 1; i++) {
                const part = pathParts[i];
                const nextOrig = currentOrig?.[part];
                if (!nextOrig || typeof nextOrig !== 'object' || Array.isArray(nextOrig)) {
                    return { next: clone, changed: false };
                }
                const nextClone = { ...(nextOrig as Record<string, unknown>) };
                currentClone[part] = nextClone;
                currentClone = nextClone;
                currentOrig = nextOrig as Record<string, unknown>;
            }

            const leafKey = pathParts[pathParts.length - 1];
            if (!currentOrig || !Object.prototype.hasOwnProperty.call(currentOrig, leafKey)) {
                return { next: clone, changed: false };
            }

            delete currentClone[leafKey];
            return { next: clone, changed: true };
        };

        const removeKeyFromMental = (key: string): void => {
            iterMentalTargets(({ target, memory, existing }) => {
                let updated: Record<string, unknown> | undefined;

                if (key.includes('.')) {
                    const { next, changed } = deleteNestedValue(existing, key);
                    if (!changed) return;
                    updated = next;
                } else {
                    if (!Object.prototype.hasOwnProperty.call(existing, key)) return;
                    updated = { ...existing };
                    delete updated[key];
                }

                (memory as Record<string, unknown>).vars = updated;
                target.vars = updated;
            });
        };

        // Helper function to handle nested paths
        const setNestedValue = (obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> => {
            const pathParts = path.split('.');
            let current = obj;

            // Navigate to parent of the target
            for (let i = 0; i < pathParts.length - 1; i++) {
                const part = pathParts[i];
                if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) {
                    current[part] = {};
                }
                current = current[part] as Record<string, unknown>;
            }

            // Set the final value
            current[pathParts[pathParts.length - 1]] = value;
            return obj;
        };

        const getNestedValue = (obj: Record<string, unknown>, path: string): unknown => {
            const pathParts = path.split('.');
            let current = obj;

            for (const part of pathParts) {
                if (!current || typeof current !== 'object' || Array.isArray(current)) {
                    return undefined;
                }
                current = (current as Record<string, unknown>)[part] as Record<string, unknown>;
            }

            return current;
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
            get: (key: string) => {
                // Handle nested paths
                if (key.includes('.')) {
                    const baseKey = key.split('.')[0];
                    const baseObj = varCache.get(baseKey) as Record<string, unknown>;
                    if (baseObj && typeof baseObj === 'object' && !Array.isArray(baseObj)) {
                        return getNestedValue(baseObj, key.substring(key.indexOf('.') + 1));
                    }
                    return undefined;
                }
                return varCache.get(key);
            },
            set: (key: string, value: unknown) => {
                // Handle nested paths
                if (key.includes('.')) {
                    const baseKey = key.split('.')[0];
                    const currentObj = (varCache.get(baseKey) as Record<string, unknown>) || {};
                    const updatedObj = setNestedValue({ ...currentObj }, key.substring(key.indexOf('.') + 1), value);
                    varCache.set(baseKey, updatedObj);
                } else {
                    varCache.set(key, value);
                }
                (ctx as any).__varsDirty = true;
                // ✅ FIX: Don't call assignVarsIntoMental during turn - it overwrites Learning's changes!
                // assignVarsIntoMental will be called at end of turn in mergeVarsIntoMental
            },
            merge: (patch: Record<string, unknown>) => {
                for (const [k, v] of Object.entries(patch)) {
                    // For merge, we don't treat dots as paths - it's for object merging
                    const current = varCache.get(k);
                    if (current && typeof current === 'object' && !Array.isArray(current) &&
                        v && typeof v === 'object' && !Array.isArray(v)) {
                        // Deep merge objects
                        const merged = { ...(current as Record<string, unknown>), ...(v as Record<string, unknown>) };
                        varCache.set(k, merged);
                    } else {
                        varCache.set(k, v);
                    }
                }
                (ctx as any).__varsDirty = true;
                // ✅ FIX: Don't call assignVarsIntoMental during turn - it overwrites Learning's changes!
            },
            update: (key: string, fn: (prev: unknown) => unknown) => {
                let currentValue: unknown;

                // Handle nested paths
                if (key.includes('.')) {
                    const baseKey = key.split('.')[0];
                    const baseObj = (varCache.get(baseKey) as Record<string, unknown>) || {};
                    currentValue = getNestedValue(baseObj, key.substring(key.indexOf('.') + 1));
                } else {
                    currentValue = varCache.get(key);
                }

                const next = fn(currentValue);

                // Set the updated value
                if (key.includes('.')) {
                    const baseKey = key.split('.')[0];
                    const currentObj = (varCache.get(baseKey) as Record<string, unknown>) || {};
                    const updatedObj = setNestedValue({ ...currentObj }, key.substring(key.indexOf('.') + 1), next);
                    varCache.set(baseKey, updatedObj);
                } else {
                    varCache.set(key, next);
                }

                (ctx as any).__varsDirty = true;
                // ✅ FIX: Don't call assignVarsIntoMental during turn - it overwrites Learning's changes!
            },
            delete: (key: string) => {
                // Handle nested paths
                if (key.includes('.')) {
                    const baseKey = key.split('.')[0];
                    const currentObj = (varCache.get(baseKey) as Record<string, unknown>);
                    if (currentObj && typeof currentObj === 'object' && !Array.isArray(currentObj)) {
                        const updatedObj = { ...currentObj };
                        const pathParts = key.substring(key.indexOf('.') + 1).split('.');
                        let current = updatedObj;

                        // Navigate to parent of the target
                        for (let i = 0; i < pathParts.length - 1; i++) {
                            const part = pathParts[i];
                            if (current[part] && typeof current[part] === 'object' && !Array.isArray(current[part])) {
                                current = current[part] as Record<string, unknown>;
                            }
                        }

                        // Delete the target property
                        delete current[pathParts[pathParts.length - 1]];
                        varCache.set(baseKey, updatedObj);
                        removeKeyFromMental(key);
                    }
                } else {
                    varCache.delete(key);
                    removeKeyFromMental(key);
                }
                (ctx as any).__varsDirty = true;
                // ✅ FIX: Don't call assignVarsIntoMental during turn - it overwrites Learning's changes!
            },
            keys: () => Array.from(varCache.keys()),
            has: (key: string) => {
                // Handle nested paths
                if (key.includes('.')) {
                    return (ctx as any).vars.get(key) !== undefined;
                }
                return varCache.has(key);
            }
        } as any;
        // Ensure alias is initialized before loop modules read mentalState.vars
        try { assignVarsIntoMental(); } catch { /* noop */ }

        await this.attachOrchestrationAPIs(ctx, {
            tenantId,
            sessionId,
            agentId: (ctx as any).agentId || 'default',
            flushMentalState
        });

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
            try { log.info('Task execution start', { runMode, agentId: (ctx as any).agentId }); } catch { }

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
                // Build EnvironmentState from snapshot and context
                const base = (session?.snapshot as any) || {};
                const startTurnTotal = Number(base?.meta?.turn) || 0;

                // 🔍 DEBUG: Check turn initialization
                const agentIdForDebug = (ctx as any).agentId;
                const pluginForDebug = agentIdForDebug ? PluginManager.findAgent(agentIdForDebug) : null;
                log.debug('🔍 DEBUG: Turn initialization', {
                    sessionId,
                    tenantId,
                    baseMetaTurn: base?.meta?.turn,
                    startTurnTotal,
                    envTurnWillBe: startTurnTotal + 1,
                    maxTurns: (pluginForDebug?.manifest as any)?.budgets?.maxTurns
                });

                let envInbox = normalizeInbox((base as any)?.inbox);


                // If inbox is empty, check for child completion events that might not be in the snapshot
                // This handles the case where handleChildCompleted ran but failed to persist the inbox,
                // or where the deferred notification hasn't run yet but the child has completed
                if (envInbox.current.length === 0 && this.sessionManager) {
                    try {
                        // Check meta.lastChildToken first (set by handleChildCompleted after processing)
                        const lastChildToken = (base?.meta as any)?.lastChildToken;
                        const pendingChildren = (base?.pending?.children) || {};
                        const pendingChildTokens = Object.keys(pendingChildren);

                        // Collect all potential child tokens to check
                        const tokensToCheck = new Set<string>();
                        if (lastChildToken) tokensToCheck.add(lastChildToken);
                        pendingChildTokens.forEach(t => tokensToCheck.add(t));


                        if (tokensToCheck.size > 0) {
                            // Check for child_completed events that might not be in the snapshot inbox
                            const events = await this.sessionManager.listEventsSince({ tenantId, sessionId, sinceSeq: 0 });
                            const childCompletedEvents = events.filter(e => e.type === 'task.child_completed');

                            // For each token, check if there's a completion event
                            for (const token of tokensToCheck) {
                                const completionEvent = childCompletedEvents.find(e =>
                                    (e.payload as any)?.token === token
                                );

                                if (completionEvent) {
                                    const observationPredicate = (obs: Observation) =>
                                        obs?.kind === 'child.completed' &&
                                        typeof obs === 'object' &&
                                        obs !== null &&
                                        (obs as any)?.payload &&
                                        (obs as any).payload.token === token;

                                    const childObservation: Observation = {
                                        source: 'child',
                                        kind: 'child.completed',
                                        payload: {
                                            token,
                                            childTaskId: (completionEvent.payload as any)?.childTaskId,
                                            result: (completionEvent.payload as any)?.result,
                                            agentId: (completionEvent.payload as any)?.agentId
                                        },
                                        provenance: {
                                            ts: new Date(completionEvent.createdAt).getTime(),
                                            turn: startTurnTotal + 1,
                                            id: token,
                                            correlationId: token
                                        }
                                    };
                                    envInbox = addObservationToInboxIfMissing(envInbox, childObservation, observationPredicate);
                                }
                            }
                        }
                    } catch (error) {
                        // If event lookup fails, continue with empty inbox (better than crashing)
                        log.warn('Failed to check for child completion events on resume', {
                            error: error instanceof Error ? error.message : String(error),
                            sessionId
                        });
                    }
                }

                const env: EnvironmentState = {
                    time: new Date().toISOString(),
                    input: ctx.task.input,
                    sessionId,
                    turn: startTurnTotal + 1,
                    budget: { maxTurns: Infinity, latencyMs: Infinity }, // we will override this with the actual budgets from the manifest
                    inbox: envInbox,
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
                    log.debug('Plugin loaded', {
                        pluginKeys: Object.keys((plugin as any) || {}),
                        hasLoop: !!(plugin as any)?.loop,
                        agentId,
                        loopOverrides: Object.keys(overrides)
                    });
                } catch { }
                // Derive default budgets and hitl from manifest if available
                let loopOpts: { maxTurns?: number; latencyMs?: number } = {};
                try {
                    const b = (plugin?.manifest as any)?.budgets;
                    const hitl = (plugin?.manifest as any)?.hitl;
                    if (hitl) { try { (M as any).hitl = hitl; } catch { /* noop */ } }
                    if (b && typeof b === 'object') loopOpts = { maxTurns: (b as any).maxTurns, latencyMs: (b as any).latencyMs };
                    try { (env as any).budget = { maxTurns: loopOpts.maxTurns, latencyMs: loopOpts.latencyMs }; } catch { }
                } catch { /* ignore */ }
                log.debug('Loop options configured', loopOpts);
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
                        // Merge latest ctx.vars (written via proxy to M.memory.vars) into mNext before saving
                        // This addresses cases where runLoop returns a new MentalState instance that
                        // does not share object identity with M updated by assignVarsIntoMental()
                        let mNextWithVars = this.mergeVarsIntoMental(M as any, mNext as any);
                        const nextInboxAfterStart = normalizeInbox(env.inbox);
                        const nextAfterStart = { ...baseAfterStart, M: mNextWithVars, meta: nextMetaAfterStart, inbox: nextInboxAfterStart } as Record<string, unknown>;
                        await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: ((ctx as any).agentId || 'default') as string, expectedWmVersion: expectedAfterStart, snapshot: nextAfterStart });
                        // Avoid later flush overwriting this save with stale M
                        (ctx as any).__wmSavedThisTurn = true;
                    }
                } catch { /* noop */ }
                log.debug('RunLoop completed', { outcome: outcome.kind, hasToken: !!(outcome as any).token });
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
                            // Merge latest ctx.vars into the MentalState being saved.
                            // assignVarsIntoMental() updates M.memory.vars; runLoop may return a new MentalState (mNext)
                            // that does not share identity with M, so ensure vars are carried over.
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
                            let mNextEffective = mNext;
                            try {
                                const latestVars = (((M as any)?.memory as any)?.vars) || {};
                                if (latestVars && typeof latestVars === 'object') {
                                    const mem = ((mNextEffective as any).memory || {}) as Record<string, unknown>;
                                    (mNextEffective as any).memory = { ...mem, vars: { ...(latestVars as Record<string, unknown>) } };
                                }
                            } catch { /* noop merge failure */ }
                            const nextInbox = normalizeInbox(env.inbox);
                            const next = { ...baseNow, M: mNextEffective, meta: nextMeta, inbox: nextInbox } as Record<string, unknown>;
                            await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || 'default', expectedWmVersion: expected, snapshot: next });
                            (ctx as any).__wmSavedThisTurn = true;
                        } else {
                            // Even if M was saved earlier in the turn, increment turnTotal meta
                            const snapNow = await this.sessionManager.load(tenantId, sessionId);
                            const expected = snapNow?.wmVersion ?? BigInt(0);
                            const baseNow = (snapNow?.snapshot as Record<string, unknown>) || {};
                            const prevMeta = (baseNow as any).meta || {};
                            const nextMeta = { ...prevMeta, turn: env.turn };
                            const next = { ...baseNow, meta: nextMeta, inbox: normalizeInbox(env.inbox) } as Record<string, unknown>;
                            await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || 'default', expectedWmVersion: expected, snapshot: next });
                        }
                    } catch { /* noop */ }
                }
                log.debug('Processing outcome', { outcome: outcome.kind, isStreaming });
                if (!isStreaming) {
                    if (outcome.kind === 'await_input') {
                        log.info('Task awaiting input', { token: outcome.token });
                        task.status = { state: 'input-required', timestamp: new Date().toISOString(), metadata: { token: outcome.token, awaitExtra: { kind: outcome.kind }, timings: metrics?.timings, rewards: metrics?.rewards, timingsAgg, rewardsAgg } } as any;
                        return task;
                    }
                    if (outcome.kind === 'await_child' || outcome.kind === 'await_tool') {
                        log.info('Task awaiting completion', { kind: outcome.kind, token: (outcome as any).token });
                        const token = (outcome as any).token;
                        const extra = { kind: outcome.kind, token };
                        task.status = { state: 'working', timestamp: new Date().toISOString(), metadata: { awaiting: outcome.kind, token, awaitExtra: extra, timings: metrics?.timings, rewards: metrics?.rewards, timingsAgg, rewardsAgg } } as any;
                        return task;
                    }
                    if (outcome.kind === 'fail') {
                        log.warn('Task failed', { reason: outcome.reason });
                        task.status = {
                            state: 'failed',
                            timestamp: new Date().toISOString(),
                            message: { role: 'agent', parts: [{ type: 'text', text: `Loop failed: ${outcome.reason}` }] },
                            metadata: { reason: outcome.reason, timings: metrics?.timings, rewards: metrics?.rewards, timingsAgg, rewardsAgg }
                        } as any;
                        return task;
                    }
                    if (outcome.kind === 'complete') {
                        log.info('Task completed successfully');
                        task.status = {
                            state: 'completed',
                            timestamp: new Date().toISOString(),
                            metadata: { result: outcome.result, timings: metrics?.timings, rewards: metrics?.rewards, timingsAgg, rewardsAgg }
                        } as any;
                        // Publish final completion event for cache listener and other subscribers
                        try {
                            eventBus.publish(taskChannel(task.id), {
                                id: task.id,
                                status: task.status,
                                final: true
                            } as any);
                        } catch { }
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
            log.error('Task engine error', { error: error instanceof Error ? error.message : String(error) });

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
        log.debug('Resume input processing started');
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
                (ctx as any).requestInput = async (promptOrParts: string | string[] | import('../../shared/types/index.js').MessagePart | import('../../shared/types/index.js').MessagePart[], opts?: { ttlMs?: number; schema?: unknown; onProvided?: string; onExpired?: string; __existingToken?: string; setToken?: boolean; setStage?: string }) => {
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

                    // Normalize promptOrParts into parts[] and derive a fallback prompt string
                    const normalizeParts = (p: string | string[] | import('../../shared/types/index.js').MessagePart | import('../../shared/types/index.js').MessagePart[]): import('../../shared/types/index.js').MessagePart[] => {
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
                                const next2 = setPendingInputs(base2, pending2);
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
            const startTurnTotal = Number((baseNow as any)?.meta?.turn) || 0;
            // Reattach working variables facade linked to this MentalState (resume path)
            try {
                const currentVars = ((M as any)?.memory?.vars || {}) as Record<string, unknown>;
                const varCache = new Map<string, unknown>(Object.entries(currentVars));
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

                const assignVarsIntoMental = () => {
                    const varsObject = Object.fromEntries(varCache) as Record<string, unknown>;
                    const mergedVars: Record<string, unknown> = {};
                    iterMentalTargets(({ existing }) => {
                        Object.assign(mergedVars, existing);
                    });
                    Object.assign(mergedVars, varsObject);
                    iterMentalTargets(({ target, memory }) => {
                        try {
                            log.debug('Resume variable assignment', {
                                mergedKeys: Object.keys(mergedVars)
                            });
                        } catch { /* noop */ }
                        (memory as Record<string, unknown>).vars = { ...mergedVars };
                        target.vars = { ...mergedVars };
                    });
                };

                const deleteNestedValue = (obj: Record<string, unknown>, path: string): { next: Record<string, unknown>; changed: boolean } => {
                    const pathParts = path.split('.');
                    if (pathParts.length === 0) {
                        return { next: { ...obj }, changed: false };
                    }

                    const clone = { ...obj } as Record<string, unknown>;
                    let currentClone: Record<string, unknown> = clone;
                    let currentOrig: Record<string, unknown> | undefined = obj;

                    for (let i = 0; i < pathParts.length - 1; i++) {
                        const part = pathParts[i];
                        const nextOrig = currentOrig?.[part];
                        if (!nextOrig || typeof nextOrig !== 'object' || Array.isArray(nextOrig)) {
                            return { next: clone, changed: false };
                        }
                        const nextClone = { ...(nextOrig as Record<string, unknown>) };
                        currentClone[part] = nextClone;
                        currentClone = nextClone;
                        currentOrig = nextOrig as Record<string, unknown>;
                    }

                    const leafKey = pathParts[pathParts.length - 1];
                    if (!currentOrig || !Object.prototype.hasOwnProperty.call(currentOrig, leafKey)) {
                        return { next: clone, changed: false };
                    }

                    delete currentClone[leafKey];
                    return { next: clone, changed: true };
                };

                // Helper function to handle nested paths
                const setNestedValue = (obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> => {
                    const pathParts = path.split('.');
                    let current = obj;

                    // Navigate to parent of the target
                    for (let i = 0; i < pathParts.length - 1; i++) {
                        const part = pathParts[i];
                        if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) {
                            current[part] = {};
                        }
                        current = current[part] as Record<string, unknown>;
                    }

                    // Set the final value
                    current[pathParts[pathParts.length - 1]] = value;
                    return obj;
                };

                const getNestedValue = (obj: Record<string, unknown>, path: string): unknown => {
                    const pathParts = path.split('.');
                    let current = obj;

                    for (const part of pathParts) {
                        if (!current || typeof current !== 'object' || Array.isArray(current)) {
                            return undefined;
                        }
                        current = (current as Record<string, unknown>)[part] as Record<string, unknown>;
                    }

                    return current;
                };

                const removeKeyFromMental = (key: string): void => {
                    iterMentalTargets(({ target, memory, existing }) => {
                        let updated: Record<string, unknown> | undefined;

                        if (key.includes('.')) {
                            const { next, changed } = deleteNestedValue(existing, key);
                            if (!changed) return;
                            updated = next;
                        } else {
                            if (!Object.prototype.hasOwnProperty.call(existing, key)) return;
                            updated = { ...existing };
                            delete updated[key];
                        }

                        (memory as Record<string, unknown>).vars = updated;
                        target.vars = updated;
                    });
                };
                (ctx as any).vars = {
                    get: (key: string) => {
                        // Handle nested paths
                        if (key.includes('.')) {
                            const baseKey = key.split('.')[0];
                            const baseObj = varCache.get(baseKey) as Record<string, unknown>;
                            if (baseObj && typeof baseObj === 'object' && !Array.isArray(baseObj)) {
                                return getNestedValue(baseObj, key.substring(key.indexOf('.') + 1));
                            }
                            return undefined;
                        }
                        return varCache.get(key);
                    },
                    set: (key: string, value: unknown) => {
                        // Handle nested paths
                        if (key.includes('.')) {
                            const baseKey = key.split('.')[0];
                            const currentObj = (varCache.get(baseKey) as Record<string, unknown>) || {};
                            const updatedObj = setNestedValue({ ...currentObj }, key.substring(key.indexOf('.') + 1), value);
                            varCache.set(baseKey, updatedObj);
                        } else {
                            varCache.set(key, value);
                        }
                        assignVarsIntoMental();
                    },
                    merge: (patch: Record<string, unknown>) => {
                        for (const [k, v] of Object.entries(patch)) {
                            // For merge, we don't treat dots as paths - it's for object merging
                            const current = varCache.get(k);
                            if (current && typeof current === 'object' && !Array.isArray(current) &&
                                v && typeof v === 'object' && !Array.isArray(v)) {
                                // Deep merge objects
                                const merged = { ...(current as Record<string, unknown>), ...(v as Record<string, unknown>) };
                                varCache.set(k, merged);
                            } else {
                                varCache.set(k, v);
                            }
                        }
                        assignVarsIntoMental();
                    },
                    update: (key: string, fn: (prev: unknown) => unknown) => {
                        let currentValue: unknown;

                        // Handle nested paths
                        if (key.includes('.')) {
                            const baseKey = key.split('.')[0];
                            const baseObj = (varCache.get(baseKey) as Record<string, unknown>) || {};
                            currentValue = getNestedValue(baseObj, key.substring(key.indexOf('.') + 1));
                        } else {
                            currentValue = varCache.get(key);
                        }

                        const next = fn(currentValue);

                        // Set the updated value
                        if (key.includes('.')) {
                            const baseKey = key.split('.')[0];
                            const currentObj = (varCache.get(baseKey) as Record<string, unknown>) || {};
                            const updatedObj = setNestedValue({ ...currentObj }, key.substring(key.indexOf('.') + 1), next);
                            varCache.set(baseKey, updatedObj);
                        } else {
                            varCache.set(key, next);
                        }

                        assignVarsIntoMental();
                    },
                    delete: (key: string) => {
                        // Handle nested paths
                        if (key.includes('.')) {
                            const baseKey = key.split('.')[0];
                            const currentObj = (varCache.get(baseKey) as Record<string, unknown>);
                            if (currentObj && typeof currentObj === 'object' && !Array.isArray(currentObj)) {
                                const updatedObj = { ...currentObj };
                                const pathParts = key.substring(key.indexOf('.') + 1).split('.');
                                let current = updatedObj;

                                // Navigate to parent of the target
                                for (let i = 0; i < pathParts.length - 1; i++) {
                                    const part = pathParts[i];
                                    if (current[part] && typeof current[part] === 'object' && !Array.isArray(current[part])) {
                                        current = current[part] as Record<string, unknown>;
                                    }
                                }

                                // Delete the target property
                                delete current[pathParts[pathParts.length - 1]];
                                varCache.set(baseKey, updatedObj);
                                removeKeyFromMental(key);
                            }
                        } else {
                            varCache.delete(key);
                            removeKeyFromMental(key);
                        }
                        assignVarsIntoMental();
                    },
                    keys: () => Array.from(varCache.keys()),
                    has: (key: string) => {
                        // Handle nested paths
                        if (key.includes('.')) {
                            return (ctx as any).vars.get(key) !== undefined;
                        }
                        return varCache.has(key);
                    }
                } as any;
                assignVarsIntoMental();
            } catch { /* noop */ }
            const envInbox = normalizeInbox((baseNow as any)?.inbox);
            const env: EnvironmentState = {
                time: new Date().toISOString(),
                input: { kind: 'input', token, value: input },
                sessionId: taskId,
                turn: startTurnTotal + 1,
                pending: {
                    inputs: ((baseNow as any)?.pending?.inputs) || {},
                    children: ((baseNow as any)?.pending?.children) || {},
                    tools: ((baseNow as any)?.pending?.tools) || {},
                    groups: ((baseNow as any)?.pending?.groups) || {}
                },
                inbox: envInbox,
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
                try { (env as any).budget = { maxTurns: loopOpts.maxTurns, latencyMs: loopOpts.latencyMs }; } catch { }
            } catch { }
            const { M: mNext, outcome, metrics } = await runLoop(ctx, M, env, overrides, loopOpts);
            // Persist updated M with latest ctx.vars merged into mNext
            try {
                const snapAfter = await this.sessionManager!.load(tenantId, taskId);
                const expectedNow = snapAfter?.wmVersion ?? BigInt(0);
                const baseSnap = (snapAfter?.snapshot as Record<string, unknown>) || {};
                const mNextEffective = this.mergeVarsIntoMental(M as any, mNext as any);
                const prevMeta = ((baseSnap as any).meta || {}) as Record<string, unknown>;
                const nextMeta = { ...prevMeta, turn: env.turn } as Record<string, unknown>;
                const nextSnap = { ...baseSnap, M: mNextEffective, meta: nextMeta, inbox: normalizeInbox(env.inbox) } as Record<string, unknown>;
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
        const next = setPendingTools(base, tools) as Record<string, unknown>;
        const toolObservation: Observation = {
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
        (next as any).inbox = addObservationToInbox((next as any).inbox, toolObservation);
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
            const envInbox = normalizeInbox((baseNow as any)?.inbox);
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
                inbox: envInbox,
                lastExec: (baseNow as any)?.meta?.lastExec || undefined,
                externalEvents: undefined
            } as EnvironmentState;
            const overrides = (plugin as any)?.loop?.modules || (plugin as any)?.loop || {};
            let loopOpts: { maxTurns?: number; latencyMs?: number } = {};
            try {
                const b = (plugin?.manifest as any)?.budgets; const hitl = (plugin?.manifest as any)?.hitl;
                if (hitl) { try { (M as any).hitl = hitl; } catch { } }
                if (b && typeof b === 'object') {
                    loopOpts = { maxTurns: (b as any).maxTurns, latencyMs: (b as any).latencyMs };
                    try { (env as any).budget = { maxTurns: loopOpts.maxTurns, latencyMs: loopOpts.latencyMs }; } catch { }
                }
            } catch { }
            const { M: mNext, outcome, metrics } = await runLoop(ctx, M, env, overrides, loopOpts);
            // Persist and emit status (merge latest vars)
            try {
                const snapAfter = await this.sessionManager!.load(tenantId, taskId);
                const expectedNow = snapAfter?.wmVersion ?? BigInt(0);
                const baseSnap = (snapAfter?.snapshot as Record<string, unknown>) || {};
                const mNextEffective = this.mergeVarsIntoMental(M as any, mNext as any);
                const prevMeta = ((baseSnap as any).meta || {}) as Record<string, unknown>;
                const nextMeta = { ...prevMeta, turn: env.turn } as Record<string, unknown>;
                const nextSnap = { ...baseSnap, M: mNextEffective, meta: nextMeta, inbox: normalizeInbox(env.inbox) } as Record<string, unknown>;
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
        const next = setPendingExternalEvents(base, events) as Record<string, unknown>;
        const externalObservation: Observation = {
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
        (next as any).inbox = addObservationToInbox((next as any).inbox, externalObservation);
        await this.sessionManager?.saveSnapshot({ tenantId, sessionId: taskId, agentId: (base as any)?.meta?.agentId || 'default', expectedWmVersion: snap.wmVersion ?? BigInt(0), snapshot: next });
        await this.sessionManager?.appendEvent(tenantId, taskId, 'task.external_event_registered', { token, type: entry?.type });
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
            const envInbox = normalizeInbox((baseNow as any)?.inbox);
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
                inbox: envInbox,
                lastExec: (baseNow as any)?.meta?.lastExec || undefined,
                externalEvents: undefined
            } as EnvironmentState;
            const overrides = (plugin as any)?.loop?.modules || {};
            let loopOpts: { maxTurns?: number; latencyMs?: number } = { maxTurns: 1 };
            try {
                const b = (plugin?.manifest as any)?.budgets; const hitl = (plugin?.manifest as any)?.hitl;
                if (hitl) { try { (M as any).hitl = hitl; } catch { } }
                if (b && typeof b === 'object') loopOpts = { maxTurns: (b as any).maxTurns ?? 1, latencyMs: (b as any).latencyMs };
                try { (env as any).budget = { maxTurns: loopOpts.maxTurns, latencyMs: loopOpts.latencyMs }; } catch { }
            } catch { }
            const { M: mNext, outcome, metrics } = await runLoop(ctx, M, env, overrides, loopOpts);
            try {
                const snapAfter = await this.sessionManager!.load(tenantId, taskId);
                const expectedNow = snapAfter?.wmVersion ?? BigInt(0);
                const baseSnap = (snapAfter?.snapshot as Record<string, unknown>) || {};
                const executedTurns = 1;
                const prevMeta = (baseSnap as any).meta || {};
                const nextMeta = { ...prevMeta, turnTotal: (Number(prevMeta.turnTotal) || 0) + executedTurns };
                const mNextEffective = this.mergeVarsIntoMental(M as any, mNext as any);
                const nextSnap = { ...baseSnap, M: mNextEffective, meta: nextMeta, inbox: normalizeInbox(env.inbox) } as Record<string, unknown>;
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
            if (!token) {
                log.warn('Cannot stage observation: token not found', {
                    parentTaskId,
                    childToken,
                    childTaskId,
                    pendingTaskKeys: Object.keys(tasks)
                });
                return;
            }

            log.info('🔍 STAGING: Staging child completion observation', {
                parentTaskId,
                token,
                hasResult: !!result,
                pendingTaskKeys: Object.keys(tasks),
                tokenFound: !!token
            });

            const childObservation: Observation = {
                source: 'child',
                kind: 'child.completed',
                payload: { token, childTaskId, result, agentId: childAgentId },
                provenance: {
                    ts: Date.now(),
                    turn: Number((base as any)?.meta?.turn ?? 0) + 1,
                    id: token,
                    correlationId: token
                }
            };

            const next = { ...base };
            (next as any).inbox = addObservationToInbox((next as any).inbox, childObservation);
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
                    const latestInbox = normalizeInbox((latestNext as any)?.inbox);
                    const observationPredicate = (obs: Observation) =>
                        obs?.kind === 'child.completed' &&
                        typeof obs === 'object' &&
                        obs !== null &&
                        (obs as any)?.payload &&
                        (obs as any).payload.token === token;

                    if (!latestInbox.all.some(observationPredicate)) {
                        (latestNext as any).inbox = addObservationToInbox((latestNext as any).inbox, childObservation);
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
                    log.info('✅ STAGING SUCCESS: Staged child completion observation synchronously', {
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
        log.info('Child completion processing started', {
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
            // If this child was awaited synchronously by the parent, skip auto-resume (already handled in-turn)
            if (entry && entry.handlers && entry.handlers.completed === undefined && entry.handlers.failed === undefined && entry.handlers.inputRequired === undefined && (result as any)?.status?.state !== 'input-required') {
                // Default await path: no handlers set and result is terminal -> no extra resume needed
                // Fall through to cleanup mapping only
            }
            delete tasks[token];
            const next = setPendingTasks(base, tasks) as Record<string, unknown>;
            const childObservation: Observation = {
                source: 'child',
                kind: 'child.completed',
                payload: { token, childTaskId, result, agentId: childAgentId },
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
            // Use addObservationToInboxIfMissing to avoid duplicates if observation was already staged synchronously
            const observationPredicate = (obs: Observation) =>
                obs?.kind === 'child.completed' &&
                typeof obs === 'object' &&
                obs !== null &&
                (obs as any)?.payload &&
                (obs as any).payload.token === token;
            (next as any).inbox = addObservationToInboxIfMissing((next as any).inbox, childObservation, observationPredicate);
            const parentAgentId = (snap as any)?.agentId || (base as any)?.meta?.agentId || 'default';
            let snapshotSaved = false;

            try {
                await this.sessionManager?.saveSnapshot({ tenantId, sessionId: parentTaskId, agentId: parentAgentId, expectedWmVersion: snap.wmVersion ?? BigInt(0), snapshot: next });
                snapshotSaved = true;
            } catch (snapshotError) {
                if ((snapshotError as Error).message === 'LIMIT_WM_SNAPSHOT_TOO_LARGE') {
                    try {
                        const { pruneMentalState } = await import('../../loop/hygiene.js');
                        pruneMentalState((next as any).M);
                        await this.sessionManager?.saveSnapshot({ tenantId, sessionId: parentTaskId, agentId: parentAgentId, expectedWmVersion: snap.wmVersion ?? BigInt(0), snapshot: next });
                        snapshotSaved = true;
                    } catch (retryError) {
                        log.warn('Failed to save snapshot with child completion observation even after pruning', {
                            error: (retryError as Error).message,
                            parentTaskId,
                            childToken: token
                        });
                    }
                } else {
                    log.warn('Failed to save snapshot during child completion', {
                        error: (snapshotError as Error).message,
                        parentTaskId,
                        childToken: token
                    });
                }
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
                const plugin = agentName ? PluginManager.findAgent(agentName) : null;
                ctx = this.createContext({ id: parentTaskId, input: {} });
                (ctx as any).tenantId = tenantId; if (agentName) (ctx as any).agentId = agentName;
                try { extendContextWithStreaming(ctx, true); } catch { /* noop */ }
                // OPTION 1: Version Coordination in Parent Resume
                // After ALL saves in handleChildCompleted, load the final snapshot
                // ✅ FIX: Load the latest snapshot AFTER staging observation to ensure we have it
                const finalSnap = await this.sessionManager!.load(tenantId, parentTaskId);
                let baseNow = (finalSnap?.snapshot as Record<string, unknown>) || {};

                // ✅ FIX: Always ensure inbox has the observation, even if snapshotSaved is true
                // This handles race conditions where stageChildCompletionObservation saved but
                // handleChildCompleted loaded an older version
                const finalInbox = normalizeInbox((baseNow as any)?.inbox);
                const observationPredicateForCheck = (obs: Observation) =>
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
                        const { getMemoryPrismaClient, setMemoryPrismaClient } = await import('../memory/prismaSingleton.js');
                        const singletonPrisma = await getMemoryPrismaClient();

                        // Try to reuse existing PrismaClient from session store if available, otherwise use singleton
                        const existingPrisma = (this.sessionManager as any)?.store?.prisma || singletonPrisma;

                        // If we got PrismaClient from session store, set it as singleton for future use
                        if ((this.sessionManager as any)?.store?.prisma && !singletonPrisma) {
                            setMemoryPrismaClient((this.sessionManager as any).store.prisma);
                        }

                        const memoryRegistry = await createMemoryRegistry(
                            tenantId,
                            agentName || 'default',
                            ctx,
                            existingPrisma ? { database: { prismaClient: existingPrisma } } : undefined
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
                            plugin?.manifest || {},
                            semanticAdapter,
                            existingPrisma // ✅ FIX: Always pass PrismaClient to reuse it
                        );

                        log.debug('Context extended with memory successfully', {
                            parentTaskId,
                            agentName,
                            hasMemory: !!(ctx as any).memory,
                            hasVars: !!(ctx as any).vars
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
                        hasMemory: !!(ctx as any).memory,
                        hasVars: !!(ctx as any).vars
                    });
                }

                // Attach working memory AFTER extendContextWithMemory to ensure ctx.vars is set up correctly
                // This also sets up orchestration APIs (sendTaskToAgent, requestInput, etc.)
                await this.attachWorkingMemory(ctx, tenantId, parentTaskId, agentName || 'default');

                // FINAL VERSION COORDINATION: Load the absolute latest version right before execution
                const absoluteLatestSnap = await this.sessionManager!.load(tenantId, parentTaskId);
                (ctx as any).__coordinatedVersion = absoluteLatestSnap?.wmVersion ?? BigInt(0);

                // ✅ FIX: Use the ABSOLUTE LATEST snapshot for MentalState loading
                // This ensures we have the most recent MentalState including any updates
                const latestBase = (absoluteLatestSnap?.snapshot as Record<string, unknown>) || {};
                let M: MentalState = (latestBase as any).M as MentalState || initialM(ctx);

                // Load MentalState from latest snapshot
                await this.attachAndRestoreLLM(ctx, agentName, M);

                const recordedTurn = Number((latestBase as any)?.meta?.turn) || 0;
                const startTurnTotal2 = recordedTurn === 0 ? 1 : recordedTurn;
                let envInbox = normalizeInbox((latestBase as any)?.inbox);
                log.debug('Child resume before helper', {
                    sessionId: parentTaskId,
                    currentLength: envInbox.current.length,
                    allLength: envInbox.all.length,
                    currentKinds: envInbox.current.map(o => o.kind),
                    allKinds: envInbox.all.map(o => o.kind),
                });

                // ✅ FIX: Always ensure the observation is in the inbox before resuming
                // This is critical for synchronous completions where the observation must be available immediately
                const observationPredicate = (obs: Observation) =>
                    obs?.kind === 'child.completed' &&
                    typeof obs === 'object' &&
                    obs !== null &&
                    (obs as any)?.payload &&
                    (obs as any).payload.token === token;
                envInbox = addObservationToInboxIfMissing(envInbox, childObservation, observationPredicate);

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
                const env: EnvironmentState = {
                    time: new Date().toISOString(),
                    input: { kind: 'child', token, childTaskId, result, agentId: childAgentId },
                    sessionId: parentTaskId,
                    turn: startTurnTotal2 + 1,
                    pending: {
                        inputs: ((latestBase as any)?.pending?.inputs) || {},
                        children: ((latestBase as any)?.pending?.children) || {},
                        tools: ((latestBase as any)?.pending?.tools) || {},
                        groups: ((latestBase as any)?.pending?.groups) || {}
                    },
                    inbox: envInbox,
                    lastExec: (latestBase as any)?.meta?.lastExec || undefined,
                    externalEvents: undefined
                } as EnvironmentState;

                const overrides = (plugin as any)?.loop?.modules || {};

                let loopOpts: { maxTurns?: number; latencyMs?: number } = { maxTurns: 1 };
                try {
                    const b = (plugin?.manifest as any)?.budgets; const hitl = (plugin?.manifest as any)?.hitl;
                    if (hitl) { try { (M as any).hitl = hitl; } catch { } }
                    if (b && typeof b === 'object') loopOpts = { maxTurns: (b as any).maxTurns ?? 1, latencyMs: (b as any).latencyMs };
                    try { (env as any).budget = { maxTurns: loopOpts.maxTurns, latencyMs: loopOpts.latencyMs }; } catch { }
                } catch { }
                const { M: mNext, outcome, metrics } = await runLoop(ctx, M, env, overrides, loopOpts);
                try {
                    const snapAfter = await this.sessionManager!.load(tenantId, parentTaskId);
                    const expectedNow = snapAfter?.wmVersion ?? BigInt(0);
                    const baseSnap = (snapAfter?.snapshot as Record<string, unknown>) || {};
                    const prevMeta = (baseSnap as any).meta || {};
                    const nextMeta = { ...prevMeta, turn: env.turn, lastChildToken: token };

                    // ✅ FIX: Merge ctx.vars into mNext before saving (same as startTask does)
                    const mNextWithVars = this.mergeVarsIntoMental(M as any, mNext as any);

                    const nextSnap = { ...baseSnap, M: mNextWithVars, meta: nextMeta, inbox: normalizeInbox(env.inbox) } as Record<string, unknown>;
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
                    const parentBase = (parentSnap.snapshot as Record<string, unknown>) || {};
                    const parentM = parentBase.M as any;

                    // Automatic token storage
                    const childTokenPath = entry.options.tokenPath ?? 'child.token';
                    if (entry.options.setToken && token && parentM?.vars) {
                        const setNestedValue = (obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> => {
                            const pathParts = path.split('.');
                            let current = obj;
                            for (let i = 0; i < pathParts.length - 1; i++) {
                                const part = pathParts[i];
                                if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) {
                                    current[part] = {};
                                }
                                current = current[part] as Record<string, unknown>;
                            }
                            current[pathParts[pathParts.length - 1]] = value;
                            return obj;
                        };

                        const updatedVars = setNestedValue(
                            { ...(parentM.vars as Record<string, unknown> || {}) },
                            childTokenPath,
                            token
                        );
                        parentM.vars = updatedVars;
                        (parentM.memory as any) = { ...((parentM.memory as any) || {}), vars: updatedVars };
                    }

                    // Automatic stage transition
                    if (entry.options.setStage && parentM?.control) {
                        const currentStage = parentM.control.stage;
                        const targetStage = entry.options.setStage;

                        // Basic validation that this is a valid stage transition
                        if (typeof targetStage === 'string' && targetStage.length > 0) {
                            parentM.control.stage = targetStage;
                        }
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
            llm: {
                call: async () => [],
                stream: async function* () { },
                addToolResult: () => { },
                updateSettings: () => { }
            } as any,
            tools: {
                invoke: async <T>(toolName: string, args: unknown, options?: { onCompleted?: string; setToken?: boolean; setStage?: string }) => {
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
            try { console.log('[TaskEngine] restoreCtx: vars.jsonObject', (vars as any)?.jsonObject); } catch { }
        } catch {
            (ctx as any).vars = ((baseSnap as any)?.vars || {}) as Record<string, unknown>;
        }
        const ensureVarsFacade = () => {
            const current = (ctx as any).vars as Record<string, unknown> | undefined;
            if (current && typeof (current as any).get === 'function' && typeof (current as any).set === 'function') {
                return;
            }
            const mentalMemory = ((ctx as any).__mental?.memory as Record<string, unknown>) || {};
            const varsState = (mentalMemory.vars = { ...(mentalMemory.vars as Record<string, unknown> | undefined), ...(current || {}) });
            (ctx as any).__mental = {
                ...(ctx as any).__mental,
                memory: {
                    ...(mentalMemory),
                    vars: varsState
                }
            };
            (ctx as any).vars = {
                get: (key: string) => varsState[key],
                set: (key: string, value: unknown) => { varsState[key] = value; },
                merge: (patch: Record<string, unknown>) => {
                    for (const [k, v] of Object.entries(patch)) {
                        varsState[k] = v;
                    }
                },
                update: (key: string, fn: (prev: unknown) => unknown) => {
                    varsState[key] = fn(varsState[key]);
                },
                delete: (key: string) => { delete varsState[key]; },
                keys: () => Object.keys(varsState),
                has: (key: string) => Object.prototype.hasOwnProperty.call(varsState, key)
            } as TaskContext['vars'];
        };
        ensureVarsFacade();
        await this.attachOrchestrationAPIs(ctx, {
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
            (ctx as any).sendTaskToAgent = async (agent: string, childInput: unknown, options?: {
                awaitCompletion?: boolean;
                streaming?: boolean;
                onCompleted?: string;
                onFailed?: string;
                onInputRequired?: string;
                setToken?: boolean;
                tokenPath?: string;
                autoClearToken?: boolean;
                setStage?: string;
            }) => {
                if (!engine.sessionManager) throw new Error('Session manager not configured');
                const tenantId = (ctx as any).tenantId;
                const sessionId = taskId;

                // Use the same logic as the main TaskEngine implementation
                const { handle, token } = await createTaskHandle(engine.sessionManager, tenantId, sessionId, agent, childInput);

                const tokenPath = options?.tokenPath ?? 'child.token';
                const shouldSetToken = options?.setToken !== false;
                const autoClearToken = options?.autoClearToken !== false;

                if (shouldSetToken) {
                    try { ctx.vars.set(tokenPath, token); } catch { /* noop */ }
                }
                if (options?.setStage) {
                    try { ctx.vars.set('stage', options.setStage); } catch { /* noop */ }
                }

                const snapOptions = await engine.sessionManager.load(tenantId, sessionId);
                const baseOptions = (snapOptions?.snapshot as Record<string, unknown>) || {};
                const tasks = getPendingTasks(baseOptions);
                if (tasks[token]) {
                    tasks[token].options = {
                        setToken: shouldSetToken,
                        tokenPath,
                        autoClearToken,
                        setStage: options?.setStage
                    };
                    const next = setPendingTasks(baseOptions, tasks);
                    const expected = snapOptions?.wmVersion ?? BigInt(0);
                    await engine.sessionManager.saveSnapshot({
                        tenantId,
                        sessionId,
                        agentId: (snapOptions as any)?.agentId || 'default',
                        expectedWmVersion: expected,
                        snapshot: next
                    });
                }

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
