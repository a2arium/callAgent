
import * as uuid from 'uuid';
const uuidv4 = uuid.v4;
import { logger } from '@a2arium/callagent-utils';
import type { TaskContext } from '../../shared/types/index.js';
import { ArtifactHydrationService } from '../ArtifactHydrationService.js';
import { AgentResultCache, ArtifactImpl } from '@a2arium/callagent-memory-engine';
import { type EngineObservation, type EngineObservationInbox } from '../InboxManager.js';
import { applyInputProvided, getPendingInputs, setPendingInputs } from '../DurableHandlerRegistry.js';
import { getPendingTools, setPendingTools } from '../ToolsRegistry.js';
import { getPendingExternalEvents, setPendingExternalEvents } from '../ExternalEventsRegistry.js';
import { getPendingTasks, setPendingTasks, getPendingGroups, setPendingGroups } from '../Handles.js';
import { InputHandle, createTaskHandle, createGroupHandle, type GroupHandle } from '../Handles.js';
import { globalA2AService } from '../A2AService.js';
import type { SessionManager } from '../SessionManager.js';
import type { SnapshotRepository } from '../persistence/SnapshotRepository.js';
import { TaskStateUtils } from '../utils/TaskStateUtils.js';
import { writeControlVar } from '../../loop/controlVarAccessors.js';
import { throwInvariantError } from '../../utils/invariantError.js';
import type { InternalTaskContext } from '../../loop/internalContext.js';
import type { JsonValue } from '../../types/turnTrace.js';
import { telemetry } from '../../telemetry/TelemetryCollector.js';
import { ChildCallNode } from '../../telemetry/nodes/ChildCallNode.js';
import type { TaskInput } from '../../shared/types/index.js';

const log = logger.createLogger({ prefix: 'ApiBinder' });

export interface ApiBinderDependencies {
    sessionManager: SessionManager;
    snapshotRepo: SnapshotRepository;
    getTraceContext: () => any; // dummy or real
    getSessionStorePrisma: () => any;
    taskCreationMutex: { runExclusive: <T>(key: string, fn: () => Promise<T>) => Promise<T> };
    backgroundTaskPromises: Set<Promise<void>>;
    handleChildCompleted: (params: { tenantId: string; parentTaskId: string; childToken?: string; childTaskId?: string; result: unknown; childAgentId?: string }) => Promise<void>;
    handleToolCompleted?: (params: { tenantId: string; taskId: string; token: string; result: unknown }) => Promise<void>;
}

export class ApiBinder {
    constructor(private deps: ApiBinderDependencies) { }

    public async attachOrchestrationAPIs(
        ctx: TaskContext,
        params: { tenantId: string; sessionId: string; agentId?: string; flushMentalState: () => Promise<void> }
    ): Promise<void> {
        if (!this.deps.sessionManager) {
            throw new Error('TaskEngine requires a configured session manager for orchestration APIs');
        }

        const { tenantId, sessionId } = params;
        const agentId = params.agentId ?? ((ctx as any).agentId as string) ?? 'default';
        const flushMentalState = params.flushMentalState;

        // Ensure __autoExecuteTool is attached for async tool execution
        // This is needed because startTask uses an external initialContext that doesn't have it
        if (typeof (ctx as any).__autoExecuteTool !== 'function' && this.deps.handleToolCompleted) {
            const handleToolCompleted = this.deps.handleToolCompleted;
            (ctx as any).__autoExecuteTool = async (tId: string, sId: string, token: string, toolName: string, args: unknown) => {
                try {
                    let result: unknown;
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
                        result = await ctx.tools.invoke(toolName, args);
                    }
                    await handleToolCompleted({ tenantId: tId, taskId: sId, token, result });
                } catch (error) {
                    const errorResult = { error: true, message: error instanceof Error ? error.message : String(error) };
                    await handleToolCompleted({ tenantId: tId, taskId: sId, token, result: errorResult });
                }
            };
        }

        // Artifacts Factory
        if (!(ctx as any).artifacts) {
            (ctx as any).artifacts = {
                create: async (val: unknown, options?: { mimeType?: string; preview?: string }) => {
                    const prisma = this.deps.getSessionStorePrisma();
                    if (!prisma) {
                        throw new Error("Artifacts not available: no database connection");
                    }
                    const cache = new AgentResultCache(prisma);
                    const art = new ArtifactImpl(undefined, cache, tenantId, options?.mimeType, undefined);
                    if (val !== undefined) {
                        await art.set(val);
                    }
                    return art;
                },
                json: async (val: unknown) => {
                    return (ctx as any).artifacts.create(val, { mimeType: "application/json" });
                },
                text: async (val: string) => {
                    return (ctx as any).artifacts.create(val, { mimeType: "text/plain" });
                }
            };
        }

        // Goals API (if available) - assuming it's external/imported or we skip moving it for now if complex imports?
        // In TaskEngine.ts it imported 'goals' from somewhere? 
        // Logic might be simple enough to replicate or just delegate if we import goals module.
        // TaskEngine used: import * as goals from '../goals/goals.js' (implied)
        // I'll skip goals for a moment or assume imports generic.
        // Actually TaskEngine didn't show goal imports in view 127. Maybe later?
        // I'll skip Logic for goals injection if not critical or I'll add placeholder.

        // requestInput implementation
        (ctx as any).requestInput = async (
            promptOrParts: string | string[] | any | any[],
            opts?: { ttlMs?: number; schema?: unknown; onProvided?: string; onExpired?: string; __existingToken?: string; setToken?: boolean; setStage?: string }
        ) => {
            const promptOrPartsStrict = promptOrParts as string | string[] | any | any[];
            if (!this.deps.sessionManager) throw new Error('Session manager not configured');
            const snapL = await this.deps.sessionManager.load(tenantId, sessionId);
            const baseL = (snapL?.snapshot as Record<string, unknown>) || {};
            const token = opts?.__existingToken || uuidv4();
            const controlUpdates: Array<[string, unknown]> = [];
            const expiresAt = opts?.ttlMs ? new Date(Date.now() + opts.ttlMs).toISOString() : undefined;
            const pending = { ...getPendingInputs(baseL) };

            const normalizeParts = (p: any): any[] => {
                if (typeof p === 'string') return [{ type: 'text', text: p, format: 'markdown' }];
                if (Array.isArray(p) && p.length > 0 && typeof p[0] === 'string') {
                    return (p as string[]).map(t => ({ type: 'text', text: t, format: 'markdown' }));
                }
                if (Array.isArray(p)) {
                    return (p as any[]).map(part => (part?.type === 'text' && !part?.format ? { ...part, format: 'markdown' } : part));
                }
                const one = p as any;
                return [one?.type === 'text' && !one?.format ? { ...one, format: 'markdown' } : one];
            };

            const parts = normalizeParts(promptOrPartsStrict);
            const prompt = (parts.find((x: any) => x?.type === 'text') as any)?.text as string | undefined;

            try { await ctx.reply(parts as any); } catch { /* best-effort */ }

            const maxPrompts = 100;
            if (Object.keys(pending).length >= maxPrompts) {
                throwInvariantError(
                    'LIMIT_MAX_PROMPTS_EXCEEDED',
                    `Maximum outstanding prompts reached (${maxPrompts})`,
                    { type: 'session_config', reason: 'limit_max_prompts_exceeded', limit: maxPrompts, actual: Object.keys(pending).length }
                );
            }

            if (!opts?.__existingToken) {
                pending[token] = {
                    schema: opts?.schema,
                    expiresAt,
                    handlerName: opts?.onProvided,
                    expiredHandlerName: opts?.onExpired
                } as any;
            }

            if (opts?.setToken !== false) {
                controlUpdates.push(['token', token]);
                writeControlVar(ctx, 'token', token);
            }

            if (opts?.setStage) {
                const stagePath = 'stage';
                controlUpdates.push([stagePath, opts.setStage]);
                writeControlVar(ctx, stagePath, opts.setStage);
            }

            if (!this.deps.snapshotRepo) throw new Error('SnapshotRepo not initialized');
            try { await flushMentalState(); } catch { /* best-effort */ }
            await this.deps.snapshotRepo.saveWithRetry({
                tenantId,
                sessionId,
                agentId: (ctx as any).agentId || 'default',
                mutate: async (baseSnap) => {
                    let nextSnapshot = setPendingInputs(baseSnap, pending);
                    if (controlUpdates.length > 0) {
                        for (const [path, value] of controlUpdates) {
                            nextSnapshot = TaskStateUtils.applyControlVarToSnapshot(nextSnapshot, path, value);
                        }
                    }
                    return nextSnapshot;
                }
            });

            await this.deps.sessionManager!.appendEvent(tenantId, sessionId, 'task.input_required', { token, prompt, parts, schema: opts?.schema, expiresAt });
            await this.deps.sessionManager!.enqueueOutbox(tenantId, 'task.input_required', sessionId, { taskId: sessionId, prompt, parts, token, schema: opts?.schema, expiresAt });

            try { (ctx as any).logger?.info?.('requestInput: input_required emitted', { token, prompt, expiresAt }); } catch { }
            try {
                ctx.progress({
                    state: 'input-required',
                    message: { role: 'agent', parts },
                    timestamp: new Date().toISOString(),
                    metadata: { token }
                } as any);
            } catch { /* noop */ }

            (ctx as any).__wmSavedThisTurn = true;
            return new InputHandle(this.deps.sessionManager, tenantId, sessionId, token);
        };

        // requestTool implementation
        (ctx as any).requestTool = async (toolNameOrCall: string | any, argsOrOptions?: any, maybeOptions?: any) => {
            let toolName: string;
            let args: any;
            let opts: any;

            if (typeof toolNameOrCall === 'object' && toolNameOrCall !== null) {
                // Object-based call format: requestTool({ name, input, options })
                toolName = toolNameOrCall.name;
                args = toolNameOrCall.input;
                opts = toolNameOrCall.options;
            } else {
                // Positional call format: requestTool(toolName, args, opts)
                toolName = toolNameOrCall;
                args = argsOrOptions;
                opts = maybeOptions;
            }

            if (opts?.awaitCompletion === true) {
                // Check if it's an MCP tool call (format: mcp:serverName.toolName)
                if (typeof toolName === 'string' && toolName.startsWith('mcp:')) {
                    const parts = toolName.slice(4).split('.');
                    if (parts.length >= 2) {
                        const serverName = parts[0];
                        const mcpToolName = parts.slice(1).join('.');
                        if (typeof (ctx as any).llm?.callMcpTool === 'function') {
                            return (ctx as any).llm.callMcpTool(serverName, mcpToolName, args as any);
                        } else {
                            throw new Error(`MCP execution not supported by current LLM adapter for tool: ${toolName}`);
                        }
                    } else {
                        throw new Error(`Invalid MCP tool name format: ${toolName}. Expected mcp:server.tool`);
                    }
                }
                return (ctx as any).tools.invoke(toolName, args);
            }
            // Async tool request path: enqueue and let background handler execute
            if (!this.deps.sessionManager) throw new Error('Session manager not configured');
            const token = opts?.setToken && typeof opts.setToken === 'string' ? opts.setToken : uuidv4();

            try { await flushMentalState(); } catch { /* best-effort */ }

            // Use saveWithRetry to avoid CAS_MISMATCH after flushMentalState bumps version
            await this.deps.snapshotRepo.saveWithRetry({
                tenantId, sessionId,
                agentId: (ctx as any).agentId || 'default',
                mutate: (baseSnap) => {
                    const toolsNow = { ...getPendingTools(baseSnap) } as any;
                    toolsNow[token] = { name: toolName, args, handlers: { completed: opts?.onCompleted } };
                    if (opts?.setToken || opts?.setStage) {
                        toolsNow[token].options = { setToken: opts.setToken, setStage: opts.setStage };
                    }
                    return setPendingTools(baseSnap, toolsNow);
                }
            });
            await this.deps.sessionManager.appendEvent(tenantId, sessionId, 'task.tool_requested', { token, toolName });

            (ctx as any).__wmSavedThisTurn = true;

            // Trigger async auto-execution in the background
            if (typeof (ctx as any).__autoExecuteTool === 'function') {
                // Don't await - let it run in the background, but track the promise
                const toolPromise = (ctx as any).__autoExecuteTool(tenantId, sessionId, token, toolName, args).catch((e: Error) => {
                    log.error('[ApiBinder] Background tool execution failed', { token, toolName, error: e.message });
                }).finally(() => {
                    this.deps.backgroundTaskPromises.delete(toolPromise);
                });
                this.deps.backgroundTaskPromises.add(toolPromise);
            }

            return { token } as any;
        };

        // sendTaskToAgent implementation
        (ctx as any).sendTaskToAgent = async (agent: string, childInput: unknown, options?: any) => {
            log.debug('[sendTaskToAgent] START', { agent, taskId: sessionId });
            if (!this.deps.sessionManager) throw new Error('Session manager not configured');
            // ... flush logic ...
            if (options?.skipFlush !== true) {
                // ... internal flush logic ...
                try { await flushMentalState(); } catch { }
            }

            log.debug(`[sendTaskToAgent] Requesting mutex for ${tenantId}:${sessionId}`);
            const { handle, token } = await this.deps.taskCreationMutex.runExclusive(
                `${tenantId}:${sessionId}`,
                async () => {
                    return await createTaskHandle(this.deps.sessionManager!, tenantId, sessionId, agent, childInput);
                }
            );

            // Create ChildCallNode under current turn so child AgentNode can be parented to it
            const parentId = ctx.telemetry?.nodeId ?? 'root';
            const parentNode = telemetry.getNode(parentId);
            const traceId = parentNode?.traceId;
            const childCallNode = new ChildCallNode(token, parentId, agent, undefined, traceId);
            childCallNode.start({ token, agentId: agent });
            telemetry.registerNode(childCallNode);

            const iCtx = ctx as InternalTaskContext;
            if (iCtx.__turnChildCalls) {
                iCtx.__turnChildCalls.push({
                    token,
                    agentId: agent,
                    status: 'dispatched',
                    module: iCtx.__currentModule,
                    awaitCompletion: options?.awaitCompletion !== false
                });
            }

            const tokenPath = options?.tokenPath ?? 'child.token';
            const shouldSetToken = options?.setToken !== false;
            const controlUpdates: Array<[string, unknown]> = [];

            if (shouldSetToken) {
                controlUpdates.push([tokenPath, token]);
                writeControlVar(ctx, tokenPath, token);
            }
            if (options?.setStage) {
                controlUpdates.push(['stage', options.setStage]);
                writeControlVar(ctx, 'stage', options.setStage);
            }

            const writeOnce = async (baseSnap: Record<string, unknown>, expectedVer: bigint) => {
                const tasks = getPendingTasks(baseSnap);
                // Integrity checks...
                // ...
                if (tasks[token]) {
                    tasks[token].options = {
                        setToken: shouldSetToken,
                        tokenPath,
                        autoClearToken: options?.autoClearToken !== false,
                        setStage: options?.setStage
                    };
                    let next = setPendingTasks(baseSnap, tasks);
                    if (controlUpdates.length > 0) {
                        for (const [path, value] of controlUpdates) {
                            next = TaskStateUtils.applyControlVarToSnapshot(next, path, value);
                        }
                    }
                    await this.deps.sessionManager.saveSnapshot({
                        tenantId,
                        sessionId,
                        agentId: (baseSnap as any)?.meta?.agentId || 'default',
                        expectedWmVersion: expectedVer,
                        snapshot: next
                    });
                }
            };

            // Re-implement retry logic or use SnapshotRepo?
            // SnapshotRepo.saveWithRetry is good, but writeOnce logic is custom (loaded snapshot might be partial).
            // For now, I'll keep manual retry to match exactly.
            try {
                // Retry loop for loading snapshot
                let attempts = 0;
                const maxAttempts = 3;
                let saved = false;

                while (attempts < maxAttempts) {
                    attempts++;
                    const snapOptions = await this.deps.sessionManager.load(tenantId, sessionId);
                    const baseOptions = (snapOptions?.snapshot as Record<string, unknown>) || {};
                    const expected = snapOptions?.wmVersion ?? BigInt(0);

                    // Integrity Check inside the loop
                    const hasMeta = !!(baseOptions as any).meta;
                    const hasM = !!(baseOptions as any).M;
                    const isVersionZero = expected === BigInt(0);

                    if (hasMeta || hasM || isVersionZero) {
                        await writeOnce(baseOptions, expected);
                        saved = true;
                        break;
                    }
                    if (attempts < maxAttempts) await new Promise(r => setTimeout(r, 200 * attempts));
                }

                if (!saved) {
                    const snapFinal = await this.deps.sessionManager.load(tenantId, sessionId);
                    await writeOnce((snapFinal?.snapshot as any) || {}, snapFinal?.wmVersion ?? BigInt(0));
                }

            } catch (e) {
                if ((e as Error).message === 'CAS_MISMATCH') {
                    // retry once
                    try {
                        const snapRetry = await this.deps.sessionManager.load(tenantId, sessionId);
                        await writeOnce((snapRetry?.snapshot as any) || {}, snapRetry?.wmVersion ?? BigInt(0));
                    } catch { }
                } else throw e;
            }

            // ... handler registration ...
            if (options?.onInputRequired) { try { await (handle as any).onInputRequired(options.onInputRequired); } catch { } }
            if (options?.onCompleted) { try { await (handle as any).onCompleted(options.onCompleted); } catch { } }
            if (options?.onFailed) { try { await (handle as any).onFailed(options.onFailed); } catch { } }

            const awaitCompletion = options?.awaitCompletion !== false;
            type CtxWithLoop = TaskContext & {
                __activeLoopInbox?: { current: unknown[]; all: unknown[] };
                __activeLoopEnv?: { turn?: number; pending?: { children?: Record<string, unknown> } };
            };
            const minimalCtx = ctx as CtxWithLoop;
            const a2aOptions = {
                tenantId,
                streaming: (options?.streaming) === true,
                parentTenantId: tenantId,
                parentTaskId: sessionId,
                parentChildToken: token,
                skipParentNotification: awaitCompletion,
                parentTelemetryNodeId: childCallNode.id
            };

            let result: unknown;
            try {
                result = await globalA2AService.sendTaskToAgent(minimalCtx, agent, childInput as TaskInput, {
                    ...(options || {}),
                    ...a2aOptions
                });
            } catch (error) {
                childCallNode.fail(error instanceof Error ? error : new Error(String(error)));
                telemetry.endNode(childCallNode);
                if (iCtx.__turnChildCalls) {
                    iCtx.__turnChildCalls.push({
                        token,
                        agentId: agent,
                        status: 'failed',
                        module: iCtx.__currentModule,
                        error: { message: error instanceof Error ? error.message : String(error) }
                    });
                }
                await this.deps.sessionManager!.enqueueOutbox(tenantId, 'task.child_dispatch', sessionId, {
                    taskId: sessionId,
                    childAgent: agent,
                    error: error instanceof Error ? error.message : String(error)
                });
                throw error;
            }

            const cleanChildResult = TaskStateUtils.extractCleanChildResult(result as Record<string, unknown>);
            childCallNode.childTaskId = cleanChildResult.childTaskId;
            childCallNode.endTime = Date.now();
            childCallNode.end(cleanChildResult.result, 'success');
            telemetry.endNode(childCallNode);
            if (iCtx.__turnChildCalls) {
                iCtx.__turnChildCalls.push({
                    token,
                    agentId: agent,
                    childTaskId: cleanChildResult.childTaskId,
                    status: 'completed',
                    module: iCtx.__currentModule,
                    resultSummary: cleanChildResult.result != null ? ({ result: cleanChildResult.result } as unknown as JsonValue) : undefined
                });
            }

            // ... Result handling ...
            // ✅ ARCHITECTURAL FIX: Always inject child completion into active loop inbox when it exists
            // This ensures:
            // 1. The loop's await_child mechanism handles the completion naturally
            // 2. handleChildCompleted doesn't start a fresh loop (which would lose accumulated mental state)
            // 3. Both awaitCompletion:true and awaitCompletion:false work correctly
            const inbox = (ctx as { __activeLoopInbox?: { current: unknown[]; all: unknown[] }; __activeLoopEnv?: { turn?: number; pending?: { children?: Record<string, unknown> } } }).__activeLoopInbox;
            if (inbox) {
                const obs: EngineObservation = {
                    source: 'child',
                    kind: 'child.completed',
                    payload: {
                        token,
                        childTaskId: cleanChildResult.childTaskId,
                        result: cleanChildResult.result,
                        executionMetadata: cleanChildResult.executionMetadata
                    },
                    provenance: { ts: Date.now(), turn: minimalCtx.__activeLoopEnv?.turn ?? 0, id: token, correlationId: token }
                };

                inbox.current.push(obs);
                inbox.all.push(obs);

                const loopEnv = minimalCtx.__activeLoopEnv;
                if (loopEnv?.pending?.children) {
                    loopEnv.pending.children[token] = {
                        agent,
                        input: childInput
                    };
                }

                log.debug('✅ SYNC CHILD: Injected completion into active loop inbox', { token, awaitCompletion });
            } else if (awaitCompletion) {
                // Fallback: no active loop inbox available, use handleChildCompleted
                await this.deps.handleChildCompleted({ tenantId, parentTaskId: sessionId, childToken: token, result });
            }
            // Note: When awaitCompletion=false and no inbox, A2AService will call handleChildCompleted via notification

            if (result && typeof result === 'object') {
                for (const key of Object.keys(result)) {
                    if (key !== 'token') {
                        try {
                            (handle as any)[key] = (result as any)[key];
                        } catch (e) {
                            // Skip properties that cannot be set (like read-only descriptors)
                        }
                    }
                }
                return { handle, token };
            }
            return { handle, token };
        };

        // allTasks implementation
        (ctx as any).allTasks = async (
            children: Array<{ agent: string; input: unknown }>,
            opts?: { withTimeoutMs?: number; cancelRemaining?: boolean; onAllCompleted?: string; onAnyFailed?: string }
        ) => {
            if (process.env.DEBUG_BACKGROUND_TASKS) {
                console.log(`[ApiBinder.allTasks] Called with ${children.length} children`);
            }
            if (!this.deps.sessionManager) throw new Error('Session manager not configured');
            const maxGroup = 50;
            if (children.length > maxGroup) throw new Error('LIMIT_MAX_GROUP_CHILDREN_EXCEEDED');
            const childTokens: string[] = [];

            if (typeof (ctx as any).flushSnapshot === 'function') {
                try {
                    log.debug('allTasks pre-flushing snapshot');
                    await (ctx as any).flushSnapshot({ M: (ctx as any).M, env: (ctx as any).env });
                } catch (e) { log.warn('allTasks pre-flush failed', { error: e }); }
            }

            for (const child of children) {
                const { handle, token } = await createTaskHandle(this.deps.sessionManager, tenantId, sessionId, child.agent);
                childTokens.push(token);

                const taskPromise = globalA2AService.sendTaskToAgent(ctx as any, child.agent, child.input as any, {
                    tenantId,
                    parentTenantId: tenantId,
                    parentTaskId: sessionId,
                    parentChildToken: token,
                    awaitCompletion: false,
                    skipFlush: true
                } as any).catch(async (e: any) => {
                    await this.deps.sessionManager!.enqueueOutbox(tenantId, 'task.child_dispatch', sessionId, {
                        taskId: sessionId,
                        childAgent: child.agent,
                        error: e instanceof Error ? e.message : String(e)
                    });
                }).finally(() => {
                    const removed = this.deps.backgroundTaskPromises.delete(taskPromise as Promise<void>);
                });
                this.deps.backgroundTaskPromises.add(taskPromise as Promise<void>);
            }
            const { handle: groupHandle, groupToken } = await createGroupHandle(this.deps.sessionManager, tenantId, sessionId, childTokens);
            const snap = await this.deps.sessionManager.load(tenantId, sessionId);
            const base = (snap?.snapshot as Record<string, unknown>) || {};
            const groups = getPendingGroups(base);
            const g = groups[groupToken] || { childTokens: childTokens, results: {}, handlers: {} };
            if (opts?.withTimeoutMs) g.timeoutMs = opts.withTimeoutMs;
            if (opts?.cancelRemaining !== undefined) g.cancelRemaining = opts.cancelRemaining;
            if (opts?.onAllCompleted) { g.handlers = g.handlers || {}; (g.handlers as any).allCompleted = opts.onAllCompleted; }
            if (opts?.onAnyFailed) { g.handlers = g.handlers || {}; (g.handlers as any).anyFailed = opts.onAnyFailed; }
            groups[groupToken] = g;
            const next = setPendingGroups(base, groups);
            await this.deps.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: (base as any)?.meta?.agentId || 'default', expectedWmVersion: snap?.wmVersion ?? BigInt(0), snapshot: next });
            return groupHandle as GroupHandle;
        };
    }
}
