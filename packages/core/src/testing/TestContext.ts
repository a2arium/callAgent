import type { TaskContext, TaskHandle, InputHandle, GroupHandle } from '../shared/types/index.js';
import type {
    EpisodicEvent,
    GoalId,
    GoalNode,
    TaskContextGoalAddInput,
    TaskContextGoalUpdatePatch,
    TaskContextGoalsReadFilter,
} from '../loop/types.js';
import type { InternalTaskContext } from '../loop/internalContext.js';
import type { IMemory } from '@a2arium/callagent-types';
import type { InvariantErrorCode, InvariantErrorDetail, InvariantErrorContext } from '../types/invariantError.js';
import { InvariantError } from '../utils/errors.js';
import type { DeterministicLLMStub, DeterministicToolStub } from './DeterministicStubs.js';
import type { HarnessState } from './harnessTypes.js';
import type { Observation } from '../types/observation.js';
import { normalizeObservationInbox } from '../loop/types.js';
import { InMemorySessionManager } from '../orchestration/InMemorySessionManager.js';
import { SessionManager } from '../orchestration/SessionManager.js';
import { ConversationService } from '../internal/conversation/ConversationService.js';
import { createTopicSelectorPolicyRegistry } from '../internal/conversation/TopicSelectorPolicyRegistry.js';
import { createStopPolicyRegistry } from '../internal/conversation/StopPolicyRegistry.js';
import { createDbMessageLog } from '../eventbus/dbMessageLog.js';
import { createBusEvent } from '../eventbus/busEventHelpers.js';
import { v7 as uuidv7 } from 'uuid';
import { wrapStopPolicyRegistry, wrapTopicSelectorPolicyRegistry } from './policyPurityHarness.js';
import type { Clock } from '../internal/conversation/Clock.js';
import type {
    ArchiveConversationOptions,
    CloseConversationOptions,
    ConversationRef,
    FanoutSendReceipt,
    OutboundThreadMessage,
    OutboundTopicMessage,
    SendOptions,
    StartThreadOptions,
    ThreadRef,
    TopicCreateOptions,
    TopicInviteOptions,
    TopicJoinOptions,
    TopicDeclineOptions,
    TopicLeaveOptions,
    TopicPostOptions,
    TopicRef,
} from '../public-types/conversation/types.js';
import { MemberIdSchema } from '../public-types/conversation/schemas.js';
import { stampTopicPostTurnTrace } from '../orchestration/api/topicTurnTraceStamp.js';
import { mergePlanStepStamp, pickPlanStepStamp } from '../plans/planStepCorrelation.js';

function observationDedupeKey(obs: Observation): string {
    if (obs.source === 'conversation' && obs.kind === 'message.received') {
        const p = obs.payload as { kind?: string; message?: { id?: string } };
        if (p?.kind === 'message.received' && p.message?.id) {
            return `conversation:message.received:${p.message.id}`;
        }
    }
    if (obs.source === 'user' && obs.kind === 'input.provided') {
        const token = (obs.payload as { token?: string }).token;
        return `user:input.provided:${token ?? ''}`;
    }
    return `${obs.source}:${obs.kind}:${JSON.stringify(obs.payload)}`;
}

const ensurePendingBag = (
    state: HarnessState,
    slot: 'tools' | 'children' | 'inputs'
): Record<string, unknown> => {
    if (!state.env.pending || typeof state.env.pending !== 'object') {
        state.env.pending = { inputs: {}, children: {}, tools: {}, groups: {} };
    }
    const bag = state.env.pending[slot];
    if (!bag || typeof bag !== 'object') {
        state.env.pending[slot] = {};
    }
    return state.env.pending[slot] as Record<string, unknown>;
};

export type CreateTestContextOptions = {
    policyPurityStrict?: boolean;
};

export function createTestContext(
    state: HarnessState,
    llmStub: DeterministicLLMStub,
    toolStub: DeterministicToolStub,
    options?: CreateTestContextOptions
): TaskContext {
    const policyPurityStrict = options?.policyPurityStrict !== false;
    let taskCounter = 0;
    const generateId = (prefix: string) => `${prefix}-${++taskCounter}`;

    const memoryStub: Partial<IMemory> = {
        semantic: {
            add: async () => {},
            read: async () => [],
            remove: async () => {},
        } as unknown as IMemory['semantic'],
        episodic: {
            add: async () => {},
            read: async () => [],
        } as unknown as IMemory['episodic'],
    };

    const tenantId = 'test-tenant';
    const harnessSessionId = state.env.sessionId ?? 'test-session';
    state.env.sessionId = harnessSessionId;
    const harnessAgentId = 'test-agent';
    const conversationStore = new InMemorySessionManager();
    const conversationSessionManager = new SessionManager(conversationStore);
    const inviteHarnessClock: Clock = {
        now: () =>
            state.inviteClockNowMs != null && !Number.isNaN(state.inviteClockNowMs)
                ? new Date(state.inviteClockNowMs)
                : new Date(),
    };
    state.conversationTenantId = tenantId;
    state.conversationSessionManager = conversationSessionManager;
    state.inviteClock = inviteHarnessClock;
    const topicSelectorPolicyRegistry = wrapTopicSelectorPolicyRegistry(
        createTopicSelectorPolicyRegistry(),
        policyPurityStrict
    );
    const stopPolicyRegistry = wrapStopPolicyRegistry(createStopPolicyRegistry(), policyPurityStrict);
    state.harnessTopicSelectorPolicyRegistry = topicSelectorPolicyRegistry;
    state.harnessStopPolicyRegistry = stopPolicyRegistry;
    const defaultMessageLog = createDbMessageLog(conversationSessionManager);
    const conversationService = new ConversationService(conversationSessionManager, {
        routeTargetForThread: ({ threadId, recipientAgentId }) => ({
            tenantId,
            sessionId: `${threadId}:${recipientAgentId}`,
            agentId: recipientAgentId,
        }),
        activateConversationRecipient: async () => ({ ok: true }),
        clock: inviteHarnessClock,
        get messageLog() {
            return state.harnessMessageLogOverride ?? defaultMessageLog;
        },
        publishConversationEvent: async (channel, event) => {
            const bus = state.harnessEventBus;
            if (bus) {
                await bus.publish(
                    createBusEvent({
                        channel,
                        cloud: {
                            id: uuidv7(),
                            type: channel,
                            source: '/conversation/events',
                            time: new Date().toISOString(),
                            datacontenttype: 'application/json',
                            data: event,
                        },
                    })
                );
            }
        },
        resolveThreadTtlMs: (_agentId: string) => {
            const raw = state.harnessCommunication?.threadTtlMs;
            if (raw === null) {
                return null;
            }
            if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
                return raw;
            }
            return null;
        },
        topicSelectorPolicyRegistry,
        stopPolicyRegistry,
    });

    state.pullPersistedConversationObservations = async () => {
        const loaded = await conversationSessionManager.load(tenantId, harnessSessionId);
        const snap = (loaded?.snapshot as { inbox?: unknown } | undefined)?.inbox;
        const fromSnap = normalizeObservationInbox(snap ?? { current: [], all: [] });
        const existing = new Set(state.env.inbox.all.map(observationDedupeKey));
        for (const obs of fromSnap.current) {
            const k = observationDedupeKey(obs);
            if (!existing.has(k)) {
                existing.add(k);
                state.env.inbox.current.push(obs);
                state.env.inbox.all.push(obs);
            }
        }
    };

    state.seedConversationThread = async (params: {
        conversationId: string;
        ownerAgentId: string;
        participantAgentId: string;
    }) => {
        await conversationSessionManager.createConversationThread({
            tenantId,
            conversationId: params.conversationId,
            ownerAgentId: params.ownerAgentId,
            participantAgentId: params.participantAgentId,
        });
    };

    const ctx: TaskContext = {
        get M() { return state.m; },
        set M(val) { state.m = val as typeof state.m; },
        tenantId,
        agentId: harnessAgentId,
        task: {
            id: 'test-task-1',
            input: {}
        },
        
        reply: async (parts) => {
            state.replies.push(parts);
        },
        progress: Object.assign(
            (pct: number, msg?: string) => {},
            (status: any) => {}
        ),
        complete: (pct?: number, status?: string) => {},
        fail: async (error: unknown) => {
            state.errors.push(error instanceof Error ? error : new Error(String(error)));
        },

        recordUsage: (cost) => {},
        getUsage: () => ({ totalCost: 0, byKind: {} }),

        telemetry: {
            nodeId: 'test-node-1',
            traceId: 'test-trace-1'
        },

        llm: Object.assign(llmStub, {
            exportState: () => ({}),
            importState: (st: unknown) => {}
        }),

        artifacts: {
            create: <T>(val?: T, options?: { mimeType?: string; preview?: string }) => ({
                id: generateId('art'),
                type: 'artifact',
                mimeType: options?.mimeType || 'application/json',
                preview: options?.preview || '',
                length: 0,
                uri: `memory://artifact/${generateId('uri')}`
            } as unknown as import('@a2arium/callagent-memory-engine').Artifact<T>),
            text: (val?: string) => ({
                id: generateId('art-text'),
                type: 'artifact',
                mimeType: 'text/plain',
                preview: val?.substring(0, 100) || '',
                length: val?.length || 0,
                uri: `memory://artifact/${generateId('uri')}`
            } as unknown as import('@a2arium/callagent-memory-engine').Artifact<string>),
            json: <T>(val?: T) => ({
                id: generateId('art-json'),
                type: 'artifact',
                mimeType: 'application/json',
                preview: '',
                length: 0,
                uri: `memory://artifact/${generateId('uri')}`
            } as unknown as import('@a2arium/callagent-memory-engine').Artifact<T>)
        },

        goals: {
            add: (_g: TaskContextGoalAddInput) => generateId('goal'),
            update: (_id: GoalId, _patch: TaskContextGoalUpdatePatch) => {},
            remove: (_id: GoalId) => {},
            clear: (_predicate?: (g: GoalNode) => boolean) => {},
            read: (_filter?: TaskContextGoalsReadFilter) => [],
        },
        episodic: { add: (_e: EpisodicEvent) => {} },
        thoughts: { add: (t) => {} },
        world: { read: () => ({}) },
        decisions: {
            add: async (key, value, reasoning) => {},
            get: async (key) => null,
            read: async (filter) => []
        },

        recall: async (query, options) => [],
        remember: async (key, value, options) => {},

        tools: {
            invoke: async <T>(toolName: string, args: unknown, options?: { onCompleted?: string; setToken?: boolean; setStage?: string }) => {
                return toolStub.invoke<T>(toolName, args);
            }
        },

        memory: memoryStub as IMemory,

        cognitive: {
            loadWorkingMemory: (e) => {},
            plan: async (prompt, options) => ({}),
            record: (st) => {},
            flush: async () => {}
        },

        config: {},
        validate: (schema, data) => {},
        retry: async <T>(fn: () => Promise<T>, opts: unknown) => fn(),
        cache: {
            get: async <T>(key: string) => null as T | null,
            set: async <T>(key: string, value: T, ttl?: number) => {},
            delete: async (key: string) => {}
        },
        emitEvent: async (channel, payload) => {},
        updateStatus: (st) => {},
        services: { get: (name) => undefined },
        getEnv: (key, def) => def,

        throw: (code: InvariantErrorCode, message: string, detail: InvariantErrorDetail, context?: InvariantErrorContext) => {
            const payload = { code, message, detail, ...context };
            throw new InvariantError(payload);
        },

        sendTaskToAgent: ((targetAgent: string, taskInput: unknown, options?: { awaitCompletion?: boolean; planId?: string; stepId?: string; advanceCursor?: boolean }) => {
            state.childDispatches.push({ agent: targetAgent, input: taskInput });
            const token = generateId('child');
            const stamp = pickPlanStepStamp(options);
            const returnToken = options?.awaitCompletion === false || stamp.planId !== undefined;
            if (returnToken) {
                const children = ensurePendingBag(state, 'children');
                children[token] = mergePlanStepStamp(
                    { agent: targetAgent, input: taskInput },
                    stamp
                );
                return Promise.resolve({
                    id: generateId('task'),
                    get token() { return token; }
                } as unknown as TaskHandle);
            }
            return Promise.resolve({ status: 'completed', result: {} });
        }) as unknown as TaskContext['sendTaskToAgent'],

        requestInput: async (prompt, opts) => {
            const token = generateId('tok-in');
            ensurePendingBag(state, 'inputs')[token] = mergePlanStepStamp(
                { prompt },
                pickPlanStepStamp(opts)
            );
            return {
                id: generateId('input'),
                token
            } as unknown as InputHandle;
        },

        requestTool: async (toolName, args, opts) => {
            const token = generateId('tok-tool');
            ensurePendingBag(state, 'tools')[token] = mergePlanStepStamp(
                { name: toolName, args },
                pickPlanStepStamp(opts)
            );
            try {
                await toolStub.invoke(toolName, args);
            } catch {
                /* stub records the call even when unregistered */
            }
            return {
                id: generateId('req-tool'),
                token
            } as unknown as TaskHandle;
        },

        allTasks: async (children, opts) => ({
            id: generateId('group'),
            token: generateId('tok-grp'),
            wait: async () => ({ results: [] })
        } as unknown as GroupHandle),

        conversation: {
            startThread: async (options: StartThreadOptions) => {
                const receipt = await conversationService.startThread(tenantId, harnessSessionId, harnessAgentId, options);
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
                const receipt = await conversationService.send(tenantId, harnessSessionId, thread, message, options);
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
                conversationService.createTopic(tenantId, harnessSessionId, harnessAgentId, options),
            invite: (options: TopicInviteOptions) =>
                conversationService.invite(tenantId, harnessSessionId, harnessAgentId, options),
            join: (topic: TopicRef, options: TopicJoinOptions) =>
                conversationService.join(tenantId, harnessSessionId, harnessAgentId, topic, options),
            decline: (topic: TopicRef, options: TopicDeclineOptions) =>
                conversationService.decline(tenantId, harnessSessionId, harnessAgentId, topic, options),
            leave: (topic: TopicRef, options?: TopicLeaveOptions) =>
                conversationService.leave(tenantId, harnessSessionId, harnessAgentId, topic, options),
            post: async (topic: TopicRef, message: OutboundTopicMessage, options?: TopicPostOptions) => {
                const receipt: FanoutSendReceipt = await conversationService.post(
                    tenantId,
                    harnessSessionId,
                    harnessAgentId,
                    topic,
                    message,
                    options
                );
                stampTopicPostTurnTrace(ctx as InternalTaskContext, topic, options, receipt);
                return receipt;
            },
            close: async (ref: ConversationRef, options?: CloseConversationOptions) => {
                return conversationService.close(tenantId, harnessSessionId, harnessAgentId, ref, options);
            },
            archive: async (ref: ConversationRef, options?: ArchiveConversationOptions) => {
                return conversationService.archive(tenantId, harnessSessionId, harnessAgentId, ref, options);
            },
            readProjection: async (topic, token, options) =>
                conversationService.readProjection(tenantId, harnessSessionId, harnessAgentId, topic, token, options),
            appendSignal: async (topic, input, options) =>
                conversationService.appendSignal(tenantId, harnessSessionId, harnessAgentId, topic, input, options),
        },
    };

    (ctx as InternalTaskContext).controlVars = {};
    return ctx;
}
