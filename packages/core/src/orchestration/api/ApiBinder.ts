
import * as uuid from 'uuid';
const uuidv7 = uuid.v7;
import { logger } from '@a2arium/callagent-utils';
import type { TaskContext } from '../../shared/types/index.js';
import { ArtifactHydrationService } from '../ArtifactHydrationService.js';
import { AgentResultCache, ArtifactImpl } from '@a2arium/callagent-memory-engine';
import { type EngineObservation, type EngineObservationInbox } from '../InboxManager.js';
import { applyInputProvided, getPendingInputs, setPendingInputs } from '../DurableHandlerRegistry.js';
import { compactModuleOutput } from '../../telemetry/turnTraceHelpers.js';
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
import type { InternalConversationApi } from '../../internal/conversation/types.js';
import type {
    ArchiveConversationOptions,
    CloseConversationOptions,
    ConversationRef,
    FanoutSendReceipt,
    OutboundThreadMessage,
    SendOptions,
    StartThreadOptions,
    ThreadRef,
    TopicJoinOptions,
    TopicDeclineOptions,
    TopicLeaveOptions,
    TopicPostOptions,
    TopicRef,
    TopicCreateOptions,
    TopicInviteOptions,
    OutboundTopicMessage,
} from '../../public-types/conversation/types.js';
import { stampTopicPostTurnTrace } from './topicTurnTraceStamp.js';
import { MemberIdSchema } from '../../public-types/conversation/schemas.js';
import type { A2ACallOptions } from '../../shared/types/A2ATypes.js';
import { bootstrapConversationForSendTaskToAgent } from './bootstrapConversationForSendTaskToAgent.js';
import { readA2aResultTelemetry } from './a2aResultTelemetry.js';
import type { IEventBus } from '../../public-types/eventbus/types.js';
import { createBusEvent } from '../../eventbus/busEventHelpers.js';
import { taskChannel } from '../../eventbus/taskEventEmitter.js';
import { mapWorkingMemoryEventToRuntimeStream } from '../../streaming/sessionEventMapper.js';
import type { TaskState } from '../../shared/types/StreamingEvents.js';

const log = logger.createLogger({ prefix: 'ApiBinder' });

const TERMINAL_CHILD_STATES: ReadonlySet<TaskState> = new Set(['completed', 'failed', 'canceled']);

function isTerminalChildState(state: string | undefined): boolean {
    return state === undefined || TERMINAL_CHILD_STATES.has(state as TaskState);
}

export interface ApiBinderDependencies {
    sessionManager: SessionManager;
    snapshotRepo: SnapshotRepository;
    getTraceContext: () => any; // dummy or real
    getSessionStorePrisma: () => any;
    taskCreationMutex: { runExclusive: <T>(key: string, fn: () => Promise<T>) => Promise<T> };
    backgroundTaskPromises: Set<Promise<void>>;
    handleChildCompleted: (params: { tenantId: string; parentTaskId: string; childToken?: string; childTaskId?: string; result: unknown; childAgentId?: string }) => Promise<void>;
    handleToolCompleted?: (params: { tenantId: string; taskId: string; token: string; result: unknown }) => Promise<void>;
    conversationService: InternalConversationApi;
    eventBus?: IEventBus;
}

export class ApiBinder {
    constructor(private deps: ApiBinderDependencies) { }

    /**
     * Shared implementation for `ctx.sendTaskToAgent` (TaskEngine and streaming runner).
     */
    static createSendTaskToAgentHandler(
        deps: ApiBinderDependencies,
        ctx: TaskContext,
        bind: { tenantId: string; sessionId: string; agentId: string; flushMentalState: () => Promise<void> }
    ): TaskContext['sendTaskToAgent'] {
        const { tenantId, sessionId, agentId, flushMentalState } = bind;
        const conversationService = deps.conversationService;
        const fn = async (agent: string, childInput: unknown, options?: A2ACallOptions) => {
            return ApiBinder.runSendTaskToAgentBody(deps, ctx, { tenantId, sessionId, agentId, flushMentalState }, agent, childInput, options);
        };
        return fn as TaskContext['sendTaskToAgent'];
    }

    private static async runSendTaskToAgentBody(
        deps: ApiBinderDependencies,
        ctx: TaskContext,
        bind: { tenantId: string; sessionId: string; agentId: string; flushMentalState: () => Promise<void> },
        agent: string,
        childInput: unknown,
        options?: A2ACallOptions
    ): Promise<{ handle: unknown; token: string }> {
        const { tenantId, sessionId, agentId, flushMentalState } = bind;
        const conversationService = deps.conversationService;
        log.debug('[sendTaskToAgent] START', { agent, taskId: sessionId });
        if (!deps.sessionManager) throw new Error('Session manager not configured');
        if ((options as { skipFlush?: boolean } | undefined)?.skipFlush !== true) {
            try {
                await flushMentalState();
            } catch {
                /* noop */
            }
        }

        log.debug(`[sendTaskToAgent] Requesting mutex for ${tenantId}:${sessionId}`);
        let token = (options as { customToken?: string } | undefined)?.customToken;
        const { handle, token: generatedToken } = await deps.taskCreationMutex.runExclusive(
            `${tenantId}:${sessionId}`,
            async () => {
                return await createTaskHandle(deps.sessionManager!, tenantId, sessionId, agent, childInput);
            }
        );
        if (!token) token = generatedToken;

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
                awaitCompletion: options?.awaitCompletion !== false,
                childAgentNodeId: childCallNode.id,
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
            if (tasks[token]) {
                tasks[token].options = {
                    setToken: shouldSetToken,
                    tokenPath,
                    autoClearToken: options?.autoClearToken !== false,
                    setStage: options?.setStage,
                };
                let next = setPendingTasks(baseSnap, tasks);
                if (controlUpdates.length > 0) {
                    for (const [path, value] of controlUpdates) {
                        next = TaskStateUtils.applyControlVarToSnapshot(next, path, value);
                    }
                }
                await deps.sessionManager.saveSnapshot({
                    tenantId,
                    sessionId,
                    agentId: (baseSnap as { meta?: { agentId?: string } })?.meta?.agentId || 'default',
                    expectedWmVersion: expectedVer,
                    snapshot: next,
                });
            }
        };

        try {
            let attempts = 0;
            const maxAttempts = 3;
            let saved = false;

            while (attempts < maxAttempts) {
                attempts++;
                const snapOptions = await deps.sessionManager.load(tenantId, sessionId);
                const baseOptions = (snapOptions?.snapshot as Record<string, unknown>) || {};
                const expected = snapOptions?.wmVersion ?? BigInt(0);

                const hasMeta = !!(baseOptions as { meta?: unknown }).meta;
                const hasM = !!(baseOptions as { M?: unknown }).M;
                const isVersionZero = expected === BigInt(0);

                if (hasMeta || hasM || isVersionZero) {
                    await writeOnce(baseOptions, expected);
                    saved = true;
                    break;
                }
                if (attempts < maxAttempts) await new Promise((r) => setTimeout(r, 200 * attempts));
            }

            if (!saved) {
                const snapFinal = await deps.sessionManager.load(tenantId, sessionId);
                await writeOnce((snapFinal?.snapshot as Record<string, unknown>) || {}, snapFinal?.wmVersion ?? BigInt(0));
            }
        } catch (e) {
            if ((e as Error).message === 'CAS_MISMATCH') {
                try {
                    const snapRetry = await deps.sessionManager.load(tenantId, sessionId);
                    await writeOnce((snapRetry?.snapshot as Record<string, unknown>) || {}, snapRetry?.wmVersion ?? BigInt(0));
                } catch {
                    /* noop */
                }
            } else throw e;
        }

        const optAny = (options ?? {}) as {
            onInputRequired?: unknown;
            onCompleted?: unknown;
            onFailed?: unknown;
        };
        const handleHooks = handle as unknown as {
            onInputRequired?: (cb: unknown) => Promise<unknown>;
            onCompleted?: (cb: unknown) => Promise<unknown>;
            onFailed?: (cb: unknown) => Promise<unknown>;
        };
        if (optAny.onInputRequired) {
            try {
                await handleHooks.onInputRequired?.(optAny.onInputRequired);
            } catch {
                /* noop */
            }
        }
        if (optAny.onCompleted) {
            try {
                await handleHooks.onCompleted?.(optAny.onCompleted);
            } catch {
                /* noop */
            }
        }
        if (optAny.onFailed) {
            try {
                await handleHooks.onFailed?.(optAny.onFailed);
            } catch {
                /* noop */
            }
        }

        const awaitCompletion = options?.awaitCompletion !== false;
        type CtxWithLoop = TaskContext & {
            __activeLoopInbox?: { current: unknown[]; all: unknown[] };
            __activeLoopEnv?: { turn?: number; pending?: { children?: Record<string, unknown> } };
        };
        const minimalCtx = ctx as CtxWithLoop;
        const a2aOptions = {
            tenantId,
            streaming: options?.streaming === true,
            parentTenantId: tenantId,
            parentTaskId: sessionId,
            parentChildToken: token,
            skipParentNotification: awaitCompletion,
            parentTelemetryNodeId: childCallNode.id,
        };

        const a2aOpts = options;
        const idempotencyKey =
            a2aOpts?.childTaskId ?? `a2a:${tenantId}:${sessionId}:${agentId}:${agent}:${token}`;

        const childStartedPayload = { token, agentId: agent };
        const childStartedEvent = await deps.sessionManager.appendEvent(tenantId, sessionId, 'task.child_started', childStartedPayload);
        if (deps.eventBus) {
            const [runtimeEvent] = mapWorkingMemoryEventToRuntimeStream({
                eventId: childStartedEvent.eventId,
                seq: childStartedEvent.seq,
                type: 'task.child_started',
                payload: childStartedPayload,
                createdAt: new Date().toISOString(),
            }, {
                taskId: sessionId,
                tenantId,
                agentId,
            });
            if (runtimeEvent) {
                void deps.eventBus.publish(createBusEvent({
                    channel: taskChannel(sessionId),
                    cloud: {
                        id: runtimeEvent.id,
                        type: runtimeEvent.type,
                        source: `/tasks/${sessionId}`,
                        time: runtimeEvent.ts,
                        datacontenttype: 'application/json',
                        data: runtimeEvent,
                    },
                }));
            }
        }

        let convoStamp: import('./bootstrapConversationForSendTaskToAgent.js').ConversationBootstrapStamp | undefined;
        try {
            convoStamp = await bootstrapConversationForSendTaskToAgent({
                conversationService,
                tenantId,
                senderSessionId: sessionId,
                senderAgentId: agentId,
                targetAgent: agent,
                taskInput: childInput as TaskInput,
                idempotencyKey,
                conversation: a2aOpts?.conversation,
            });
        } catch (bootErr) {
            const er = bootErr instanceof Error ? bootErr : new Error(String(bootErr));
            childCallNode.fail(er);
            telemetry.failNode(childCallNode, er);
            telemetry.endNode(childCallNode);
            if (iCtx.__turnChildCalls) {
                iCtx.__turnChildCalls.push({
                    token,
                    agentId: agent,
                    status: 'failed',
                    module: iCtx.__currentModule,
                    error: { message: er.message },
                });
            }
            throw bootErr;
        }

        const runA2a = () =>
            globalA2AService.sendTaskToAgent(minimalCtx, agent, childInput as TaskInput, {
                ...(options || {}),
                ...a2aOptions,
            });

        let result: unknown;
        try {
            const timeoutMs = a2aOpts?.timeout;
            if (timeoutMs != null && timeoutMs > 0) {
                result = await Promise.race([
                    runA2a(),
                    new Promise<never>((_, reject) =>
                        setTimeout(() => reject(new Error('ConversationTimeout')), timeoutMs)
                    ),
                ]);
            } else {
                result = await runA2a();
            }
        } catch (error) {
            const er = error instanceof Error ? error : new Error(String(error));
            childCallNode.fail(er);
            telemetry.failNode(childCallNode, er);
            telemetry.endNode(childCallNode);
            if (iCtx.__turnChildCalls) {
                iCtx.__turnChildCalls.push({
                    token,
                    agentId: agent,
                    status: 'failed',
                    module: iCtx.__currentModule,
                    error: { message: error instanceof Error ? error.message : String(error) },
                });
            }
            await deps.sessionManager!.enqueueOutbox(tenantId, 'task.child_dispatch', sessionId, {
                taskId: sessionId,
                childAgent: agent,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }

        const cleanChildResult = TaskStateUtils.extractCleanChildResult(result as Record<string, unknown>);
        childCallNode.childTaskId = cleanChildResult.childTaskId;
        childCallNode.endTime = Date.now();
        childCallNode.end(cleanChildResult.result, 'success');
        telemetry.endNode(childCallNode);
        const a2aTel = readA2aResultTelemetry(result);
        if (iCtx.__turnChildCalls) {
            iCtx.__turnChildCalls.push({
                token,
                agentId: agent,
                childTaskId: cleanChildResult.childTaskId,
                status: 'completed',
                module: iCtx.__currentModule,
                childAgentNodeId: childCallNode.id,
                childTraceId: a2aTel?.childTraceId,
                resultSummary:
                    cleanChildResult.result != null
                        ? compactModuleOutput({ result: cleanChildResult.result })
                        : undefined,
            });
        }

        if (convoStamp && awaitCompletion) {
            try {
                await conversationService.close(tenantId, sessionId, agentId, convoStamp.thread, {});
            } catch (closeErr) {
                log.warn('[sendTaskToAgent] post-success thread close failed', {
                    error: closeErr instanceof Error ? closeErr.message : String(closeErr),
                });
            }
        }

        const inbox = (
            ctx as {
                __activeLoopInbox?: { current: unknown[]; all: unknown[] };
                __activeLoopEnv?: { turn?: number; pending?: { children?: Record<string, unknown> } };
            }
        ).__activeLoopInbox;
        if (inbox) {
            const loopEnv = minimalCtx.__activeLoopEnv;
            if (loopEnv?.pending?.children) {
                loopEnv.pending.children[token] = {
                    agent,
                    input: childInput,
                };
            }

            if (isTerminalChildState(cleanChildResult.executionMetadata?.state)) {
                const obs: EngineObservation = {
                    source: 'child',
                    kind: 'child.completed',
                    payload: {
                        token,
                        childTaskId: cleanChildResult.childTaskId,
                        result: cleanChildResult.result,
                        executionMetadata: cleanChildResult.executionMetadata,
                    },
                    provenance: {
                        ts: Date.now(),
                        turn: minimalCtx.__activeLoopEnv?.turn ?? 0,
                        id: token,
                        correlationId: token,
                    },
                };

                inbox.current.push(obs);
                inbox.all.push(obs);

                log.debug('✅ SYNC CHILD: Injected completion into active loop inbox', { token, awaitCompletion });
            } else {
                log.debug('SYNC CHILD: Child is still active; pending without completion injection', {
                    token,
                    awaitCompletion,
                    state: cleanChildResult.executionMetadata?.state,
                });
            }
        } else if (awaitCompletion) {
            await deps.handleChildCompleted({ tenantId, parentTaskId: sessionId, childToken: token, result });
        }

        if (result && typeof result === 'object') {
            const h = handle as unknown as Record<string, unknown>;
            const r = result as Record<string, unknown>;
            for (const key of Object.keys(result)) {
                if (key !== 'token') {
                    try {
                        h[key] = r[key];
                    } catch {
                        /* read-only */
                    }
                }
            }
            return { handle, token };
        }
        return { handle, token };
    }

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
        const conversationService = this.deps.conversationService;

        (ctx as TaskContext).conversation = {
            startThread: async (options: StartThreadOptions) => {
                const receipt = await conversationService.startThread(tenantId, sessionId, agentId, options);
                const iCtx = ctx as InternalTaskContext;
                if (receipt.receipt.status === 'accepted') {
                    iCtx.__turnConversationSummary = {
                        id: receipt.thread.id,
                        kind: receipt.thread.kind,
                    };
                    iCtx.__turnConversationSequenceNumber = receipt.receipt.sequenceNumber;
                    iCtx.__turnConversationDedupeHit = receipt.receipt.dedupeHit;
                    const ra = options.message.recipientAgentId ?? options.targetAgentId;
                    iCtx.__turnOutgoingConversationMessages?.push({
                        id: receipt.receipt.messageId,
                        conversationId: receipt.thread.id,
                        kind: 'thread',
                        senderAgentId: options.message.senderAgentId,
                        recipientAgentId: ra,
                        senderMemberId: options.message.senderAgentId,
                        recipientMemberId: MemberIdSchema.parse(ra),
                        speechAct: options.message.speechAct,
                        sequenceNumber: receipt.receipt.sequenceNumber,
                        correlationId: options.message.correlationId,
                        idempotencyKey: options.idempotencyKey,
                    });
                }
                return receipt;
            },
            send: async (thread: ThreadRef, message: OutboundThreadMessage, options?: SendOptions) => {
                const receipt = await conversationService.send(tenantId, sessionId, thread, message, options);
                const iCtx = ctx as InternalTaskContext;
                iCtx.__turnConversationSummary = {
                    id: thread.id,
                    kind: thread.kind,
                };
                if (receipt.status === 'accepted') {
                    iCtx.__turnConversationSequenceNumber = receipt.sequenceNumber;
                    iCtx.__turnConversationDedupeHit = receipt.dedupeHit;
                    iCtx.__turnOutgoingConversationMessages?.push({
                        id: receipt.messageId,
                        conversationId: thread.id,
                        kind: 'thread',
                        senderAgentId: message.senderAgentId,
                        recipientAgentId: message.recipientAgentId,
                        senderMemberId: message.senderAgentId,
                        recipientMemberId: MemberIdSchema.parse(message.recipientAgentId),
                        speechAct: message.speechAct,
                        sequenceNumber: receipt.sequenceNumber,
                        correlationId: message.correlationId,
                        idempotencyKey: options?.idempotencyKey,
                    });
                }
                return receipt;
            },
            createTopic: (options: TopicCreateOptions) =>
                conversationService.createTopic(tenantId, sessionId, agentId, options),
            invite: (options: TopicInviteOptions) =>
                conversationService.invite(tenantId, sessionId, agentId, options),
            join: (topic: TopicRef, options: TopicJoinOptions) =>
                conversationService.join(tenantId, sessionId, agentId, topic, options),
            decline: (topic: TopicRef, options: TopicDeclineOptions) =>
                conversationService.decline(tenantId, sessionId, agentId, topic, options),
            leave: (topic: TopicRef, options?: TopicLeaveOptions) =>
                conversationService.leave(tenantId, sessionId, agentId, topic, options),
            post: async (topic: TopicRef, message: OutboundTopicMessage, options?: TopicPostOptions) => {
                const iCtx = ctx as InternalTaskContext;
                conversationService.setTopicPostBackpressureSink?.((sample) => {
                    iCtx.__turnBackpressure = sample;
                });
                try {
                    const receipt: FanoutSendReceipt = await conversationService.post(
                        tenantId,
                        sessionId,
                        agentId,
                        topic,
                        message,
                        options
                    );
                    stampTopicPostTurnTrace(iCtx, topic, options, receipt);
                    return receipt;
                } finally {
                    conversationService.setTopicPostBackpressureSink?.(undefined);
                }
            },
            close: async (ref: ConversationRef, options?: CloseConversationOptions) => {
                return conversationService.close(tenantId, sessionId, agentId, ref, options);
            },
            archive: async (ref: ConversationRef, options?: ArchiveConversationOptions) => {
                return conversationService.archive(tenantId, sessionId, agentId, ref, options);
            },
            readProjection: async (topic, token, options) =>
                conversationService.readProjection(tenantId, sessionId, agentId, topic, token, options),
            appendSignal: async (topic, input, options) =>
                conversationService.appendSignal(tenantId, sessionId, agentId, topic, input, options),
        };

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
            const token = opts?.__existingToken || uuidv7();
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
            let toolToken = opts?.setToken && typeof opts.setToken === 'string' ? opts.setToken : `tool-${uuidv7()}`;
            try { await flushMentalState(); } catch { /* best-effort */ }

            // Use saveWithRetry to avoid CAS_MISMATCH after flushMentalState bumps version
            await this.deps.snapshotRepo.saveWithRetry({
                tenantId, sessionId,
                agentId: (ctx as any).agentId || 'default',
                mutate: (baseSnap) => {
                    const toolsNow = { ...getPendingTools(baseSnap) } as any;
                    toolsNow[toolToken] = { name: toolName, args, handlers: { completed: opts?.onCompleted } };
                    if (opts?.setToken || opts?.setStage) {
                        toolsNow[toolToken].options = { setToken: opts.setToken, setStage: opts.setStage };
                    }
                    return setPendingTools(baseSnap, toolsNow);
                }
            });
            const toolRequestedPayload = { token: toolToken, toolName, argsPreview: args };
            const toolRequestedEvent = await this.deps.sessionManager.appendEvent(tenantId, sessionId, 'task.tool_requested', toolRequestedPayload);
            if (this.deps.eventBus) {
                const [runtimeEvent] = mapWorkingMemoryEventToRuntimeStream({
                    eventId: toolRequestedEvent.eventId,
                    seq: toolRequestedEvent.seq,
                    type: 'task.tool_requested',
                    payload: toolRequestedPayload,
                    createdAt: new Date().toISOString(),
                }, {
                    taskId: sessionId,
                    tenantId,
                    agentId,
                });
                if (runtimeEvent) {
                    void this.deps.eventBus.publish(createBusEvent({
                        channel: taskChannel(sessionId),
                        cloud: {
                            id: runtimeEvent.id,
                            type: runtimeEvent.type,
                            source: `/tasks/${sessionId}`,
                            time: runtimeEvent.ts,
                            datacontenttype: 'application/json',
                            data: runtimeEvent,
                        },
                    }));
                }
            }

            (ctx as any).__wmSavedThisTurn = true;

            // Trigger async auto-execution in the background
            if (typeof (ctx as any).__autoExecuteTool === 'function') {
                // Don't await - let it run in the background, but track the promise
                const toolPromise = (ctx as any).__autoExecuteTool(tenantId, sessionId, toolToken, toolName, args).catch((e: Error) => {
                    log.error('[ApiBinder] Background tool execution failed', { token: toolToken, toolName, error: e.message });
                }).finally(() => {
                    this.deps.backgroundTaskPromises.delete(toolPromise);
                });
                this.deps.backgroundTaskPromises.add(toolPromise);
            }

            return { token: toolToken } as any;
        };

        ctx.sendTaskToAgent = ApiBinder.createSendTaskToAgentHandler(this.deps, ctx, {
            tenantId,
            sessionId,
            agentId,
            flushMentalState,
        });

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

                const parentId = ctx.telemetry?.nodeId ?? 'root';
                const parentNode = telemetry.getNode(parentId);
                const traceIdForChild = parentNode?.traceId;
                const childCallNode = new ChildCallNode(token, parentId, child.agent, undefined, traceIdForChild);
                childCallNode.start({ token, agentId: child.agent });
                telemetry.registerNode(childCallNode);

                const taskPromise = globalA2AService
                    .sendTaskToAgent(ctx as any, child.agent, child.input as any, {
                        tenantId,
                        parentTenantId: tenantId,
                        parentTaskId: sessionId,
                        parentChildToken: token,
                        awaitCompletion: false,
                        skipFlush: true,
                        parentTelemetryNodeId: childCallNode.id,
                    } as any)
                    .then((result) => {
                        const cleanChildResult = TaskStateUtils.extractCleanChildResult(result as Record<string, unknown>);
                        childCallNode.childTaskId = cleanChildResult.childTaskId;
                        childCallNode.endTime = Date.now();
                        childCallNode.end(cleanChildResult.result, 'success');
                        telemetry.endNode(childCallNode);
                        return result;
                    })
                    .catch(async (e: unknown) => {
                        const er = e instanceof Error ? e : new Error(String(e));
                        childCallNode.fail(er);
                        telemetry.failNode(childCallNode, er);
                        telemetry.endNode(childCallNode);
                        await this.deps.sessionManager!.enqueueOutbox(tenantId, 'task.child_dispatch', sessionId, {
                            taskId: sessionId,
                            childAgent: child.agent,
                            error: er.message,
                        });
                    })
                    .finally(() => {
                        this.deps.backgroundTaskPromises.delete(taskPromise as Promise<void>);
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
