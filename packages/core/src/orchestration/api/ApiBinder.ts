
import * as uuid from 'uuid';
const uuidv7 = uuid.v7;
import { logger } from '@a2arium/callagent-utils';
import type { TaskContext } from '../../shared/types/index.js';
import { ArtifactHydrationService } from '../ArtifactHydrationService.js';
import { AgentResultCache } from '@a2arium/callagent-memory-engine';
import { InboxManager, type EngineObservation, type EngineObservationInbox } from '../InboxManager.js';
import { applyInputProvided, getPendingInputs, setPendingInputs } from '../DurableHandlerRegistry.js';
import { compactModuleOutput } from '../../telemetry/turnTraceHelpers.js';
import { getPendingTools, setPendingTools } from '../ToolsRegistry.js';
import { getPendingExternalEvents, setPendingExternalEvents } from '../ExternalEventsRegistry.js';
import { getPendingTasks, setPendingTasks, getPendingGroups, setPendingGroups } from '../Handles.js';
import { InputHandle, createTaskHandle, GroupHandle } from '../Handles.js';
import { globalA2AService } from '../A2AService.js';
import type { SessionManager } from '../SessionManager.js';
import { reconcileSnapshotMutation, type SnapshotRepository } from '../persistence/SnapshotRepository.js';
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
import { pickPlanStepStamp } from '../../plans/planStepCorrelation.js';
import { createBusEvent } from '../../eventbus/busEventHelpers.js';
import { taskChannel } from '../../eventbus/taskEventEmitter.js';
import { segmentEffectIdempotencyKey } from '../../runtime/segmentProcessedKeys.js';
import { mapWorkingMemoryEventToRuntimeStream } from '../../streaming/sessionEventMapper.js';
import type { TaskState } from '../../shared/types/StreamingEvents.js';
import type { EnqueueStartParams, ScheduleTimerParams } from '../../runtime/runtimeDriver.js';
import type { TaskTurnRuntimeSurface } from '../TaskTurnCoordinator.js';
import { makeSafeEventPreview } from '../safeEventPreview.js';
import { prepareChildResultForPersistence } from '../childResultPersistence.js';
import { coordinateChildTerminal } from '../ChildTerminalCoordinator.js';
import { ensureTaskLifecycle, readTaskLifecycle } from '../TaskLifecycle.js';
import { assertTaskEffectActive, registerTaskEffect } from '../TaskEffectRegistration.js';
import { isTaskLifecycleTerminalError } from '@a2arium/callagent-types/task-lifecycle-terminal';
import {
    assertArtifactsFactory,
    createArtifactFactory,
} from '../../context/artifactFactory.js';
import { PluginManager } from '../../plugin/pluginManager.js';
import type { SubmitTaskResult } from '../TaskSubmission.js';

const log = logger.createLogger({ prefix: 'ApiBinder' });

const TERMINAL_CHILD_STATES: ReadonlySet<TaskState> = new Set(['completed', 'failed', 'canceled']);

function isTerminalChildState(state: string | undefined): boolean {
    return state === undefined || TERMINAL_CHILD_STATES.has(state as TaskState);
}

function projectPreparedChildResult(result: unknown, preparedResult: unknown): unknown {
    if (!TaskStateUtils.isTaskEntityResult(result)) return preparedResult;
    const task = result as Record<string, any>;
    return {
        ...task,
        status: {
            ...task.status,
            metadata: {
                ...(task.status?.metadata ?? {}),
                result: preparedResult,
            },
        },
    };
}

function childExecutionFailure(result: unknown, state: string): { code: string; message: string } {
    const status = result !== null && typeof result === 'object'
        ? (result as { status?: { metadata?: Record<string, unknown>; message?: unknown } }).status
        : undefined;
    const rawError = status?.metadata?.error ?? status?.metadata?.reason ?? status?.message;
    if (rawError !== null && typeof rawError === 'object' && !Array.isArray(rawError)) {
        const record = rawError as Record<string, unknown>;
        return {
            code: typeof record.code === 'string'
                ? record.code
                : state === 'canceled' ? 'CHILD_CANCELED' : 'CHILD_FAILED',
            message: typeof record.message === 'string'
                ? record.message
                : `Child task ${state}.`,
        };
    }
    return {
        code: state === 'canceled' ? 'CHILD_CANCELED' : 'CHILD_FAILED',
        message: typeof rawError === 'string' ? rawError : `Child task ${state}.`,
    };
}

function buildA2AChildTaskId(sourceTaskId: string, targetAgentId: string): string {
    const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    return `a2a_${sourceTaskId.slice(0, 16)}_${targetAgentId.slice(0, 16)}_${uniqueSuffix}`;
}

export interface ApiBinderDependencies {
    sessionManager: SessionManager;
    snapshotRepo: SnapshotRepository;
    getTraceContext: () => any; // dummy or real
    getSessionStorePrisma: () => any;
    taskCreationMutex: { runExclusive: <T>(key: string, fn: () => Promise<T>) => Promise<T> };
    backgroundTaskPromises: Set<Promise<void>>;
    trackBackgroundTask?: <T>(promise: Promise<T>, metadata: {
        kind: string;
        label?: string;
        tenantId?: string;
        taskId?: string;
        agentId?: string;
        token?: string;
        toolName?: string;
        childAgent?: string;
        childTaskId?: string;
        source?: string;
        rootTaskId?: string;
        ancestorTaskIds?: string[];
        abort?: () => void | Promise<void>;
    }) => Promise<T>;
    runOwnedEffect?: <T>(
        factory: (control: { signal: AbortSignal }) => Promise<T>,
        metadata: {
            kind: string;
            label?: string;
            tenantId: string;
            taskId: string;
            agentId?: string;
            token?: string;
            toolName?: string;
            childAgent?: string;
            childTaskId?: string;
            source?: string;
            rootTaskId?: string;
            ancestorTaskIds?: string[];
            pendingKind?: 'tools' | 'tasks';
        }
    ) => Promise<T>;
    handleToolCompleted?: (params: { tenantId: string; taskId: string; token: string; result: unknown }) => Promise<void>;
    conversationService: InternalConversationApi;
    eventBus?: IEventBus;
    enqueueChildStart?: (params: EnqueueStartParams) => Promise<void>;
    scheduleChildTimeout?: (params: ScheduleTimerParams) => Promise<{ timerId: string }>;
    cancelTimer?: (params: { tenantId: string; taskId: string; token: string }) => Promise<void>;
    detachTaskBranch?: (params: { tenantId: string; taskId: string; reason: string }) => Promise<unknown>;
    getRuntimeSurface?: () => TaskTurnRuntimeSurface;
    submitRootTask?: (params: {
        tenantId: string;
        sourceTaskId: string;
        sourceAgentId: string;
        targetAgentId: string;
        input: unknown;
        options: { taskId: string; maxTurns?: number; taskRunTimeoutMs?: number };
    }) => Promise<SubmitTaskResult>;
}

export class ApiBinder {
    constructor(private deps: ApiBinderDependencies) { }

    private static async assertEffectActive(
        deps: ApiBinderDependencies,
        params: Parameters<typeof assertTaskEffectActive>[0]
    ): Promise<void> {
        try {
            await assertTaskEffectActive(params);
        } catch (error) {
            if (
                isTaskLifecycleTerminalError(error) &&
                error.details.reason !== 'effect_token_not_pending'
            ) {
                await deps.detachTaskBranch?.({
                    tenantId: params.tenantId,
                    taskId: params.taskId,
                    reason: error.details.reason ?? `owner_${error.details.state}`,
                });
            }
            throw error;
        }
    }

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
        const callStartedAt = Date.now();
        const configuredTimeout = options?.timeout;
        const timeoutMs =
            typeof configuredTimeout === 'number' && Number.isFinite(configuredTimeout) && configuredTimeout > 0
                ? configuredTimeout
                : undefined;
        const expiresAt = timeoutMs === undefined
            ? undefined
            : new Date(callStartedAt + timeoutMs).toISOString();
        const childTaskId = options?.childTaskId ?? buildA2AChildTaskId(sessionId, agent);
        const conversationService = deps.conversationService;
        log.debug('[sendTaskToAgent] START', { agent, taskId: sessionId });
        if (!deps.sessionManager) throw new Error('Session manager not configured');
        await ApiBinder.assertEffectActive(deps, {
            session: deps.sessionManager,
            tenantId,
            taskId: sessionId,
            effectKind: 'child',
        });
        if ((options as { skipFlush?: boolean } | undefined)?.skipFlush !== true) {
            try {
                await flushMentalState();
            } catch {
                /* noop */
            }
        }

        const token = (options as { customToken?: string } | undefined)?.customToken ?? uuidv7();
        const tokenPath = options?.tokenPath ?? 'child.token';
        const shouldSetToken = options?.setToken !== false;
        const controlUpdates: Array<[string, unknown]> = [];
        if (shouldSetToken) controlUpdates.push([tokenPath, token]);
        if (options?.setStage) controlUpdates.push(['stage', options.setStage]);

        log.debug(`[sendTaskToAgent] Requesting mutex for ${tenantId}:${sessionId}`);
        const { handle, token: generatedToken } = await deps.taskCreationMutex.runExclusive(
            `${tenantId}:${sessionId}`,
            async () => {
                return await createTaskHandle(
                    deps.sessionManager!,
                    tenantId,
                    sessionId,
                    agent,
                    childInput,
                    token,
                    {
                        entry: {
                            options: {
                                setToken: shouldSetToken,
                                tokenPath,
                                autoClearToken: options?.autoClearToken !== false,
                                setStage: options?.setStage,
                            },
                            agentId: agent,
                            childTaskId,
                            ...pickPlanStepStamp(options),
                            ...(timeoutMs !== undefined && expiresAt !== undefined
                                ? { timeoutMs, expiresAt }
                                : {}),
                        },
                        controlUpdates,
                    }
                );
            }
        );
        if (generatedToken !== token) {
            throw new Error('CHILD_TOKEN_REGISTRATION_MISMATCH');
        }

        if (shouldSetToken) writeControlVar(ctx, tokenPath, token);
        if (options?.setStage) writeControlVar(ctx, 'stage', options.setStage);

        const parentId = ctx.telemetry?.nodeId ?? 'root';
        const parentNode = telemetry.getNode(parentId);
        const traceId = parentNode?.traceId ?? ctx.telemetry?.traceId;
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
            childTaskId ?? `a2a:${tenantId}:${sessionId}:${agentId}:${agent}:${token}`;

        const useRuntimeChildStart = awaitCompletion === false && deps.enqueueChildStart !== undefined;
        const parentSnapshotForLifecycle = await deps.sessionManager.load(tenantId, sessionId);
        const parentLifecycle = readTaskLifecycle(parentSnapshotForLifecycle?.snapshot, sessionId);
        const childRootTaskId = parentLifecycle?.rootTaskId ?? sessionId;
        const childAncestorTaskIds = [
            ...(parentLifecycle?.ancestorTaskIds ?? []),
            sessionId,
        ];
        await reconcileSnapshotMutation({
            session: deps.sessionManager,
            tenantId,
            sessionId: childTaskId,
            operation: 'child.dispatch.link_parent',
            agentId: agent,
            mutate: ({ snapshot }) => {
                const childMeta = (snapshot.meta as Record<string, unknown>) || {};
                const linked = {
                    ...snapshot,
                    meta: {
                        ...childMeta,
                        agentId: agent,
                        a2aParent: {
                            parentTenantId: tenantId,
                            parentTaskId: sessionId,
                            parentChildToken: token,
                        },
                        ...(ctx.telemetry?.traceId || ctx.telemetry?.nodeId
                            ? {
                                  telemetry: {
                                      ...(ctx.telemetry?.traceId ? { traceId: ctx.telemetry.traceId } : {}),
                                      ...(ctx.telemetry?.nodeId ? { parentNodeId: ctx.telemetry.nodeId } : {}),
                                  },
                              }
                            : {}),
                    },
                } as Record<string, unknown>;
                return {
                    kind: 'write',
                    value: undefined,
                    snapshot: ensureTaskLifecycle(linked, {
                        taskId: childTaskId,
                        rootTaskId: childRootTaskId,
                        parentTaskId: sessionId,
                        ancestorTaskIds: childAncestorTaskIds,
                    }),
                };
            },
        });
        try {
            await ApiBinder.assertEffectActive(deps, {
                session: deps.sessionManager,
                tenantId,
                taskId: sessionId,
                effectKind: 'child',
                token,
                pendingKind: 'tasks',
            });
        } catch (error) {
            await deps.detachTaskBranch?.({
                tenantId,
                taskId: childTaskId,
                reason: 'parent_terminal_before_child_dispatch',
            });
            throw error;
        }
        if (useRuntimeChildStart) {
            try {
                Object.defineProperty(handle as object, 'id', {
                    value: childTaskId,
                    configurable: true,
                    enumerable: true,
                });
            } catch {
                (handle as unknown as Record<string, unknown>).id = childTaskId;
            }
        }

        const childStartedPayload = {
            token,
            agentId: agent,
            childTaskId,
            inputPreview: makeSafeEventPreview(childInput),
        };
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

        if (awaitCompletion === false && expiresAt !== undefined && deps.scheduleChildTimeout) {
            const schedule = () => deps.scheduleChildTimeout!({
                    tenantId,
                    taskId: sessionId,
                    agentId,
                    token,
                    fireAt: expiresAt,
                    kind: 'child_timeout',
                    payload: { token, timeoutMs, expiresAt, childTaskId, agentId: agent },
                    idempotencyKey: `${sessionId}:child-timeout:${token}`,
                });
            await (deps.runOwnedEffect
                ? deps.runOwnedEffect(() => schedule(), {
                      kind: 'timer.child_timeout',
                      tenantId,
                      taskId: sessionId,
                      agentId,
                      token,
                      childTaskId,
                      rootTaskId: childRootTaskId,
                      ancestorTaskIds: parentLifecycle?.ancestorTaskIds ?? [],
                      pendingKind: 'tasks',
                  })
                : schedule());
            try {
                await ApiBinder.assertEffectActive(deps, {
                    session: deps.sessionManager,
                    tenantId,
                    taskId: sessionId,
                    effectKind: 'timer',
                    token,
                    pendingKind: 'tasks',
                });
            } catch (error) {
                await deps.cancelTimer?.({ tenantId, taskId: sessionId, token });
                throw error;
            }
        }

        if (useRuntimeChildStart) {
            await deps.enqueueChildStart!({
                tenantId,
                taskId: childTaskId,
                agentId: agent,
                input: childInput,
                cache: options?.cache,
                idempotencyKey,
                token,
                traceId,
                rootTaskId: childRootTaskId,
                parentTaskId: sessionId,
            });
            return { handle, token };
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
                childTaskId,
                ...a2aOptions,
            });

        let result: unknown;
        const dispatchPromise = deps.runOwnedEffect
            ? deps.runOwnedEffect(() => runA2a(), {
                  kind: 'agent.child_dispatch',
                  label: `agent.child_dispatch ${agent}`,
                  tenantId,
                  taskId: childTaskId,
                  agentId: agent,
                  token,
                  childAgent: agent,
                  childTaskId,
                  source: 'ApiBinder.sendTaskToAgent',
                  rootTaskId: childRootTaskId,
                  ancestorTaskIds: childAncestorTaskIds,
              })
            : runA2a();
        let dispatchTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
        try {
            if (timeoutMs != null && timeoutMs > 0) {
                result = await Promise.race([
                    dispatchPromise,
                    new Promise<never>((_, reject) =>
                        dispatchTimeoutHandle = setTimeout(() => {
                            const timeoutError = new Error('ConversationTimeout');
                            timeoutError.name = 'ConversationTimeout';
                            reject(timeoutError);
                        }, Math.max(0, Date.parse(expiresAt!) - Date.now()))
                    ),
                ]);
            } else {
                result = await dispatchPromise;
            }
        } catch (error) {
            if (awaitCompletion === false && (error as Error)?.name === 'ConversationTimeout') {
                const failedAt = new Date().toISOString();
                const claim = await coordinateChildTerminal({
                    session: deps.sessionManager,
                    tenantId,
                    parentTaskId: sessionId,
                    deliveryMode: 'async_wake',
                    runtimeSurface: deps.getRuntimeSurface?.() ?? 'in_process',
                    request: {
                        kind: 'failed',
                        token,
                        failedAt,
                        childTaskId,
                        agentId: agent,
                        error: {
                            code: 'CHILD_TIMEOUT',
                            message: `Child call timed out after ${timeoutMs}ms for token ${token}.`,
                            timeoutMs,
                        },
                    },
                });
                if (claim.terminal?.error?.code === 'CHILD_TIMEOUT') {
                    await deps.detachTaskBranch?.({
                        tenantId,
                        taskId: claim.terminal.childTaskId ?? childTaskId,
                        reason: 'child_timeout',
                    });
                }
                const tracked = dispatchPromise.then(
                    async (lateResult) => {
                        const lateClean = TaskStateUtils.extractCleanChildResult(lateResult);
                        if (!isTerminalChildState(lateClean.executionMetadata?.state)) {
                            await deps.sessionManager.appendEvent(
                                tenantId,
                                sessionId,
                                'task.child_late_completion',
                                {
                                    token,
                                    agentId: agent,
                                    childTaskId: lateClean.childTaskId ?? childTaskId,
                                    reason: 'dispatch_resolved_after_timeout',
                                    state: lateClean.executionMetadata?.state,
                                    resultPreview: makeSafeEventPreview(lateResult),
                                }
                            );
                        }
                    },
                    async (lateError) => {
                        await deps.sessionManager.appendEvent(tenantId, sessionId, 'task.child_late_completion', {
                            token,
                            agentId: agent,
                            childTaskId,
                            error: lateError instanceof Error ? lateError.message : String(lateError),
                            reason: 'dispatch_rejected_after_timeout',
                        });
                    }
                );
                if (deps.trackBackgroundTask) {
                    void deps.trackBackgroundTask(tracked, {
                        kind: 'child-dispatch-after-timeout',
                        tenantId,
                        taskId: sessionId,
                        agentId,
                        token,
                        childAgent: agent,
                        childTaskId,
                    });
                } else {
                    deps.backgroundTaskPromises.add(tracked);
                    void tracked.finally(() => deps.backgroundTaskPromises.delete(tracked));
                }
                return { handle, token };
            }
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
        } finally {
            if (dispatchTimeoutHandle !== undefined) clearTimeout(dispatchTimeoutHandle);
        }

        const cleanChildResult = TaskStateUtils.extractCleanChildResult(result as Record<string, unknown>);
        const childState = cleanChildResult.executionMetadata?.state;
        const childIsTerminal = isTerminalChildState(childState);
        const childFailed = childState === 'failed' || childState === 'canceled';
        const terminalFailure = childFailed ? childExecutionFailure(result, childState) : undefined;
        childCallNode.childTaskId = cleanChildResult.childTaskId;
        const a2aTel = readA2aResultTelemetry(result);
        const childExecutionMetadata = {
            ...(cleanChildResult.executionMetadata ?? {}),
            ...(a2aTel?.executionOrigin ? { origin: a2aTel.executionOrigin } : {}),
        };
        let childResultForParent = cleanChildResult.result;
        let projectedResultForCaller = result;

        if (childIsTerminal) {
            childCallNode.endTime = Date.now();
            if (childFailed) {
                const childError = new Error(terminalFailure!.message);
                childError.name = terminalFailure!.code;
                childCallNode.fail(childError);
                telemetry.failNode(childCallNode, childError);
            }
            if (!childFailed) {
                const prisma = deps.getSessionStorePrisma();
                const cache = prisma ? new AgentResultCache(prisma) : undefined;
                childResultForParent = await prepareChildResultForPersistence(
                    cleanChildResult.result,
                    cache,
                    tenantId
                );
                if (cache) {
                    projectedResultForCaller = projectPreparedChildResult(result, childResultForParent);
                }
                if (cache && projectedResultForCaller && typeof projectedResultForCaller === 'object') {
                    ArtifactHydrationService.tryHydrateChildResult(
                        projectedResultForCaller,
                        cache,
                        tenantId
                    );
                }
                childCallNode.end(childResultForParent, 'success');
            }
            telemetry.endNode(childCallNode);
            await coordinateChildTerminal({
                session: deps.sessionManager,
                tenantId,
                parentTaskId: sessionId,
                deliveryMode: awaitCompletion ? 'inline' : 'async_wake',
                runtimeSurface: deps.getRuntimeSurface?.() ?? 'in_process',
                request: childFailed
                    ? {
                          kind: 'failed',
                          token,
                          failedAt: new Date().toISOString(),
                          childTaskId: cleanChildResult.childTaskId ?? childTaskId,
                          agentId: agent,
                          error: terminalFailure!,
                      }
                    : {
                          kind: 'completed',
                          token,
                          completedAt: new Date().toISOString(),
                          childTaskId: cleanChildResult.childTaskId ?? childTaskId,
                          agentId: agent,
                          result: childResultForParent,
                          executionMetadata: Object.keys(childExecutionMetadata).length > 0
                              ? childExecutionMetadata as any
                              : undefined,
                      },
            });
        }

        if (iCtx.__turnChildCalls && childIsTerminal && !childFailed) {
            iCtx.__turnChildCalls.push({
                token,
                agentId: agent,
                childTaskId: cleanChildResult.childTaskId,
                status: 'completed',
                module: iCtx.__currentModule,
                childAgentNodeId: childCallNode.id,
                childTraceId: a2aTel?.childTraceId,
                resultSummary:
                    childResultForParent != null
                        ? compactModuleOutput({ result: childResultForParent })
                        : undefined,
            });
        } else if (iCtx.__turnChildCalls && childFailed) {
            iCtx.__turnChildCalls.push({
                token,
                agentId: agent,
                childTaskId: cleanChildResult.childTaskId,
                status: 'failed',
                module: iCtx.__currentModule,
                childAgentNodeId: childCallNode.id,
                childTraceId: a2aTel?.childTraceId,
                error: terminalFailure,
            });
        } else if (iCtx.__turnChildCalls) {
            iCtx.__turnChildCalls.push({
                token,
                agentId: agent,
                childTaskId: cleanChildResult.childTaskId,
                status: 'dispatched',
                module: iCtx.__currentModule,
                childAgentNodeId: childCallNode.id,
                childTraceId: a2aTel?.childTraceId,
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
                if (childIsTerminal) {
                    delete loopEnv.pending.children[token];
                } else {
                    loopEnv.pending.children[token] = {
                        agent,
                        input: childInput,
                        ...pickPlanStepStamp(options),
                    };
                }
            }

            if (awaitCompletion && childIsTerminal) {
                const obs: EngineObservation = {
                    source: 'child',
                    kind: childFailed ? 'child.failed' : 'child.completed',
                    payload: childFailed
                        ? {
                              token,
                              agentId: agent,
                              childTaskId: cleanChildResult.childTaskId ?? childTaskId,
                              error: terminalFailure!,
                          }
                        : {
                              token,
                              agentId: agent,
                              childTaskId: cleanChildResult.childTaskId ?? childTaskId,
                              result: childResultForParent,
                              executionMetadata: Object.keys(childExecutionMetadata).length > 0
                                  ? childExecutionMetadata
                                  : undefined,
                          },
                    provenance: {
                        ts: Date.now(),
                        turn: minimalCtx.__activeLoopEnv?.turn ?? 0,
                        id: token,
                        correlationId: token,
                    },
                };

                const terminalSnapshot = await deps.sessionManager.load(tenantId, sessionId);
                const durableTerminal = ((terminalSnapshot?.snapshot as any)?.inbox?.all ?? []).find(
                    (candidate: EngineObservation) =>
                        (candidate.kind === 'child.completed' || candidate.kind === 'child.failed') &&
                        (candidate.payload as { token?: unknown } | undefined)?.token === token
                ) as EngineObservation | undefined;
                const deliveredObservation = durableTerminal ?? obs;
                const terminalPredicate = (candidate: EngineObservation) =>
                    (candidate.kind === 'child.completed' || candidate.kind === 'child.failed') &&
                    (candidate.payload as { token?: unknown } | undefined)?.token === token;
                const mergedInbox = InboxManager.addObservationToInboxIfMissing(
                    { current: inbox.current as EngineObservation[], all: inbox.all as EngineObservation[] },
                    deliveredObservation,
                    terminalPredicate
                );
                inbox.current.splice(0, inbox.current.length, ...mergedInbox.current);
                inbox.all.splice(0, inbox.all.length, ...mergedInbox.all);

                log.debug('✅ SYNC CHILD: Injected completion into active loop inbox', { token, awaitCompletion });
            } else if (!childIsTerminal) {
                log.debug('SYNC CHILD: Child is still active; pending without completion injection', {
                    token,
                    awaitCompletion,
                    state: childState,
                });
            } else {
                log.debug('ASYNC CHILD: Terminal delivery staged for runtime wake without inline injection', {
                    token,
                    state: childState,
                });
            }
        }

        if (projectedResultForCaller && typeof projectedResultForCaller === 'object') {
            const h = handle as unknown as Record<string, unknown>;
            const r = projectedResultForCaller as Record<string, unknown>;
            for (const key of Object.keys(projectedResultForCaller)) {
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

        if (this.deps.runOwnedEffect) {
            ctx.effects = {
                run: async <T>(
                    input: { kind: string; idempotencyKey: string; operation?: string },
                    execute: (control: { readonly signal: AbortSignal; readonly idempotencyKey: string }) => Promise<T>
                ): Promise<T> => {
                    const kind = input.kind.trim();
                    const idempotencyKey = input.idempotencyKey.trim();
                    if (!/^[a-z][a-z0-9._-]{0,95}$/i.test(kind)) {
                        throw Object.assign(new Error('Registered effect kind is invalid'), {
                            code: 'TASK_EFFECT_KIND_INVALID',
                        });
                    }
                    if (idempotencyKey.length < 1 || idempotencyKey.length > 512 || /[\r\n\0]/.test(idempotencyKey)) {
                        throw Object.assign(new Error('Registered effect idempotency key is invalid'), {
                            code: 'TASK_EFFECT_IDEMPOTENCY_KEY_INVALID',
                        });
                    }
                    const operation = input.operation?.trim() || `${kind}.run`;
                    if (operation.length > 128 || /[\r\n\0]/.test(operation)) {
                        throw Object.assign(new Error('Registered effect operation is invalid'), {
                            code: 'TASK_EFFECT_OPERATION_INVALID',
                        });
                    }
                    const effectKind = `agent.external.${kind}`;
                    const registration = await registerTaskEffect({
                        session: this.deps.sessionManager,
                        tenantId,
                        taskId: sessionId,
                        agentId,
                        effectKind,
                        operation: `external.${operation}.register`,
                        mutate: ({ snapshot }) => ({ snapshot, value: undefined }),
                    });
                    return this.deps.runOwnedEffect!(
                        ({ signal }) => execute({ signal, idempotencyKey }),
                        {
                            kind: effectKind,
                            label: `external effect ${kind}`,
                            tenantId,
                            taskId: sessionId,
                            agentId,
                            source: 'ApiBinder.effects.run',
                            rootTaskId: registration.lifecycle.rootTaskId,
                            ancestorTaskIds: registration.lifecycle.ancestorTaskIds,
                        }
                    );
                },
            };
        }

        const allowRootTargets = PluginManager.findAgent(agentId)?.resolved.runtimeManifest
            .orchestration?.rootTaskSubmission?.allowAgents ?? [];
        if (allowRootTargets.length > 0) {
            if (!this.deps.submitRootTask) {
                const error = new Error(`Root task submission is unavailable for ${agentId}`);
                error.name = 'ROOT_TASK_SUBMISSION_UNAVAILABLE';
                throw error;
            }
            ctx.tasks = {
                submit: async (targetAgentId, input, options) => {
                    if (!allowRootTargets.includes(targetAgentId)) {
                        const error = new Error(`Agent ${agentId} may not submit root tasks to ${targetAgentId}`);
                        error.name = 'ROOT_TASK_SUBMISSION_TARGET_NOT_ALLOWED';
                        throw error;
                    }
                    return this.deps.submitRootTask!({
                        tenantId,
                        sourceTaskId: sessionId,
                        sourceAgentId: agentId,
                        targetAgentId,
                        input,
                        options,
                    });
                },
            };
        } else {
            delete ctx.tasks;
        }

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
            (ctx as any).__autoExecuteTool = async (
                tId: string,
                sId: string,
                token: string,
                toolName: string,
                args: unknown,
                control?: { signal?: AbortSignal }
            ) => {
                try {
                    let result: unknown;
                    if (toolName.startsWith('mcp:')) {
                        const parts = toolName.slice(4).split('.');
                        if (parts.length >= 2) {
                            const serverName = parts[0];
                            const mcpToolName = parts.slice(1).join('.');
                            if (typeof (ctx as any).llm?.callMcpTool === 'function') {
                                result = await (ctx as any).llm.callMcpTool(
                                    serverName,
                                    mcpToolName,
                                    args as any,
                                    { signal: control?.signal }
                                );
                            } else {
                                throw new Error(`MCP execution not supported by current LLM adapter for tool: ${toolName}`);
                            }
                        } else {
                            throw new Error(`Invalid MCP tool name format: ${toolName}. Expected mcp:server.tool`);
                        }
                    } else {
                        result = await ctx.tools.invoke(toolName, args, { signal: control?.signal } as any);
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
            (ctx as any).artifacts = createArtifactFactory({
                tenantId,
                resolveCache: () => {
                    const prisma = this.deps.getSessionStorePrisma();
                    return prisma ? new AgentResultCache(prisma) : undefined;
                },
                onFailure: ({ operation, error, artifactId }) => {
                    log.error('Artifact factory operation failed', {
                        operation,
                        tenantId,
                        taskId: sessionId,
                        agentId,
                        artifactId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                },
            });
        }
        assertArtifactsFactory((ctx as any).artifacts);

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
            opts?: {
                ttlMs?: number;
                schema?: unknown;
                onProvided?: string;
                onExpired?: string;
                __existingToken?: string;
                setToken?: boolean;
                setStage?: string;
                planId?: string;
                stepId?: string;
                advanceCursor?: boolean;
            }
        ) => {
            const promptOrPartsStrict = promptOrParts as string | string[] | any | any[];
            if (!this.deps.sessionManager) throw new Error('Session manager not configured');
            const token = opts?.__existingToken || uuidv7();
            const controlUpdates: Array<[string, unknown]> = [];
            const expiresAt = opts?.ttlMs ? new Date(Date.now() + opts.ttlMs).toISOString() : undefined;

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

            const maxPrompts = 100;

            if (opts?.setToken !== false) {
                controlUpdates.push(['token', token]);
            }

            if (opts?.setStage) {
                const stagePath = 'stage';
                controlUpdates.push([stagePath, opts.setStage]);
            }

            if (!this.deps.snapshotRepo) throw new Error('SnapshotRepo not initialized');
            await ApiBinder.assertEffectActive(this.deps, {
                session: this.deps.sessionManager,
                tenantId,
                taskId: sessionId,
                effectKind: expiresAt !== undefined ? 'timer' : 'input',
            });
            try { await flushMentalState(); } catch { /* best-effort */ }
            await registerTaskEffect({
                session: this.deps.sessionManager,
                tenantId,
                taskId: sessionId,
                agentId: (ctx as any).agentId || 'default',
                effectKind: expiresAt !== undefined ? 'timer' : 'input',
                operation: 'input.register',
                mutate: ({ snapshot }) => {
                    const pending = { ...getPendingInputs(snapshot) };
                    if (!opts?.__existingToken && Object.keys(pending).length >= maxPrompts) {
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
                            expiredHandlerName: opts?.onExpired,
                            ...pickPlanStepStamp(opts),
                        } as any;
                    }
                    let nextSnapshot = setPendingInputs(snapshot, pending);
                    if (controlUpdates.length > 0) {
                        for (const [path, value] of controlUpdates) {
                            nextSnapshot = TaskStateUtils.applyControlVarToSnapshot(nextSnapshot, path, value);
                        }
                    }
                    return { snapshot: nextSnapshot, value: undefined };
                }
            });

            if (opts?.setToken !== false) writeControlVar(ctx, 'token', token);
            if (opts?.setStage) writeControlVar(ctx, 'stage', opts.setStage);
            try { await ctx.reply(parts as any); } catch { /* best-effort */ }

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
                const registration = await registerTaskEffect({
                    session: this.deps.sessionManager,
                    tenantId,
                    taskId: sessionId,
                    agentId: (ctx as any).agentId || 'default',
                    effectKind: 'tool.inline',
                    operation: 'tool.inline.register',
                    mutate: ({ snapshot }) => ({ snapshot, value: undefined }),
                });
                const invoke = async (signal?: AbortSignal) => {
                    if (typeof toolName === 'string' && toolName.startsWith('mcp:')) {
                        const parts = toolName.slice(4).split('.');
                        if (parts.length < 2) {
                            throw new Error(`Invalid MCP tool name format: ${toolName}. Expected mcp:server.tool`);
                        }
                        const serverName = parts[0];
                        const mcpToolName = parts.slice(1).join('.');
                        if (typeof (ctx as any).llm?.callMcpTool !== 'function') {
                            throw new Error(`MCP execution not supported by current LLM adapter for tool: ${toolName}`);
                        }
                        return signal === undefined
                            ? (ctx as any).llm.callMcpTool(serverName, mcpToolName, args as any)
                            : (ctx as any).llm.callMcpTool(serverName, mcpToolName, args as any, { signal });
                    }
                    return signal === undefined
                        ? (ctx as any).tools.invoke(toolName, args)
                        : (ctx as any).tools.invoke(toolName, args, { signal } as any);
                };
                return this.deps.runOwnedEffect
                    ? this.deps.runOwnedEffect(({ signal }) => invoke(signal), {
                          kind: 'tool.inline',
                          label: `tool.inline ${toolName}`,
                          tenantId,
                          taskId: sessionId,
                          agentId,
                          toolName,
                          source: 'ApiBinder.requestTool',
                          rootTaskId: registration.lifecycle.rootTaskId,
                          ancestorTaskIds: registration.lifecycle.ancestorTaskIds,
                      })
                    : invoke();
            }
            // Async tool request path: enqueue and let background handler execute
            if (!this.deps.sessionManager) throw new Error('Session manager not configured');
            let toolToken = opts?.setToken && typeof opts.setToken === 'string' ? opts.setToken : `tool-${uuidv7()}`;
            const effectIdempotencyKey = segmentEffectIdempotencyKey('tool', toolToken);
            await ApiBinder.assertEffectActive(this.deps, {
                session: this.deps.sessionManager,
                tenantId,
                taskId: sessionId,
                effectKind: 'tool',
            });
            try { await flushMentalState(); } catch { /* best-effort */ }

            // Use saveWithRetry to avoid CAS_MISMATCH after flushMentalState bumps version
            const registration = await registerTaskEffect({
                session: this.deps.sessionManager,
                tenantId,
                taskId: sessionId,
                agentId: (ctx as any).agentId || 'default',
                effectKind: 'tool',
                operation: 'tool.dispatch.register',
                mutate: ({ snapshot: lifecycleBase, lifecycle }) => {
                    const toolsNow = { ...getPendingTools(lifecycleBase) } as any;
                    toolsNow[toolToken] = {
                        name: toolName,
                        args,
                        handlers: { completed: opts?.onCompleted },
                        ownerTaskId: sessionId,
                        rootTaskId: lifecycle.rootTaskId,
                        ancestorTaskIds: lifecycle.ancestorTaskIds,
                        ...(effectIdempotencyKey !== undefined ? { idempotencyKey: effectIdempotencyKey } : {}),
                        ...pickPlanStepStamp(opts),
                    };
                    if (opts?.setToken || opts?.setStage) {
                        toolsNow[toolToken].options = { setToken: opts.setToken, setStage: opts.setStage };
                    }
                    return {
                        snapshot: setPendingTools(lifecycleBase, toolsNow),
                        value: undefined,
                    };
                }
            });
            const toolRequestedPayload = {
                token: toolToken,
                toolName,
                argsPreview: makeSafeEventPreview(args),
                ...(effectIdempotencyKey !== undefined ? { idempotencyKey: effectIdempotencyKey } : {}),
            };
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
                const toolPromise = this.deps.runOwnedEffect
                    ? this.deps.runOwnedEffect(
                          ({ signal }) => (ctx as any).__autoExecuteTool(
                              tenantId,
                              sessionId,
                              toolToken,
                              toolName,
                              args,
                              { signal }
                          ),
                          {
                              kind: 'tool.auto_execute',
                              label: `tool.auto_execute ${toolName}`,
                              tenantId,
                              taskId: sessionId,
                              agentId,
                              token: toolToken,
                              toolName,
                              source: 'ApiBinder.requestTool',
                              rootTaskId: registration.lifecycle.rootTaskId,
                              ancestorTaskIds: registration.lifecycle.ancestorTaskIds,
                              pendingKind: 'tools',
                          }
                      )
                    : (ctx as any).__autoExecuteTool(
                          tenantId,
                          sessionId,
                          toolToken,
                          toolName,
                          args
                      );
                void toolPromise.catch((e: Error) => {
                    if (e.name === 'AbortError' || (e as { code?: string }).code === 'TASK_LIFECYCLE_TERMINAL') {
                        log.debug('[ApiBinder] Detached background tool execution aborted', {
                            token: toolToken,
                            toolName,
                        });
                    } else {
                        log.error('[ApiBinder] Background tool execution failed', { token: toolToken, toolName, error: e.message });
                    }
                });
                if (!this.deps.runOwnedEffect && this.deps.trackBackgroundTask) {
                    this.deps.trackBackgroundTask(toolPromise, {
                        kind: 'tool.auto_execute',
                        label: `tool.auto_execute ${toolName}`,
                        tenantId,
                        taskId: sessionId,
                        agentId,
                        token: toolToken,
                        toolName,
                        source: 'ApiBinder.requestTool',
                        rootTaskId: registration.lifecycle.rootTaskId,
                        ancestorTaskIds: registration.lifecycle.ancestorTaskIds,
                    });
                } else if (!this.deps.runOwnedEffect) {
                    const trackedToolPromise = toolPromise.finally(() => {
                        this.deps.backgroundTaskPromises.delete(trackedToolPromise);
                    });
                    this.deps.backgroundTaskPromises.add(trackedToolPromise);
                }
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

            await ApiBinder.assertEffectActive(this.deps, {
                session: this.deps.sessionManager,
                tenantId,
                taskId: sessionId,
                effectKind: 'child.group',
            });

            if (typeof (ctx as any).flushSnapshot === 'function') {
                try {
                    log.debug('allTasks pre-flushing snapshot');
                    await (ctx as any).flushSnapshot({ M: (ctx as any).M, env: (ctx as any).env });
                } catch (e) { log.warn('allTasks pre-flush failed', { error: e }); }
            }

            const groupToken = uuidv7();
            const descriptors = children.map((child) => ({
                ...child,
                token: uuidv7(),
                childTaskId: buildA2AChildTaskId(sessionId, child.agent),
            }));
            childTokens.push(...descriptors.map(({ token }) => token));
            const registration = await registerTaskEffect({
                session: this.deps.sessionManager,
                tenantId,
                taskId: sessionId,
                agentId,
                effectKind: 'child.group',
                operation: 'child.group.register',
                mutate: ({ snapshot, lifecycle }) => {
                    const tasks = getPendingTasks(snapshot);
                    for (const child of descriptors) {
                        tasks[child.token] = {
                            target: child.agent,
                            input: child.input,
                            agentId: child.agent,
                            childTaskId: child.childTaskId,
                            handlers: {},
                            options: { setToken: false, autoClearToken: true },
                        };
                    }
                    const groups = getPendingGroups(snapshot);
                    groups[groupToken] = {
                        childTokens,
                        results: {},
                        handlers: {
                            ...(opts?.onAllCompleted ? { allCompleted: opts.onAllCompleted } : {}),
                            ...(opts?.onAnyFailed ? { anyFailed: opts.onAnyFailed } : {}),
                        },
                        ...(opts?.withTimeoutMs ? { timeoutMs: opts.withTimeoutMs } : {}),
                        ...(opts?.cancelRemaining !== undefined ? { cancelRemaining: opts.cancelRemaining } : {}),
                    };
                    return {
                        snapshot: setPendingGroups(setPendingTasks(snapshot, tasks), groups),
                        value: lifecycle,
                    };
                },
            });

            for (const child of descriptors) {
                await reconcileSnapshotMutation({
                    session: this.deps.sessionManager,
                    tenantId,
                    sessionId: child.childTaskId,
                    agentId: child.agent,
                    operation: 'child.group.link_parent',
                    mutate: ({ snapshot }) => ({
                        kind: 'write',
                        value: undefined,
                        snapshot: ensureTaskLifecycle({
                            ...snapshot,
                            meta: {
                                ...((snapshot.meta as Record<string, unknown> | undefined) ?? {}),
                                agentId: child.agent,
                                a2aParent: {
                                    parentTenantId: tenantId,
                                    parentTaskId: sessionId,
                                    parentChildToken: child.token,
                                },
                            },
                        }, {
                            taskId: child.childTaskId,
                            rootTaskId: registration.lifecycle.rootTaskId,
                            parentTaskId: sessionId,
                            ancestorTaskIds: [...registration.lifecycle.ancestorTaskIds, sessionId],
                        }),
                    }),
                });
            }
            for (const child of descriptors) {
                await ApiBinder.assertEffectActive(this.deps, {
                    session: this.deps.sessionManager,
                    tenantId,
                    taskId: sessionId,
                    effectKind: 'child.group',
                    token: child.token,
                    pendingKind: 'tasks',
                });
            }

            for (const child of descriptors) {
                const { token, childTaskId } = child;

                const parentId = ctx.telemetry?.nodeId ?? 'root';
                const parentNode = telemetry.getNode(parentId);
                const traceIdForChild = parentNode?.traceId;
                const childCallNode = new ChildCallNode(token, parentId, child.agent, undefined, traceIdForChild);
                childCallNode.start({ token, agentId: child.agent });
                telemetry.registerNode(childCallNode);

                const runChild = () => globalA2AService.sendTaskToAgent(ctx as any, child.agent, child.input as any, {
                        tenantId,
                        parentTenantId: tenantId,
                        parentTaskId: sessionId,
                        parentChildToken: token,
                        childTaskId,
                        awaitCompletion: false,
                        skipFlush: true,
                        parentTelemetryNodeId: childCallNode.id,
                    } as any);
                const taskPromise = (this.deps.runOwnedEffect
                    ? this.deps.runOwnedEffect(() => runChild(), {
                          kind: 'agent.child_dispatch',
                          label: `agent.child_dispatch ${child.agent}`,
                          tenantId,
                          taskId: childTaskId,
                          agentId: child.agent,
                          token,
                          childAgent: child.agent,
                          childTaskId,
                          source: 'ApiBinder.allTasks',
                          rootTaskId: registration.lifecycle.rootTaskId,
                          ancestorTaskIds: [...registration.lifecycle.ancestorTaskIds, sessionId],
                      })
                    : runChild())
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
                    });
                if (!this.deps.runOwnedEffect && this.deps.trackBackgroundTask) {
                    this.deps.trackBackgroundTask(taskPromise, {
                        kind: 'agent.child_dispatch',
                        label: `agent.child_dispatch ${child.agent}`,
                        tenantId,
                        taskId: childTaskId,
                        agentId: child.agent,
                        token,
                        childAgent: child.agent,
                        source: 'ApiBinder.allTasks',
                    });
                } else if (!this.deps.runOwnedEffect) {
                    const trackedTaskPromise = taskPromise.finally(() => {
                        this.deps.backgroundTaskPromises.delete(trackedTaskPromise as Promise<void>);
                    });
                    this.deps.backgroundTaskPromises.add(trackedTaskPromise as Promise<void>);
                }
            }
            return new GroupHandle(this.deps.sessionManager, tenantId, sessionId, groupToken);
        };
    }
}
