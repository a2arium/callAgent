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
        const snapshot = { vars: vars || {} } as Record<string, unknown>;
        try {
            await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId, expectedWmVersion: BigInt(0), snapshot });
        } catch {
            // best-effort; a later write will win
        }
    }
    /**
     * Start a task with either streaming or buffered mode
     * @returns The final task entity for buffered mode, or void for streaming mode
     */
    async startTask(params: StartTaskParams): Promise<TaskEntity | void> {
        const { task, isStreaming } = params;

        // Create a basic context for the task
        const ctx = this.createContext(task);

        // Load session-scoped WM snapshot if available (tenantId/sessionId assumed on ctx for now)
        const tenantId = (ctx as any).tenantId || 'default';
        const sessionId = task.id;
        const session = await this.sessionManager?.load(tenantId, sessionId);
        // Restore and thread session-scoped working variables with CAS persistence
        const initialVars = (session?.snapshot?.vars as Record<string, unknown>) || {};
        const varCache = new Map<string, unknown>(Object.entries(initialVars));
        (ctx as any).__wmVersion = session?.wmVersion;
        (ctx as any).vars = new Proxy({} as Record<string, unknown>, {
            get: (_target, prop: string) => varCache.get(prop),
            set: (_target, prop: string, value: unknown) => {
                varCache.set(prop, value);
                // Persist in background using CAS and append an event
                (async () => {
                    if (!this.sessionManager) return;
                    try {
                        const snapNow = await this.sessionManager.load(tenantId, sessionId);
                        const base = (snapNow?.snapshot as Record<string, unknown>) || {};
                        const vars = ((base as any).vars ? { ...(base as any).vars } : {}) as Record<string, unknown>;
                        (vars as any)[prop] = value;
                        const next = { ...base, vars } as Record<string, unknown>;
                        const expected = snapNow?.wmVersion ?? BigInt(0);
                        await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || 'default', expectedWmVersion: expected, snapshot: next });
                        await this.sessionManager.appendEvent(tenantId, sessionId, 'wm.vars_updated', { key: String(prop) });
                    } catch (e) {
                        // Retry once on CAS mismatch
                        if ((e as Error).message === 'CAS_MISMATCH') {
                            try {
                                const snapNow2 = await this.sessionManager.load(tenantId, sessionId);
                                const base2 = (snapNow2?.snapshot as Record<string, unknown>) || {};
                                const vars2 = ((base2 as any).vars ? { ...(base2 as any).vars } : {}) as Record<string, unknown>;
                                (vars2 as any)[prop] = value;
                                const next2 = { ...base2, vars: vars2 } as Record<string, unknown>;
                                const expected2 = snapNow2?.wmVersion ?? BigInt(0);
                                await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || 'default', expectedWmVersion: expected2, snapshot: next2 });
                                await this.sessionManager.appendEvent(tenantId, sessionId, 'wm.vars_updated', { key: String(prop) });
                            } catch {
                                // swallow; eventual consistency acceptable for vars
                            }
                        }
                    }
                })();
                return true;
            },
            deleteProperty: (_target, prop: string) => {
                varCache.delete(prop);
                (async () => {
                    if (!this.sessionManager) return;
                    try {
                        const snapNow = await this.sessionManager.load(tenantId, sessionId);
                        const base = (snapNow?.snapshot as Record<string, unknown>) || {};
                        const vars = ((base as any).vars ? { ...(base as any).vars } : {}) as Record<string, unknown>;
                        delete (vars as any)[prop];
                        const next = { ...base, vars } as Record<string, unknown>;
                        const expected = snapNow?.wmVersion ?? BigInt(0);
                        await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || 'default', expectedWmVersion: expected, snapshot: next });
                        await this.sessionManager.appendEvent(tenantId, sessionId, 'wm.vars_deleted', { key: String(prop) });
                    } catch { /* ignore */ }
                })();
                return true;
            }
        });

        // Provide requestInput implementation (non-blocking; persists pending handler and emits input_required)
        (ctx as any).requestInput = async (prompt: string, opts: { handlerName?: string; ttlMs?: number; schema?: unknown; onProvided: string; onExpired?: string }) => {
            if (!this.sessionManager) throw new Error('Session manager not configured');
            if (!opts?.onProvided) throw new Error('requestInput requires onProvided handler name');
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
            const token = uuidv4();
            const expiresAt = opts?.ttlMs ? new Date(Date.now() + opts.ttlMs).toISOString() : undefined;
            const pending = { ...getPendingInputs(base) };
            pending[token] = { handlerName: opts.onProvided, schema: opts?.schema, expiresAt };
            const writeOnce = async (baseSnap: Record<string, unknown>, expectedVer: bigint) => {
                const nextSnapshot = setPendingInputs(baseSnap, pending);
                await this.sessionManager!.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || 'default', expectedWmVersion: expectedVer, snapshot: nextSnapshot });
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
                        const pending2 = { ...getPendingInputs(base2), [token]: { handlerName: opts?.handlerName || '', schema: opts?.schema, expiresAt } } as any;
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
                    state: 'waiting_input',
                    message: {
                        role: 'agent',
                        parts: [{ type: 'text', text: `Input required: ${prompt}` }]
                    },
                    timestamp: new Date().toISOString(),
                    metadata: { token }
                } as any);
            } catch { /* noop */ }
            const handle = new InputHandle(this.sessionManager, tenantId, sessionId, token);
            // Auto-register handlers if provided
            if (opts?.onProvided) { try { await handle.onProvided(opts.onProvided); } catch { } }
            if (opts?.onExpired) { try { await handle.onExpired(opts.onExpired); } catch { } }
            return handle;
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
                const a2aOptions = { tenantId, streaming: (runOpts?.streaming ?? options?.streaming) === true } as any;
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
        const initialWm = (session?.snapshot as Record<string, unknown>) || {};
        const { wm: wmAfterStart } = decide(initialWm, { t: 'task.started' });

        // Extend the context with streaming capabilities
        extendContextWithStreaming(ctx, isStreaming);

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

            // For streaming mode, there's no return value - events are sent via EventBus
            if (isStreaming) {
                // Start the task handler process in the background without awaiting it
                // When the task handler completes/fails, it will emit final events
                this.executeTaskHandler(ctx).catch(error => {
                    console.error('Task handler error:', error);

                    // Send failure event
                    ctx.fail({
                        state: 'failed',
                        message: {
                            role: 'agent',
                            parts: [
                                { type: 'text', text: `Task execution failed: ${error instanceof Error ? error.message : String(error)}` }
                            ]
                        },
                        timestamp: new Date().toISOString()
                    });
                });

                // Return undefined for streaming mode (client doesn't await completion)
                return;
            }

            // For buffered mode, await the task handler completion
            await this.executeTaskHandler(ctx);

            // After handler: snapshot minimal WM (vars) with CAS
            if (this.sessionManager) {
                const newSnapshot = { vars: (ctx as any).vars || {} } as Record<string, unknown>;
                const expected = (ctx as any).__wmVersion ?? BigInt(0);
                try {
                    await this.sessionManager.saveSnapshot({
                        tenantId,
                        sessionId,
                        agentId: (ctx as any).agentId || 'default',
                        expectedWmVersion: expected,
                        snapshot: newSnapshot
                    });
                } catch (e) {
                    if ((e as Error).message === 'CAS_MISMATCH') {
                        // concurrent turn detected; surface as conflict in buffered mode
                        throw new Error('SESSION_CONFLICT');
                    }
                    throw e;
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
        const base = (snap?.snapshot as Record<string, unknown>) || {};
        const { next, handlerName } = applyInputProvided(base, token, input);
        const expected = snap?.wmVersion ?? BigInt(0);
        await this.sessionManager?.appendEvent(tenantId, taskId, 'task.input_provided', { token });
        await this.sessionManager?.saveSnapshot({ tenantId, sessionId: taskId, agentId: (next as any).meta?.agentId || 'default', expectedWmVersion: expected, snapshot: next });
        await this.sessionManager?.enqueueOutbox(tenantId, 'task.status', taskId, { taskId, status: { state: 'working', timestamp: new Date().toISOString() }, metadata: { inputProvided: true } });

        // If we have a durable handler, invoke it next (non-blocking semantics left to invoker)
        if (handlerName && this.handlerInvoker) {
            await this.handlerInvoker.invoke({ tenantId, taskId, handlerName, input });
        }
        return { acknowledged: true };
    }

    /**
     * Route child completion to parent's durable handler using pending task mappings.
     * Provide either childToken (preferred correlation) or childTaskId.
     */
    async handleChildCompleted(params: { tenantId: string; parentTaskId: string; childToken?: string; childTaskId?: string; result: unknown }): Promise<void> {
        const { tenantId, parentTaskId, childToken, childTaskId, result } = params;
        const snap = await this.sessionManager?.load(tenantId, parentTaskId);
        if (!snap) return;
        const base = (snap.snapshot as Record<string, unknown>) || {};
        const tasks = getPendingTasks(base);
        // Find entry
        const token = childToken || Object.keys(tasks).find(t => (tasks[t] as any)?.childTaskId === childTaskId);
        if (!token) return;
        const entry = tasks[token] as any;
        const handlerName = entry?.handlers?.completed;
        if (handlerName && this.handlerInvoker) {
            // Deliver immediately and remove mapping
            delete tasks[token];
            const next = setPendingTasks(base, tasks);
            await this.sessionManager?.saveSnapshot({ tenantId, sessionId: parentTaskId, agentId: (base as any)?.meta?.agentId || 'default', expectedWmVersion: snap.wmVersion ?? BigInt(0), snapshot: next });
            await this.sessionManager?.appendEvent(tenantId, parentTaskId, 'task.child_completed', { token, childTaskId, result });
            const maybe = await this.handlerInvoker.invoke({ tenantId, taskId: parentTaskId, handlerName, input: result });
            const finalResult = typeof maybe !== 'undefined' ? maybe : result;
            // no-op: parent decides usage of finalResult
        } else {
            // Buffer completion until completed handler is registered; keep mapping
            if (entry) {
                entry.pendingCompletion = result;
                tasks[token] = entry;
                const next = setPendingTasks(base, tasks);
                await this.sessionManager?.saveSnapshot({ tenantId, sessionId: parentTaskId, agentId: (base as any)?.meta?.agentId || 'default', expectedWmVersion: snap.wmVersion ?? BigInt(0), snapshot: next });
                await this.sessionManager?.appendEvent(tenantId, parentTaskId, 'task.child_completion_buffered', { token, childTaskId });
            }
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
                await this.sessionManager?.saveSnapshot({ tenantId, sessionId: parentTaskId, agentId: (base2 as any)?.meta?.agentId || 'default', expectedWmVersion: snap2.wmVersion ?? BigInt(0), snapshot: next2 });
            }
        }
    }

    /**
     * Route child input-required to parent's durable handler.
     */
    async handleChildInputRequired(params: { tenantId: string; parentTaskId: string; childToken?: string; childTaskId?: string; prompt: string; schema?: unknown; childOnProvided?: string }): Promise<void> {
        const { tenantId, parentTaskId, childToken, childTaskId, prompt, schema, childOnProvided } = params;
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
        if (!alreadyDelivered && handlerName && this.handlerInvoker) {
            const maybe = await this.handlerInvoker.invoke({ tenantId, taskId: parentTaskId, handlerName, input: { prompt, schema, token, childTaskId } });
            if (typeof maybe !== 'undefined') {
                // Parent provided immediate answer; first try to invoke child's onProvided if available
                let finalChildResult: unknown = maybe;
                try {
                    if (childOnProvided && childTaskId && this.handlerInvoker) {
                        const childResult = await this.handlerInvoker.invoke({ tenantId, taskId: childTaskId, handlerName: childOnProvided, input: maybe });
                        if (typeof childResult !== 'undefined') {
                            finalChildResult = childResult;
                        }
                    }
                } catch (e) {
                    // If invoking child's handler fails, fall back to using parent's value
                }
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
            reply: async () => { },
            progress: () => { },
            complete: () => { },
            fail: async () => { },
            // Add stub for recordUsage
            recordUsage: () => { console.warn('recordUsage called on base context'); },
            // Stub implementations for other required properties
            llm: {} as any,
            tools: { invoke: async <T>() => ({} as unknown as T) },
            memory: {
                semantic: {
                    getDefaultBackend: () => 'none',
                    setDefaultBackend: () => { },
                    backends: {},
                    get: async () => null,
                    set: async () => { },
                    getMany: async () => [],
                    delete: async () => { },
                    deleteMany: async () => 0,
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
                debug: () => { },
                info: () => { },
                warn: () => { },
                error: () => { }
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

            // Required working memory operations
            setGoal: async () => { throw new Error('Working memory not available in basic task engine'); },
            getGoal: async () => { throw new Error('Working memory not available in basic task engine'); },
            addThought: async () => { throw new Error('Working memory not available in basic task engine'); },
            getThoughts: async () => { throw new Error('Working memory not available in basic task engine'); },
            makeDecision: async () => { throw new Error('Working memory not available in basic task engine'); },
            getDecision: async () => { throw new Error('Working memory not available in basic task engine'); },
            getAllDecisions: async () => { throw new Error('Working memory not available in basic task engine'); },
            vars: {},
            recall: async () => { throw new Error('Memory not available in basic task engine'); },
            remember: async () => { throw new Error('Memory not available in basic task engine'); }
        };
    }

    private async restoreCtx(tenantId: string, taskId: string): Promise<TaskContext> {
        const task: TaskEntity = { id: taskId, input: {} };
        const ctx = this.createContext(task);
        (ctx as any).tenantId = tenantId;
        const snap = await this.sessionManager?.load(tenantId, taskId);
        const vars = (snap?.snapshot as any)?.vars || {};
        (ctx as any).vars = { ...(ctx as any).vars, ...vars };
        // Ensure restored context can emit streaming events to the same task channel
        try { extendContextWithStreaming(ctx, true); } catch { /* noop */ }
        // Enable A2A from durable handler context
        try {
            (ctx as any).sendTaskToAgent = async (targetAgent: string, taskInput: unknown, options?: { awaitCompletion?: boolean; streaming?: boolean }) => {
                return globalA2AService.sendTaskToAgent(ctx as any, targetAgent, taskInput as any, options as any);
            };
        } catch { /* noop */ }
        return ctx;
    }
}

// Export a singleton instance
export const taskEngine = new TaskEngine(); 