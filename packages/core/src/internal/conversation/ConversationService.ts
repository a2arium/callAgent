import { v7 as uuidv7 } from 'uuid';
import type { ConversationMessageRecord } from '@a2arium/callagent-memory-engine';
import type { SessionManager } from '../../orchestration/SessionManager.js';
import type {
    InternalConversationApi,
    ConversationServiceDeps,
    ConversationActivateParams,
} from './types.js';
import type {
    ArchiveConversationOptions,
    ArchiveConversationReceipt,
    CloseConversationOptions,
    CloseConversationReceipt,
    ConversationError,
    FanoutSendReceipt,
    MemberId,
    OutboundThreadMessage,
    OutboundTopicMessage,
    SendOptions,
    SendReceipt,
    StartThreadOptions,
    StartThreadReceipt,
    ThreadRef,
    TopicCreateOptions,
    TopicCreateReceipt,
    TopicInviteOptions,
    TopicInviteReceipt,
    TopicJoinOptions,
    TopicJoinReceipt,
    TopicDeclineOptions,
    TopicDeclineReceipt,
    TopicLeaveOptions,
    TopicLeaveReceipt,
    TopicPostOptions,
    TopicRef,
    ConversationRef,
    TopicSelector,
    DeliverySummary,
} from '../../public-types/conversation/types.js';
import type { MessageLogDelivery } from '../../public-types/messageLog/types.js';
import type { Observation } from '../../types/observation.js';
import {
    RUNTIME_STREAM_EVENT_VERSION,
    RuntimeStreamEventSchema,
    type RuntimeStreamEvent,
} from '../../streaming/runtimeStreamEvents.js';
import {
    InviteTokenSchema,
    MAX_TOPIC_MEMBERS,
    MemberIdSchema,
    TopicStopPolicySchema,
    type TopicStopPolicyRule,
} from '../../public-types/conversation/schemas.js';
import { SignalKindSchema } from '../../public-types/conversation/signal.js';
import type { StopPolicyRegistry, TopicStopPolicyContext } from '../../public-types/conversation/stopPolicy.js';
import type { TopicMember } from '../../public-types/conversation/types.js';
import { ConversationRouter } from './ConversationRouter.js';
import { wallClock, type Clock } from './Clock.js';
import {
    resolveTopicSelector,
    topicSelectorFromRecord,
    topicSelectorToStorage,
    type TopicMemberRow,
} from './TopicSelector.js';
import { createTopicSelectorPolicyRegistry } from './TopicSelectorPolicyRegistry.js';
import type { TopicSelectorPolicyRegistry } from './TopicSelectorPolicyRegistry.js';
import { createStopPolicyRegistry } from './StopPolicyRegistry.js';
import { evaluateTopicStopPolicies } from './TopicStopPolicyEngine.js';
import { paramsHashFromJsonValue } from '../util/canonicalJson.js';
import {
    validateContentTypeAccepted,
    validateSpeechActAccepted,
    validateThreadable,
} from './CapabilityValidator.js';
import type { AppendSignalInput, ReadProjectionOptions } from '../../public-types/conversation/topicProjection.js';
import { getTopicProjectionRegistry } from './TopicProjectionRegistry.js';

function effectiveMemberId(m: TopicMember): string {
    return m.memberId !== undefined ? String(m.memberId) : m.agentId;
}
import { reconstructFanoutReceiptFromDeliveries } from './fanoutReplay.js';
import type { TopicPostBackpressureSample } from './BackpressureManager.js';

const MAX_QUEUE_DEPTH = 32;
const DEFAULT_INVITE_TTL_SECONDS = 60 * 60 * 24;

function errorToDeliveryPayload(err: unknown): Record<string, unknown> {
    if (err instanceof Error) {
        return {
            type: err.name || 'Error',
            message: err.message,
        };
    }
    return {
        type: 'Error',
        message: String(err),
    };
}

type QueueState = {
    byThread: Map<string, number>;
    byTopic: Map<string, number>;
};

function isPgUniqueViolation(err: unknown): boolean {
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '23505') {
        return true;
    }
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes('Unique constraint') || msg.includes('duplicate key') || msg.includes('unique constraint');
}

const BLOCKING_POLL_INTERVAL_MS = 20;

function isInflightSnapshot(snapshot: Record<string, unknown> | undefined): boolean {
    const pending = (snapshot as { pending?: Record<string, Record<string, unknown>> } | undefined)?.pending;
    if (!pending) {
        return false;
    }
    return (
        Boolean(pending.inputs && Object.keys(pending.inputs).length > 0) ||
        Boolean(pending.tools && Object.keys(pending.tools).length > 0) ||
        Boolean(pending.children && Object.keys(pending.children).length > 0)
    );
}

export class ConversationService implements InternalConversationApi {
    private readonly router: ConversationRouter;
    private readonly clock: Clock;
    private readonly topicSelectorPolicyRegistry: TopicSelectorPolicyRegistry;
    private readonly stopPolicyRegistry: StopPolicyRegistry;
    private readonly queueState: QueueState = {
        byThread: new Map(),
        byTopic: new Map(),
    };
    private topicPostBackpressureSink?: (sample: TopicPostBackpressureSample | undefined) => void;

    constructor(
        private readonly sessionManager: SessionManager,
        private readonly deps: ConversationServiceDeps
    ) {
        this.router = new ConversationRouter(sessionManager);
        this.clock = deps.clock ?? wallClock;
        this.topicSelectorPolicyRegistry =
            deps.topicSelectorPolicyRegistry ?? createTopicSelectorPolicyRegistry();
        this.stopPolicyRegistry = deps.stopPolicyRegistry ?? createStopPolicyRegistry();
    }

    setTopicPostBackpressureSink(
        sink: ((sample: TopicPostBackpressureSample | undefined) => void) | undefined
    ): void {
        this.topicPostBackpressureSink = sink;
    }

    private async publishConversationRuntimeEvent(params: {
        sessionId: string;
        tenantId: string;
        type: 'conversation.message.sent' | 'conversation.message.received';
        id: string;
        seq: number;
        ts: string;
        conversationId: string;
        conversationKind: 'thread' | 'topic';
        messageId: string;
        senderAgentId?: string;
        recipientAgentId?: string;
        speechAct?: string;
    }): Promise<void> {
        if (!this.deps.publishRuntimeEvent) return;

        const event: RuntimeStreamEvent = RuntimeStreamEventSchema.parse({
            version: RUNTIME_STREAM_EVENT_VERSION,
            id: params.id,
            seq: params.seq,
            taskId: params.sessionId,
            tenantId: params.tenantId,
            ts: params.ts,
            type: params.type,
            visibility: 'debug',
            channel: 'debug',
            data: {
                conversationId: params.conversationId,
                kind: params.conversationKind,
                messageId: params.messageId,
                ...(params.senderAgentId ? { senderAgentId: params.senderAgentId } : {}),
                ...(params.recipientAgentId ? { recipientAgentId: params.recipientAgentId } : {}),
                ...(params.speechAct ? { speechAct: params.speechAct } : {}),
                sequenceNumber: params.seq,
            },
        });

        await this.deps.publishRuntimeEvent({ sessionId: params.sessionId, event });
    }

    private scheduleConversationActivation(params: ConversationActivateParams): void {
        void this.deps.activateConversationRecipient(params).catch(() => {
            // Activation is best-effort after durable routing. The recipient session can be
            // reactivated later because the observation has already been persisted.
        });
    }

    private async runStopPoliciesAfterSuccessfulTopicAppend(params: {
        tenantId: string;
        senderSessionId: string;
        senderAgentId: string;
        topic: TopicRef;
    }): Promise<
        | undefined
        | { result: 'stop'; reason?: string }
        | { result: 'rejected'; error: ConversationError }
    > {
        const { tenantId, senderSessionId, senderAgentId, topic } = params;
        const topicRow = await this.sessionManager.getConversationTopic({
            tenantId,
            conversationId: topic.id,
        });
        if (!topicRow || topicRow.status !== 'open') {
            return undefined;
        }
        const rulesParsed = TopicStopPolicySchema.array().min(1).safeParse(topicRow.stopPolicies);
        if (!rulesParsed.success) {
            return undefined;
        }
        const members = await this.sessionManager.listConversationTopicMembers({
            tenantId,
            conversationId: topic.id,
            activeOnly: true,
        });
        const msgs = await this.sessionManager.listConversationMessages({
            tenantId,
            conversationId: topic.id,
        });
        if (msgs.length === 0) {
            return undefined;
        }
        const last = msgs[msgs.length - 1]!;
        const memberCount = members.length;
        const totalMessages = msgs.length;
        const totalRounds = Math.floor(totalMessages / Math.max(1, memberCount));
        const resolvedMembers = members.map((m) => ({
            agentId: m.agentId,
            memberId: MemberIdSchema.parse(m.memberId),
            role: m.role,
            sessionId: m.sessionId,
        }));
        const ctx: TopicStopPolicyContext = {
            tenantId,
            topicId: topic.id,
            topicCreatedAtIso: topicRow.createdAt,
            nowIso: this.clock.now().toISOString(),
            sequenceNumber: last.sequenceNumber,
            totalMessages,
            totalRounds,
            lastMessage: {
                senderMemberId: MemberIdSchema.parse(last.senderMemberId),
                speechAct: last.speechAct,
                sequenceNumber: last.sequenceNumber,
            },
            members: resolvedMembers,
        };
        const result = evaluateTopicStopPolicies({
            rules: rulesParsed.data,
            ctx,
            messages: msgs,
            registry: this.stopPolicyRegistry,
        });
        if (result.status === 'ok') {
            return undefined;
        }
        if (result.status === 'stop') {
            await this.close(tenantId, senderSessionId, senderAgentId, topic, {
                reason: result.reason,
            });
            return { result: 'stop', reason: result.reason };
        }
        const ts = this.clock.now().toISOString();
        const obs = {
            source: 'conversation',
            payload: {
                kind: 'topic.stopPolicy.rejected' as const,
                topic,
                ts,
                error: result.error,
            },
        } as Observation;
        await this.router.routeObservations(
            members.map((m) => ({
                tenantId,
                sessionId: m.sessionId,
                agentId: m.agentId,
                observation: obs,
            }))
        );
        return { result: 'rejected', error: result.error };
    }

    private isThreadReplyForBlocking(obs: unknown, params: { threadId: string; correlationId: string; recipientAgentId: string }): boolean {
        if (!obs || typeof obs !== 'object') {
            return false;
        }
        const o = obs as { source?: unknown; payload?: unknown };
        if (o.source !== 'conversation') {
            return false;
        }
        const payload = o.payload as { kind?: string; message?: Record<string, unknown> } | undefined;
        if (!payload || payload.kind !== 'message.received' || !payload.message) {
            return false;
        }
        const msg = payload.message;
        const conv = msg.conversation as { id?: string; kind?: string } | undefined;
        if (!conv || conv.kind !== 'thread' || conv.id !== params.threadId) {
            return false;
        }
        if (msg.correlationId !== params.correlationId) {
            return false;
        }
        if (msg.recipientAgentId !== params.recipientAgentId) {
            return false;
        }
        return true;
    }

    /**
     * Blocking mode: wait until the sender session observes an inbound thread `message.received`
     * addressed to the sender with a matching correlation id (typically the other party's reply).
     */
    private async waitForBlockingThreadReply(params: {
        tenantId: string;
        senderSessionId: string;
        senderAgentId: string;
        threadId: string;
        correlationId: string;
        deadlineMs: number;
    }): Promise<'ok' | 'timeout'> {
        while (this.clock.now().getTime() < params.deadlineMs) {
            const loaded = await this.sessionManager.load(params.tenantId, params.senderSessionId);
            const snap = (loaded?.snapshot as Record<string, unknown> | undefined) ?? {};
            const inbox = snap.inbox as { all?: unknown[] } | undefined;
            const all = Array.isArray(inbox?.all) ? inbox.all : [];
            for (const obs of all) {
                if (
                    this.isThreadReplyForBlocking(obs, {
                        threadId: params.threadId,
                        correlationId: params.correlationId,
                        recipientAgentId: params.senderAgentId,
                    })
                ) {
                    return 'ok';
                }
            }
            await new Promise<void>((r) => setTimeout(r, BLOCKING_POLL_INTERVAL_MS));
        }
        return 'timeout';
    }

    private async sessionInflight(tenantId: string, sessionId: string): Promise<boolean> {
        const loaded = await this.sessionManager.load(tenantId, sessionId);
        const base = (loaded?.snapshot as Record<string, unknown>) ?? {};
        return isInflightSnapshot(base);
    }

    private requiredTopicPolicyCapabilityIds(
        selector: TopicSelector,
        stopPolicies: readonly TopicStopPolicyRule[]
    ): string[] {
        const ids: string[] = [];
        if (selector.kind === 'selector_policy') {
            ids.push(`selector_policy:${selector.policyId}`);
        }
        for (const p of stopPolicies) {
            if (p.kind === 'custom') {
                ids.push(`stop_custom:${p.policyId}`);
            }
        }
        return ids;
    }

    private async emitTopicPolicyUnsupported(params: {
        tenantId: string;
        sessionId: string;
        agentId: string;
        topic: TopicRef;
        details: { agentId: string; missing: string[] }[];
    }): Promise<void> {
        if (params.details.length === 0) {
            return;
        }
        const obs = {
            source: 'conversation',
            payload: {
                kind: 'topic.policy.unsupported',
                topic: params.topic,
                ts: new Date().toISOString(),
                unsupported: params.details,
            },
        } as Observation;
        await this.router.routeObservation({
            tenantId: params.tenantId,
            sessionId: params.sessionId,
            agentId: params.agentId,
            observation: obs,
        });
    }

    private async resolveInviterSeat(
        tenantId: string,
        topicId: string,
        senderSessionId: string,
        senderAgentId: string
    ): Promise<{ memberId: string; sessionId: string } | null> {
        const seats = await this.sessionManager.listConversationTopicMembersByAgent({
            tenantId,
            conversationId: topicId,
            agentId: senderAgentId,
            activeOnly: true,
        });
        if (seats.length === 0) {
            return null;
        }
        const bySession = seats.find((s) => s.sessionId === senderSessionId);
        const chosen = bySession ?? seats[0];
        return { memberId: chosen.memberId, sessionId: chosen.sessionId };
    }

    async startThread(
        tenantId: string,
        senderSessionId: string,
        senderAgentId: string,
        options: StartThreadOptions
    ): Promise<StartThreadReceipt> {
        const awaitMode = options.awaitMode ?? 'deferred';
        if (awaitMode === 'blocking' && options.message.correlationId === undefined) {
            const threadId = options.conversationId ?? (`thread-${uuidv7()}` as ThreadRef['id']);
            const thread: ThreadRef = { kind: 'thread', id: threadId };
            return {
                thread,
                receipt: {
                    status: 'rejected',
                    thread,
                    error: {
                        type: 'Unsupported',
                        message: 'blocking startThread requires message.correlationId.',
                    },
                },
            };
        }
        const threadId = options.conversationId ?? (`thread-${uuidv7()}` as ThreadRef['id']);
        const thread: ThreadRef = { kind: 'thread', id: threadId };
        const targetComm = this.deps.resolveAgentCommunication?.(options.targetAgentId);
        const cap0 = validateThreadable(targetComm, options.targetAgentId);
        if (cap0) {
            return { thread, receipt: { status: 'rejected', thread, error: cap0 } };
        }
        const cap1 = validateSpeechActAccepted(targetComm, options.message.speechAct);
        if (cap1) {
            return { thread, receipt: { status: 'rejected', thread, error: cap1 } };
        }
        const cap2 = validateContentTypeAccepted(targetComm, options.message.content);
        if (cap2) {
            return { thread, receipt: { status: 'rejected', thread, error: cap2 } };
        }
        const ttlMs = this.deps.resolveThreadTtlMs
            ? this.deps.resolveThreadTtlMs(senderAgentId)
            : 3600000;
        const expiresAtIso =
            ttlMs == null
                ? null
                : new Date(this.clock.now().getTime() + ttlMs).toISOString();
        await this.sessionManager.createConversationThread({
            tenantId,
            conversationId: thread.id,
            ownerAgentId: senderAgentId,
            participantAgentId: options.targetAgentId,
            expiresAt: expiresAtIso,
        });

        const sendReceipt = await this.send(
            tenantId,
            senderSessionId,
            thread,
            {
                ...options.message,
                recipientAgentId: options.message.recipientAgentId ?? options.targetAgentId,
            },
            {
                idempotencyKey: options.idempotencyKey,
                queueMode: options.queueMode,
                skipRecipientActivation: options.skipRecipientActivation,
                awaitMode: options.awaitMode,
                timeoutMs: options.timeoutMs,
            }
        );
        const timedOut =
            awaitMode === 'blocking' &&
            sendReceipt.status === 'rejected' &&
            sendReceipt.error.type === 'ConversationTimeout';
        return { thread, receipt: sendReceipt, ...(timedOut ? { timedOut: true } : {}) };
    }

    async send(
        tenantId: string,
        senderSessionId: string,
        thread: ThreadRef,
        message: OutboundThreadMessage,
        options?: SendOptions
    ): Promise<SendReceipt> {
        const threadRecord = await this.sessionManager.getConversationThread({
            tenantId,
            conversationId: thread.id,
        });
        if (!threadRecord) {
            return {
                status: 'rejected',
                thread,
                error: { type: 'NotFound', message: 'Conversation thread not found.' },
            };
        }
        if (threadRecord.status !== 'open') {
            if (threadRecord.status === 'archived') {
                return {
                    status: 'rejected',
                    thread,
                    error: { type: 'ConversationClosed', message: 'Conversation thread is archived.' },
                };
            }
            if (threadRecord.closeReason === 'ttl') {
                return {
                    status: 'rejected',
                    thread,
                    error: { type: 'ThreadExpired', message: 'Conversation thread expired (TTL).' },
                };
            }
            return {
                status: 'rejected',
                thread,
                error: { type: 'ConversationClosed', message: 'Conversation thread is closed.' },
            };
        }

        const recipientComm = this.deps.resolveAgentCommunication?.(message.recipientAgentId);
        const rc0 = validateThreadable(recipientComm, message.recipientAgentId);
        if (rc0) {
            return { status: 'rejected', thread, error: rc0 };
        }
        const rc1 = validateSpeechActAccepted(recipientComm, message.speechAct);
        if (rc1) {
            return { status: 'rejected', thread, error: rc1 };
        }
        const rc2 = validateContentTypeAccepted(recipientComm, message.content);
        if (rc2) {
            return { status: 'rejected', thread, error: rc2 };
        }

        const dedupeKey = options?.idempotencyKey;
        if (dedupeKey) {
            const existing = await this.deps.messageLog.findByIdempotency({
                tenantId,
                conversationId: thread.id,
                senderMemberId: MemberIdSchema.parse(message.senderAgentId),
                idempotencyKey: dedupeKey,
            });
            if (existing) {
                return {
                    status: 'accepted',
                    thread,
                    messageId: existing.messageId,
                    sequenceNumber: existing.sequenceNumber,
                    dedupeHit: true,
                    correlationId: existing.correlationId,
                };
            }
        }

        if ((options?.awaitMode ?? 'deferred') === 'blocking' && message.correlationId === undefined) {
            return {
                status: 'rejected',
                thread,
                error: {
                    type: 'Unsupported',
                    message: 'blocking send requires message.correlationId.',
                },
            };
        }

        const target = this.deps.routeTargetForThread({
            tenantId,
            threadId: thread.id,
            recipientAgentId: message.recipientAgentId,
        });
        const targetSnapshot = await this.sessionManager.load(target.tenantId, target.sessionId);
        const pending = (targetSnapshot?.snapshot as { pending?: Record<string, Record<string, unknown>> } | undefined)?.pending;
        const isInflight =
            Boolean(pending?.inputs && Object.keys(pending.inputs).length > 0) ||
            Boolean(pending?.tools && Object.keys(pending.tools).length > 0) ||
            Boolean(pending?.children && Object.keys(pending.children).length > 0);

        const queueMode = options?.queueMode ?? 'reject';
        if (isInflight && queueMode === 'reject') {
            return {
                status: 'rejected',
                thread,
                error: { type: 'ThreadBusy', message: 'Recipient session is busy for this thread.' },
            };
        }
        if (isInflight && queueMode === 'queue') {
            const queued = this.queueState.byThread.get(thread.id) ?? 0;
            if (queued >= MAX_QUEUE_DEPTH) {
                return {
                    status: 'rejected',
                    thread,
                    error: { type: 'QueueFull', message: 'Thread queue is full.' },
                };
            }
            const nextPos = queued + 1;
            this.queueState.byThread.set(thread.id, nextPos);
            return {
                status: 'queued',
                thread,
                queuePosition: nextPos,
            };
        }

        const appendResult = await this.deps.messageLog.append({
            tenantId,
            conversationId: thread.id,
            conversationKind: 'thread',
            senderAgentId: message.senderAgentId,
            senderMemberId: MemberIdSchema.parse(message.senderAgentId),
            selectorKind: undefined,
            speechAct: message.speechAct,
            payload: { content: message.content },
            correlationId: message.correlationId,
            idempotencyKey: dedupeKey,
            deliveries: [
                {
                    recipientAgentId: message.recipientAgentId,
                    recipientMemberId: MemberIdSchema.parse(message.recipientAgentId),
                    sessionId: target.sessionId,
                    status: 'buffered',
                },
            ],
        });
        const dedupeHit = appendResult.kind === 'dedupeHit';
        const messageId = appendResult.messageId;
        const sequenceNumber = appendResult.sequenceNumber;
        const ttlMsAfter = this.deps.resolveThreadTtlMs
            ? this.deps.resolveThreadTtlMs(message.senderAgentId)
            : 3600000;
        let threadExpiresAtIso: string | undefined;
        if (ttlMsAfter != null && !dedupeHit) {
            threadExpiresAtIso = new Date(this.clock.now().getTime() + ttlMsAfter).toISOString();
            await this.sessionManager.refreshConversationThreadExpiry({
                tenantId,
                conversationId: thread.id,
                expiresAt: threadExpiresAtIso,
            });
        }

        const persistedRows = await this.sessionManager.listConversationMessages({
            tenantId,
            conversationId: thread.id,
        });
        const persisted = persistedRows.find((r) => r.sequenceNumber === sequenceNumber);
        const content =
            persisted?.payload &&
            typeof persisted.payload === 'object' &&
            persisted.payload !== null &&
            'content' in persisted.payload
                ? (persisted.payload as { content: unknown }).content
                : message.content;
        const observation = {
            source: 'conversation',
            payload: {
                kind: 'message.received',
                message: {
                    id: messageId,
                    conversation: thread,
                    senderAgentId: message.senderAgentId,
                    senderMemberId: MemberIdSchema.parse(message.senderAgentId),
                    recipientAgentId: message.recipientAgentId,
                    recipientMemberId: MemberIdSchema.parse(message.recipientAgentId),
                    speechAct: message.speechAct,
                    content,
                    sequenceNumber,
                    correlationId: persisted?.correlationId ?? message.correlationId,
                    idempotencyKey: persisted?.idempotencyKey ?? dedupeKey,
                    ts: appendResult.createdAt,
                },
            },
        } as Observation;
        try {
            await this.router.routeObservation({
                tenantId: target.tenantId,
                sessionId: target.sessionId,
                agentId: target.agentId,
                observation,
            });
            await this.sessionManager.updateConversationMessageDelivery({
                tenantId,
                conversationId: thread.id,
                sequenceNumber,
                memberId: message.recipientAgentId,
                status: 'delivered',
                error: null,
                queuePosition: null,
            });
            await this.publishConversationRuntimeEvent({
                sessionId: target.sessionId,
                tenantId,
                type: 'conversation.message.received',
                id: `${messageId}:received:${target.sessionId}`,
                seq: sequenceNumber,
                ts: appendResult.createdAt,
                conversationId: thread.id,
                conversationKind: 'thread',
                messageId,
                senderAgentId: message.senderAgentId,
                recipientAgentId: message.recipientAgentId,
                speechAct: message.speechAct,
            });
        } catch (err) {
            await this.sessionManager.updateConversationMessageDelivery({
                tenantId,
                conversationId: thread.id,
                sequenceNumber,
                memberId: message.recipientAgentId,
                status: 'dead-lettered',
                error: errorToDeliveryPayload(err),
            });
            throw err;
        }

        const outboundCommitted = {
            source: 'conversation',
            payload: {
                kind: 'outbound.committed' as const,
                ref: thread,
                messageId,
                sequenceNumber,
                correlationId: persisted?.correlationId ?? message.correlationId,
                ...(threadExpiresAtIso !== undefined ? { threadExpiresAt: threadExpiresAtIso } : {}),
                deliveries: [
                    {
                        memberId: MemberIdSchema.parse(message.recipientAgentId),
                        recipientAgentId: message.recipientAgentId,
                        sessionId: target.sessionId,
                        messageId,
                        sequenceNumber,
                        dedupeHit,
                        correlationId: persisted?.correlationId ?? message.correlationId,
                    },
                ],
            },
        } as Observation;
        await this.router.routeObservation({
            tenantId,
            sessionId: senderSessionId,
            agentId: message.senderAgentId,
            observation: outboundCommitted,
        });
        await this.publishConversationRuntimeEvent({
            sessionId: senderSessionId,
            tenantId,
            type: 'conversation.message.sent',
            id: `${messageId}:sent:${senderSessionId}`,
            seq: sequenceNumber,
            ts: appendResult.createdAt,
            conversationId: thread.id,
            conversationKind: 'thread',
            messageId,
            senderAgentId: message.senderAgentId,
            recipientAgentId: message.recipientAgentId,
            speechAct: message.speechAct,
        });

        const skipActivation = options?.skipRecipientActivation === true;
        if (!skipActivation) {
            const activateParams: ConversationActivateParams = {
                kind: 'thread',
                tenantId,
                threadId: thread.id,
                routingSessionId: target.sessionId,
                recipientAgentId: message.recipientAgentId,
                messageId,
                senderSessionId,
                senderAgentId: message.senderAgentId,
            };
            await this.deps.activateConversationRecipient(activateParams);
        }

        const awaitMode = options?.awaitMode ?? 'deferred';
        if (awaitMode === 'blocking' && message.correlationId !== undefined) {
            const timeoutMs = options?.timeoutMs;
            const deadline =
                timeoutMs != null && timeoutMs > 0
                    ? this.clock.now().getTime() + timeoutMs
                    : Number.MAX_SAFE_INTEGER;
            const waitResult = await this.waitForBlockingThreadReply({
                tenantId,
                senderSessionId,
                senderAgentId: message.senderAgentId,
                threadId: thread.id,
                correlationId: message.correlationId,
                deadlineMs: deadline,
            });
            if (waitResult === 'timeout') {
                return {
                    status: 'rejected',
                    thread,
                    error: {
                        type: 'ConversationTimeout',
                        message: 'Timed out waiting for a correlated inbound message on the sender session.',
                    },
                };
            }
        }

        return {
            status: 'accepted',
            thread,
            messageId,
            sequenceNumber,
            dedupeHit,
            correlationId: persisted?.correlationId ?? message.correlationId,
        };
    }

    async createTopic(
        tenantId: string,
        _senderSessionId: string,
        senderAgentId: string,
        options: TopicCreateOptions
    ): Promise<TopicCreateReceipt> {
        if (options.members.length > MAX_TOPIC_MEMBERS) {
            return {
                status: 'rejected',
                error: {
                    type: 'TopicCapacityExceeded',
                    message: `A topic may have at most ${MAX_TOPIC_MEMBERS} members.`,
                },
            };
        }
        const owners = options.members.filter((m) => m.role === 'owner');
        if (owners.length !== 1 || owners[0]!.agentId !== senderAgentId) {
            return {
                status: 'rejected',
                error: {
                    type: 'Forbidden',
                    message: 'Exactly one owner is required and it must be the calling agent.',
                },
            };
        }
        const topicId = options.topicId ?? (`topic-${uuidv7()}` as TopicRef['id']);
        const topic: TopicRef = { kind: 'topic', id: topicId };
        const defaultSel = options.defaultSelector ?? { kind: 'broadcast' as const };
        const storage = topicSelectorToStorage(defaultSel);

        const now = new Date().toISOString();
        const resolvedIds = options.members.map((m) => effectiveMemberId(m));
        if (new Set(resolvedIds).size !== resolvedIds.length) {
            return {
                status: 'rejected',
                error: { type: 'AlreadyMember', message: 'Duplicate member seat in createTopic.' },
            };
        }
        const memberRows = options.members.map((m) => {
            const mid = effectiveMemberId(m);
            const sessionId = m.sessionIdOverride ?? `topic-${topicId}:${mid}`;
            return {
                memberId: mid,
                agentId: m.agentId,
                role: m.role,
                sessionId,
                registeredAt: now,
            };
        });
        const sessionIds = memberRows.map((r) => r.sessionId);
        if (new Set(sessionIds).size !== sessionIds.length) {
            return {
                status: 'rejected',
                error: { type: 'AlreadyMember', message: 'Resolved sessionId collision for topic members.' },
            };
        }

        const stopPolicies = TopicStopPolicySchema.array().min(1).parse(options.stopPolicies);
        const requiredCaps = this.requiredTopicPolicyCapabilityIds(defaultSel, stopPolicies);
        const unsupportedCaps: { agentId: string; missing: string[] }[] = [];
        for (const m of options.members) {
            const comm = this.deps.resolveAgentCommunication?.(m.agentId);
            const supported = comm?.topicPoliciesSupported;
            if (!supported || requiredCaps.length === 0) {
                continue;
            }
            const missing = requiredCaps.filter((id) => !supported.includes(id));
            if (missing.length > 0) {
                unsupportedCaps.push({ agentId: m.agentId, missing });
            }
        }

        await this.sessionManager.createConversationTopic({
            tenantId,
            conversationId: topicId,
            ownerAgentId: senderAgentId,
            defaultSelectorKind: storage.kind,
            defaultSelectorData: storage.data,
            stopPolicies,
            members: memberRows,
        });

        const ts = now;
        const resolvedMembers = memberRows.map((r) => ({
            agentId: r.agentId,
            memberId: MemberIdSchema.parse(r.memberId),
            role: r.role,
            sessionId: r.sessionId,
        }));
        const ownerSeat = memberRows.find((r) => r.agentId === senderAgentId);
        if (ownerSeat && unsupportedCaps.length > 0) {
            await this.emitTopicPolicyUnsupported({
                tenantId,
                sessionId: ownerSeat.sessionId,
                agentId: senderAgentId,
                topic,
                details: unsupportedCaps,
            });
        }
        for (let i = 0; i < resolvedMembers.length; i++) {
            const joined = resolvedMembers[i]!;
            const observation = {
                source: 'conversation',
                payload: {
                    kind: 'topic.member.joined',
                    topic,
                    member: joined,
                    ts,
                },
            } as Observation;
            await this.router.routeObservations(
                memberRows.map((r) => ({
                    tenantId,
                    sessionId: r.sessionId,
                    agentId: r.agentId,
                    observation,
                }))
            );
        }

        return {
            status: 'ok',
            topic,
            members: resolvedMembers,
        };
    }

    async invite(
        tenantId: string,
        senderSessionId: string,
        senderAgentId: string,
        options: TopicInviteOptions
    ): Promise<TopicInviteReceipt> {
        const topicRow = await this.sessionManager.getConversationTopic({
            tenantId,
            conversationId: options.topic.id,
        });
        if (!topicRow || topicRow.status !== 'open') {
            return { status: 'rejected', error: { type: 'TopicNotFound', message: 'Topic not found.' } };
        }
        if (topicRow.ownerAgentId !== senderAgentId) {
            return { status: 'rejected', error: { type: 'Forbidden', message: 'Only owner can invite.' } };
        }
        const inviteeMemberId = effectiveMemberId(options.invitee);
        const existing = await this.sessionManager.getConversationTopicMemberByMemberId({
            tenantId,
            conversationId: options.topic.id,
            memberId: inviteeMemberId,
        });
        if (existing) {
            return { status: 'rejected', error: { type: 'AlreadyMember', message: 'Already a member.' } };
        }
        const members = await this.sessionManager.listConversationTopicMembers({
            tenantId,
            conversationId: options.topic.id,
            activeOnly: true,
        });
        if (members.length >= MAX_TOPIC_MEMBERS) {
            return {
                status: 'rejected',
                error: { type: 'TopicCapacityExceeded', message: 'Topic is full.' },
            };
        }
        const resolvedSession =
            options.invitee.sessionIdOverride ?? `topic-${options.topic.id}:${inviteeMemberId}`;
        const clash = members.some((m) => m.sessionId === resolvedSession);
        if (clash) {
            return { status: 'rejected', error: { type: 'AlreadyMember', message: 'Session collision.' } };
        }
        const inviterSeat = await this.resolveInviterSeat(
            tenantId,
            options.topic.id,
            senderSessionId,
            senderAgentId
        );
        if (!inviterSeat) {
            return {
                status: 'rejected',
                error: { type: 'NotAMember', message: 'Inviter must have an active seat in topic.' },
            };
        }
        const dedupeKey = options.idempotencyKey;
        if (dedupeKey) {
            const existing = await this.sessionManager.findConversationTopicInviteByIdempotencyKey({
                tenantId,
                conversationId: options.topic.id,
                idempotencyKey: dedupeKey,
            });
            if (existing) {
                return {
                    status: 'ok',
                    token: InviteTokenSchema.parse(existing.token),
                    expiresAt: existing.expiresAt,
                };
            }
        }
        const issuedAtDate = this.clock.now();
        const issuedAt = issuedAtDate.toISOString();
        const ttlSeconds = options.ttlSeconds ?? DEFAULT_INVITE_TTL_SECONDS;
        const expiresAt = new Date(issuedAtDate.getTime() + ttlSeconds * 1000).toISOString();
        const token = `inv-${uuidv7()}`;
        const idempotencyKeyForStore = dedupeKey ?? null;
        const correlationIdForStore = options.correlationId ?? null;
        try {
            await this.sessionManager.issueConversationTopicInvite({
                tenantId,
                conversationId: options.topic.id,
                token,
                inviteeAgentId: options.invitee.agentId,
                inviteeMemberId,
                role: options.invitee.role,
                sessionIdOverride: options.invitee.sessionIdOverride ?? null,
                issuedAt,
                expiresAt,
                inviterAgentId: senderAgentId,
                inviterMemberId: inviterSeat.memberId,
                inviterSessionId: inviterSeat.sessionId,
                idempotencyKey: idempotencyKeyForStore,
                correlationId: correlationIdForStore,
            });
        } catch (err) {
            if (dedupeKey && isPgUniqueViolation(err)) {
                const raced = await this.sessionManager.findConversationTopicInviteByIdempotencyKey({
                    tenantId,
                    conversationId: options.topic.id,
                    idempotencyKey: dedupeKey,
                });
                if (raced) {
                    return {
                        status: 'ok',
                        token: InviteTokenSchema.parse(raced.token),
                        expiresAt: raced.expiresAt,
                    };
                }
            }
            throw err;
        }
        const issuedPayload = {
            kind: 'topic.invite.issued' as const,
            topic: options.topic,
            invitee: {
                agentId: options.invitee.agentId,
                memberId: options.invitee.memberId,
                role: options.invitee.role,
            },
            token: InviteTokenSchema.parse(token),
            expiresAt,
            inviterAgentId: senderAgentId,
            ts: issuedAt,
            correlationId: options.correlationId,
        };
        await this.router.routeObservation({
            tenantId,
            sessionId: inviterSeat.sessionId,
            agentId: senderAgentId,
            observation: {
                source: 'conversation',
                payload: issuedPayload,
            } as Observation,
        });
        if (this.deps.publishConversationEvent) {
            await this.deps.publishConversationEvent('conversation.topic.invite.issued', {
                tenantId,
                payload: issuedPayload,
            });
        }
        const selInvite = topicSelectorFromRecord(topicRow);
        const stopParsedInvite = TopicStopPolicySchema.array().min(1).parse(topicRow.stopPolicies);
        const reqInv = this.requiredTopicPolicyCapabilityIds(selInvite, stopParsedInvite);
        const commInv = this.deps.resolveAgentCommunication?.(options.invitee.agentId);
        const supInv = commInv?.topicPoliciesSupported;
        if (supInv && reqInv.length > 0) {
            const missingInv = reqInv.filter((id) => !supInv.includes(id));
            if (missingInv.length > 0) {
                await this.emitTopicPolicyUnsupported({
                    tenantId,
                    sessionId: inviterSeat.sessionId,
                    agentId: senderAgentId,
                    topic: options.topic,
                    details: [{ agentId: options.invitee.agentId, missing: missingInv }],
                });
            }
        }
        return { status: 'ok', token: InviteTokenSchema.parse(token), expiresAt };
    }

    async join(
        tenantId: string,
        _senderSessionId: string,
        senderAgentId: string,
        topic: TopicRef,
        options: TopicJoinOptions
    ): Promise<TopicJoinReceipt> {
        const invite = await this.sessionManager.getConversationTopicInvite({
            tenantId,
            token: String(options.inviteToken),
        });
        if (!invite) {
            return { status: 'rejected', error: { type: 'InviteNotFound', message: 'Invite not found.' } };
        }
        if (invite.inviteeAgentId !== senderAgentId) {
            return {
                status: 'rejected',
                error: { type: 'InviteTargetMismatch', message: 'Invite not for this agent.' },
            };
        }
        if (invite.consumedAt !== null) {
            return {
                status: 'rejected',
                error: { type: 'InviteAlreadyConsumed', message: 'Invite already consumed.' },
            };
        }
        if (Date.parse(invite.expiresAt) < this.clock.now().getTime()) {
            return {
                status: 'rejected',
                error: { type: 'InviteExpired', message: 'Invite has expired.' },
            };
        }
        if (invite.conversationId !== topic.id) {
            return {
                status: 'rejected',
                error: { type: 'InviteTargetMismatch', message: 'Topic mismatch.' },
            };
        }
        const consumed = await this.sessionManager.consumeConversationTopicInvite({
            tenantId,
            token: String(options.inviteToken),
            consumedAt: this.clock.now().toISOString(),
        });
        if (!consumed) {
            const latest = await this.sessionManager.getConversationTopicInvite({
                tenantId,
                token: String(options.inviteToken),
            });
            if (latest && Date.parse(latest.expiresAt) < this.clock.now().getTime()) {
                return {
                    status: 'rejected',
                    error: { type: 'InviteExpired', message: 'Invite has expired.' },
                };
            }
            return {
                status: 'rejected',
                error: { type: 'InviteAlreadyConsumed', message: 'Invite already consumed.' },
            };
        }
        const memberIdStr = invite.inviteeMemberId;
        const sessionId = consumed.sessionIdOverride ?? `topic-${topic.id}:${memberIdStr}`;
        const registeredAt = this.clock.now().toISOString();
        await this.sessionManager.addConversationTopicMember({
            tenantId,
            conversationId: topic.id,
            memberId: memberIdStr,
            agentId: senderAgentId,
            role: consumed.role,
            sessionId,
            registeredAt,
        });
        const member = {
            agentId: senderAgentId,
            memberId: MemberIdSchema.parse(memberIdStr),
            role: consumed.role,
            sessionId,
        };
        const acceptedObs = {
            source: 'conversation',
            payload: {
                kind: 'topic.invite.accepted',
                topic,
                token: InviteTokenSchema.parse(String(options.inviteToken)),
                member,
                ts: registeredAt,
                correlationId: invite.correlationId ?? undefined,
            },
        } as Observation;
        await this.router.routeObservations([
            {
                tenantId,
                sessionId: consumed.inviterSessionId,
                agentId: consumed.inviterAgentId,
                observation: acceptedObs,
            },
            {
                tenantId,
                sessionId,
                agentId: senderAgentId,
                observation: acceptedObs,
            },
        ]);

        const joinedObs = {
            source: 'conversation',
            payload: {
                kind: 'topic.member.joined',
                topic,
                member,
                ts: registeredAt,
            },
        } as Observation;
        const active = await this.sessionManager.listConversationTopicMembers({
            tenantId,
            conversationId: topic.id,
            activeOnly: true,
        });
        await this.router.routeObservations(
            active.map((m) => ({
                tenantId,
                sessionId: m.sessionId,
                agentId: m.agentId,
                observation: joinedObs,
            }))
        );
        const activationTargets = new Map<string, { sessionId: string; agentId: string }>();
        activationTargets.set(`${consumed.inviterAgentId}:${consumed.inviterSessionId}`, {
            sessionId: consumed.inviterSessionId,
            agentId: consumed.inviterAgentId,
        });
        for (const m of active) {
            activationTargets.set(`${m.agentId}:${m.sessionId}`, {
                sessionId: m.sessionId,
                agentId: m.agentId,
            });
        }
        for (const target of activationTargets.values()) {
            this.scheduleConversationActivation({
                kind: 'topic',
                tenantId,
                topicId: topic.id,
                routingSessionId: target.sessionId,
                recipientAgentId: target.agentId,
                senderSessionId: sessionId,
                senderAgentId,
            });
        }
        return { status: 'ok', topic, member };
    }

    async decline(
        tenantId: string,
        _senderSessionId: string,
        senderAgentId: string,
        topic: TopicRef,
        options: TopicDeclineOptions
    ): Promise<TopicDeclineReceipt> {
        const invite = await this.sessionManager.getConversationTopicInvite({
            tenantId,
            token: String(options.inviteToken),
        });
        if (!invite) {
            return { status: 'rejected', error: { type: 'InviteNotFound', message: 'Invite not found.' } };
        }
        if (invite.inviteeAgentId !== senderAgentId || invite.conversationId !== topic.id) {
            return {
                status: 'rejected',
                error: { type: 'InviteTargetMismatch', message: 'Invite target mismatch.' },
            };
        }
        if (invite.consumedAt !== null) {
            return {
                status: 'rejected',
                error: { type: 'InviteAlreadyConsumed', message: 'Invite already consumed.' },
            };
        }
        if (Date.parse(invite.expiresAt) < this.clock.now().getTime()) {
            return {
                status: 'rejected',
                error: { type: 'InviteExpired', message: 'Invite has expired.' },
            };
        }
        const declinedAt = this.clock.now().toISOString();
        const declined = await this.sessionManager.declineConversationTopicInvite({
            tenantId,
            token: String(options.inviteToken),
            declinedAt,
            reason: options.reason ?? null,
        });
        if (!declined) {
            return {
                status: 'rejected',
                error: { type: 'InviteAlreadyConsumed', message: 'Invite already consumed.' },
            };
        }
        const declinedObs = {
            source: 'conversation',
            payload: {
                kind: 'topic.invite.declined' as const,
                topic,
                token: options.inviteToken,
                inviteeAgentId: senderAgentId,
                inviteeMemberId: MemberIdSchema.parse(invite.inviteeMemberId),
                reason: options.reason,
                ts: declinedAt,
                correlationId: undefined,
            },
        } as Observation;
        await this.router.routeObservation({
            tenantId,
            sessionId: declined.inviterSessionId,
            agentId: declined.inviterAgentId,
            observation: declinedObs,
        });
        return { status: 'ok', topic };
    }

    async leave(
        tenantId: string,
        _senderSessionId: string,
        senderAgentId: string,
        topic: TopicRef,
        _options?: TopicLeaveOptions
    ): Promise<TopicLeaveReceipt> {
        const seats = await this.sessionManager.listConversationTopicMembersByAgent({
            tenantId,
            conversationId: topic.id,
            agentId: senderAgentId,
            activeOnly: true,
        });
        if (seats.length === 0) {
            return { status: 'rejected', error: { type: 'NotAMember', message: 'Not a member.' } };
        }
        let targetSeat = seats[0]!;
        if (seats.length > 1) {
            const opt = _options?.memberId;
            if (opt === undefined) {
                return {
                    status: 'rejected',
                    error: { type: 'SenderAmbiguous', message: 'Multiple seats; specify memberId.' },
                };
            }
            const found = seats.find((s) => s.memberId === String(opt));
            if (!found) {
                return { status: 'rejected', error: { type: 'NotAMember', message: 'Not a member.' } };
            }
            targetSeat = found;
        }
        const leftAt = new Date().toISOString();
        await this.sessionManager.leaveConversationTopicMember({
            tenantId,
            conversationId: topic.id,
            memberId: targetSeat.memberId,
            leftAt,
        });
        const obs = {
            source: 'conversation',
            payload: {
                kind: 'topic.member.left',
                topic,
                agentId: senderAgentId,
                memberId: MemberIdSchema.parse(targetSeat.memberId),
                ts: leftAt,
            },
        } as Observation;
        const active = await this.sessionManager.listConversationTopicMembers({
            tenantId,
            conversationId: topic.id,
            activeOnly: true,
        });
        await this.router.routeObservations(
            active.map((m) => ({
                tenantId,
                sessionId: m.sessionId,
                agentId: m.agentId,
                observation: obs,
            }))
        );
        return { status: 'ok', topic };
    }

    async post(
        tenantId: string,
        senderSessionId: string,
        senderAgentId: string,
        topic: TopicRef,
        message: OutboundTopicMessage,
        options?: TopicPostOptions
    ): Promise<FanoutSendReceipt> {
        const topicRow = await this.sessionManager.getConversationTopic({
            tenantId,
            conversationId: topic.id,
        });
        if (!topicRow) {
            return {
                status: 'rejected',
                topic,
                error: { type: 'TopicNotFound', message: 'Topic not found.' },
            };
        }
        if (topicRow.status !== 'open') {
            return {
                status: 'rejected',
                topic,
                error: { type: 'ConversationClosed', message: 'Topic is closed.' },
            };
        }

        const senderSeats = await this.sessionManager.listConversationTopicMembersByAgent({
            tenantId,
            conversationId: topic.id,
            agentId: senderAgentId,
            activeOnly: true,
        });
        if (senderSeats.length === 0) {
            return {
                status: 'rejected',
                topic,
                error: { type: 'NotAMember', message: 'Sender is not a member.' },
            };
        }
        let senderSeat = senderSeats[0]!;
        if (senderSeats.length > 1) {
            const mid = message.senderMemberId;
            if (mid === undefined) {
                return {
                    status: 'rejected',
                    topic,
                    error: { type: 'SenderAmbiguous', message: 'Multiple seats; specify senderMemberId.' },
                };
            }
            const found = senderSeats.find((s) => s.memberId === String(mid));
            if (!found) {
                return {
                    status: 'rejected',
                    topic,
                    error: { type: 'NotAMember', message: 'Sender seat not found.' },
                };
            }
            senderSeat = found;
        }
        const senderMemberIdResolved = senderSeat.memberId;

        const dedupeKey = options?.idempotencyKey;
        if (dedupeKey) {
            const existing = await this.deps.messageLog.findByIdempotency({
                tenantId,
                conversationId: topic.id,
                senderMemberId: MemberIdSchema.parse(senderMemberIdResolved),
                idempotencyKey: dedupeKey,
            });
            if (existing) {
                const deliveries = await this.sessionManager.listConversationMessageDeliveries({
                    tenantId,
                    conversationId: topic.id,
                    sequenceNumber: existing.sequenceNumber,
                });
                const row: ConversationMessageRecord = {
                    tenantId,
                    conversationId: topic.id,
                    sequenceNumber: existing.sequenceNumber,
                    messageId: existing.messageId,
                    senderAgentId: existing.senderAgentId,
                    senderMemberId: String(existing.senderMemberId),
                    recipientAgentId: null,
                    conversationKind: 'topic',
                    selectorKind: existing.selectorKind ?? null,
                    selectorPolicyId: existing.selectorPolicyId != null ? String(existing.selectorPolicyId) : null,
                    speechAct: existing.speechAct,
                    payload: existing.payload as Record<string, unknown>,
                    correlationId: existing.correlationId,
                    idempotencyKey: existing.idempotencyKey,
                    createdAt: existing.createdAt,
                };
                return reconstructFanoutReceiptFromDeliveries(topic, row, deliveries);
            }
        }

        const members = await this.sessionManager.listConversationTopicMembers({
            tenantId,
            conversationId: topic.id,
            activeOnly: true,
        });
        const memberRows: TopicMemberRow[] = members.map((m) => ({
            memberId: m.memberId,
            agentId: m.agentId,
            role: m.role,
            registeredAt: m.registeredAt,
            sessionId: m.sessionId,
        }));

        const priorMsgs = await this.sessionManager.listConversationMessages({
            tenantId,
            conversationId: topic.id,
        });
        const nextSequenceNumber =
            priorMsgs.length === 0
                ? 1
                : priorMsgs.reduce((m, r) => Math.max(m, r.sequenceNumber), 0) + 1;

        const baseSelector = options?.selector ?? topicSelectorFromRecord(topicRow);
        const sel = resolveTopicSelector(
            baseSelector,
            senderMemberIdResolved,
            memberRows,
            topicRow.rotationCursor,
            {
                tenantId,
                topicId: topic.id,
                sequenceNumber: nextSequenceNumber,
                nowIso: this.clock.now().toISOString(),
                policyRegistry: this.topicSelectorPolicyRegistry,
            }
        );

        if (!sel.ok) {
            if (sel.error === 'RecipientAmbiguous') {
                return {
                    status: 'rejected',
                    topic,
                    error: { type: 'RecipientAmbiguous', message: 'Multiple seats for agentId.' },
                };
            }
            if (sel.error === 'RecipientNotMember') {
                return {
                    status: 'rejected',
                    topic,
                    error: { type: 'RecipientNotMember', message: 'Recipient is not an active member.' },
                };
            }
            if (sel.error === 'SelectorPolicyNotRegistered') {
                const policyId = baseSelector.kind === 'selector_policy' ? baseSelector.policyId : undefined;
                return {
                    status: 'rejected',
                    topic,
                    error: {
                        type: 'SelectorPolicyNotRegistered',
                        message: 'Selector policy is not registered.',
                        policyId,
                    },
                };
            }
            if (sel.error === 'PolicyParamsInvalid') {
                const policyId = baseSelector.kind === 'selector_policy' ? baseSelector.policyId : undefined;
                return {
                    status: 'rejected',
                    topic,
                    error: {
                        type: 'PolicyParamsInvalid',
                        message: 'Selector policy params are invalid.',
                        policyId,
                    },
                };
            }
            const policyId = baseSelector.kind === 'selector_policy' ? baseSelector.policyId : undefined;
            return {
                status: 'rejected',
                topic,
                error: {
                    type: 'PolicyInternalError',
                    message: 'Selector policy failed.',
                    policyId,
                },
            };
        }
        const { recipients, nextRotationCursor, selectorPolicyForTrace } = sel;

        if (baseSelector.kind === 'round_robin' || baseSelector.kind === 'selector_policy') {
            await this.sessionManager.updateConversationTopic({
                tenantId,
                conversationId: topic.id,
                patch: { rotationCursor: nextRotationCursor },
            });
        }

        const queueMode = options?.queueMode ?? 'reject';

        type Scan = {
            memberId: string;
            agentId: string;
            sessionId: string;
            outcome: 'deliver' | 'queue' | 'reject';
            rejection?: ConversationError;
        };
        const scans: Scan[] = [];
        for (const rec of recipients) {
            const inflight = await this.sessionInflight(tenantId, rec.sessionId);
            if (!inflight) {
                scans.push({
                    memberId: rec.memberId,
                    agentId: rec.agentId,
                    sessionId: rec.sessionId,
                    outcome: 'deliver',
                });
            } else if (queueMode === 'queue') {
                const q = this.queueState.byTopic.get(topic.id) ?? 0;
                if (q >= MAX_QUEUE_DEPTH) {
                    scans.push({
                        memberId: rec.memberId,
                        agentId: rec.agentId,
                        sessionId: rec.sessionId,
                        outcome: 'reject',
                        rejection: { type: 'ThreadBusy', message: 'Recipient session busy.' },
                    });
                } else {
                    scans.push({
                        memberId: rec.memberId,
                        agentId: rec.agentId,
                        sessionId: rec.sessionId,
                        outcome: 'queue',
                    });
                }
            } else {
                scans.push({
                    memberId: rec.memberId,
                    agentId: rec.agentId,
                    sessionId: rec.sessionId,
                    outcome: 'reject',
                    rejection: { type: 'ThreadBusy', message: 'Recipient session busy.' },
                });
            }
        }

        for (const s of scans) {
            if (s.outcome !== 'deliver') {
                continue;
            }
            const comm = this.deps.resolveAgentCommunication?.(s.agentId);
            const capRej =
                validateThreadable(comm, s.agentId) ??
                validateSpeechActAccepted(comm, message.speechAct) ??
                validateContentTypeAccepted(comm, message.content);
            if (capRej) {
                s.outcome = 'reject';
                s.rejection = capRej;
            }
        }

        const allQueue = scans.length > 0 && scans.every((s) => s.outcome === 'queue');
        if (allQueue) {
            const nextPos = (this.queueState.byTopic.get(topic.id) ?? 0) + 1;
            this.queueState.byTopic.set(topic.id, nextPos);
            return { status: 'queued', topic, queuePosition: nextPos };
        }

        const allReject =
            scans.length > 0 && scans.every((s) => s.outcome === 'reject');
        if (allReject) {
            const firstCap = scans.find((s) => s.rejection !== undefined)?.rejection;
            return {
                status: 'rejected',
                topic,
                error: firstCap ?? { type: 'ThreadBusy', message: 'All recipients busy.' },
            };
        }

        const qpBefore = this.queueState.byTopic.get(topic.id) ?? 0;
        const logDeliveries: MessageLogDelivery[] = [];
        for (const s of scans) {
            const mid = MemberIdSchema.parse(s.memberId);
            if (s.outcome === 'deliver') {
                logDeliveries.push({
                    recipientAgentId: s.agentId,
                    recipientMemberId: mid,
                    sessionId: s.sessionId,
                    status: 'buffered',
                });
            } else if (s.outcome === 'queue') {
                logDeliveries.push({
                    recipientAgentId: s.agentId,
                    recipientMemberId: mid,
                    sessionId: s.sessionId,
                    status: 'queued',
                    error: null,
                    queuePosition: qpBefore + 1,
                });
            } else {
                logDeliveries.push({
                    recipientAgentId: s.agentId,
                    recipientMemberId: mid,
                    sessionId: s.sessionId,
                    status: 'rejected',
                    error: s.rejection ?? { type: 'ThreadBusy', message: 'Recipient session busy.' },
                    queuePosition: null,
                });
            }
        }

        const appendResult = await this.deps.messageLog.append({
            tenantId,
            conversationId: topic.id,
            conversationKind: 'topic',
            senderAgentId: message.senderAgentId,
            senderMemberId: MemberIdSchema.parse(senderMemberIdResolved),
            selectorKind: baseSelector.kind,
            selectorPolicyId:
                baseSelector.kind === 'selector_policy' ? baseSelector.policyId : undefined,
            speechAct: message.speechAct,
            payload: { content: message.content },
            correlationId: message.correlationId,
            idempotencyKey: dedupeKey,
            deliveries: logDeliveries,
        });

        if (appendResult.kind === 'dedupeHit') {
            const deliveries = await this.sessionManager.listConversationMessageDeliveries({
                tenantId,
                conversationId: topic.id,
                sequenceNumber: appendResult.sequenceNumber,
            });
            const rows = await this.sessionManager.listConversationMessages({ tenantId, conversationId: topic.id });
            const row = rows.find((r) => r.sequenceNumber === appendResult.sequenceNumber);
            if (row) {
                return reconstructFanoutReceiptFromDeliveries(topic, row, deliveries);
            }
        }

        const messageId = appendResult.messageId;
        const sequenceNumber = appendResult.sequenceNumber;

        const persistedRows = await this.sessionManager.listConversationMessages({
            tenantId,
            conversationId: topic.id,
        });
        const persisted = persistedRows.find((r) => r.sequenceNumber === sequenceNumber);
        const content =
            persisted?.payload &&
            typeof persisted.payload === 'object' &&
            persisted.payload !== null &&
            'content' in persisted.payload
                ? (persisted.payload as { content: unknown }).content
                : message.content;

        const selectorUsed: TopicSelector = baseSelector;
        const inboundBase = {
            id: messageId,
            conversation: topic,
            senderAgentId: message.senderAgentId,
            senderMemberId: MemberIdSchema.parse(senderMemberIdResolved),
            speechAct: message.speechAct,
            content,
            sequenceNumber,
            correlationId: persisted?.correlationId ?? message.correlationId,
            idempotencyKey: persisted?.idempotencyKey ?? dedupeKey,
            ts: appendResult.createdAt,
        };

        const accepted: DeliverySummary[] = [];
        const rejected: Array<{ memberId: MemberId; recipientAgentId: string; error: ConversationError }> = [];

        let worstBackpressure: TopicPostBackpressureSample | undefined;
        for (const s of scans) {
            if (s.outcome === 'queue') {
                rejected.push({
                    memberId: MemberIdSchema.parse(s.memberId),
                    recipientAgentId: s.agentId,
                    error: { type: 'ThreadBusy', message: 'Recipient session busy.' },
                });
                continue;
            }
            if (s.outcome === 'reject') {
                rejected.push({
                    memberId: MemberIdSchema.parse(s.memberId),
                    recipientAgentId: s.agentId,
                    error: s.rejection ?? { type: 'ThreadBusy', message: 'Recipient session busy.' },
                });
                continue;
            }
            const recipientAgentId = s.agentId;
            const recipientMemberId = MemberIdSchema.parse(s.memberId);
            const obs = {
                source: 'conversation',
                payload: {
                    kind: 'topic.message.received',
                    message: {
                        ...inboundBase,
                        recipientAgentId,
                        recipientMemberId,
                    },
                    topic,
                    selector: selectorUsed,
                    recipient: { memberId: recipientMemberId, agentId: recipientAgentId },
                },
            } as Observation;
            const consumerKey = String(recipientMemberId);
            if (this.deps.backpressureManager) {
                const snap = this.deps.backpressureManager.dispatchStarted(tenantId, consumerKey);
                const sample: TopicPostBackpressureSample = {
                    consumerId: consumerKey,
                    state: snap.state,
                    unackedCount: snap.unackedCount,
                };
                if (!worstBackpressure || sample.unackedCount > worstBackpressure.unackedCount) {
                    worstBackpressure = sample;
                }
            }
            try {
                await this.router.routeObservation({
                    tenantId,
                    sessionId: s.sessionId,
                    agentId: recipientAgentId,
                    observation: obs,
                });
                await this.sessionManager.updateConversationMessageDelivery({
                    tenantId,
                    conversationId: topic.id,
                    sequenceNumber,
                    memberId: String(recipientMemberId),
                    status: 'delivered',
                    error: null,
                    queuePosition: null,
                });
                await this.publishConversationRuntimeEvent({
                    sessionId: s.sessionId,
                    tenantId,
                    type: 'conversation.message.received',
                    id: `${messageId}:received:${s.sessionId}`,
                    seq: sequenceNumber,
                    ts: appendResult.createdAt,
                    conversationId: topic.id,
                    conversationKind: 'topic',
                    messageId,
                    senderAgentId: message.senderAgentId,
                    recipientAgentId,
                    speechAct: message.speechAct,
                });
                const activateParams: ConversationActivateParams = {
                    kind: 'topic',
                    tenantId,
                    topicId: topic.id,
                    routingSessionId: s.sessionId,
                    recipientAgentId,
                    senderSessionId,
                    senderAgentId: message.senderAgentId,
                };
                const wake = this.deps.resolveWakeOnTopicMessage?.(recipientAgentId) === true;
                if (wake) {
                    this.scheduleConversationActivation(activateParams);
                }
                accepted.push({
                    memberId: recipientMemberId,
                    recipientAgentId,
                    sessionId: s.sessionId,
                    messageId,
                    sequenceNumber,
                    dedupeHit: false,
                    correlationId: message.correlationId,
                });
            } catch (err) {
                await this.sessionManager.updateConversationMessageDelivery({
                    tenantId,
                    conversationId: topic.id,
                    sequenceNumber,
                    memberId: String(recipientMemberId),
                    status: 'dead-lettered',
                    error: errorToDeliveryPayload(err),
                });
                throw err;
            } finally {
                this.deps.backpressureManager?.dispatchAcknowledged(tenantId, consumerKey);
            }
        }
        this.topicPostBackpressureSink?.(worstBackpressure);

        const selectorPolicyTrace =
            selectorPolicyForTrace !== undefined
                ? {
                      policyId: selectorPolicyForTrace.policyId,
                      result:
                          selectorPolicyForTrace.outcome === 'selected'
                              ? ('selected' as const)
                              : ('abstained_fallback_broadcast' as const),
                      paramsHash: selectorPolicyForTrace.paramsHash,
                  }
                : undefined;

        const outboundObs = {
            source: 'conversation',
            payload: {
                kind: 'outbound.committed',
                ref: topic,
                messageId,
                sequenceNumber,
                correlationId: message.correlationId,
                deliveries: accepted,
                selectorKind: baseSelector.kind,
                topicAppend: {
                    speechAct: message.speechAct,
                    payload: { content: message.content },
                },
                ...(baseSelector.kind === 'selector_policy'
                    ? {
                          selectorPolicyId: baseSelector.policyId,
                          selectorParamsHash: paramsHashFromJsonValue(baseSelector.params),
                      }
                    : {}),
            },
        } as Observation;
        await this.router.routeObservation({
            tenantId,
            sessionId: senderSeat.sessionId,
            agentId: senderAgentId,
            observation: outboundObs,
        });
        await this.publishConversationRuntimeEvent({
            sessionId: senderSeat.sessionId,
            tenantId,
            type: 'conversation.message.sent',
            id: `${messageId}:sent:${senderSeat.sessionId}`,
            seq: sequenceNumber,
            ts: appendResult.createdAt,
            conversationId: topic.id,
            conversationKind: 'topic',
            messageId,
            senderAgentId: message.senderAgentId,
            speechAct: message.speechAct,
        });

        const stopPolicyTrace = await this.runStopPoliciesAfterSuccessfulTopicAppend({
            tenantId,
            senderSessionId,
            senderAgentId,
            topic,
        });

        if (accepted.length > 0 && rejected.length === 0) {
            return {
                status: 'accepted',
                topic,
                deliveries: accepted,
                ...(selectorPolicyTrace !== undefined ? { selectorPolicyTrace } : {}),
                ...(stopPolicyTrace !== undefined ? { stopPolicyTrace } : {}),
            };
        }
        if (accepted.length > 0 && rejected.length > 0) {
            return {
                status: 'partial',
                topic,
                accepted,
                rejected,
                ...(selectorPolicyTrace !== undefined ? { selectorPolicyTrace } : {}),
                ...(stopPolicyTrace !== undefined ? { stopPolicyTrace } : {}),
            };
        }
        return {
            status: 'rejected',
            topic,
            error: {
                type: 'NoEligibleRecipients',
                message: 'No recipients could accept delivery.',
            },
        };
    }

    async close(
        tenantId: string,
        _senderSessionId: string,
        senderAgentId: string,
        ref: ConversationRef,
        options?: CloseConversationOptions
    ): Promise<CloseConversationReceipt> {
        if (ref.kind === 'thread') {
            const row = await this.sessionManager.getConversationThread({
                tenantId,
                conversationId: ref.id,
            });
            if (!row) {
                return {
                    status: 'rejected',
                    error: { type: 'ConversationNotFound', message: 'Conversation not found.' },
                };
            }
            if (row.status === 'archived') {
                return {
                    status: 'rejected',
                    error: { type: 'ConversationClosed', message: 'Thread is archived.' },
                };
            }
            const ts = this.clock.now().toISOString();
            if (row.status === 'closed') {
                if (options?.archiveAfter === true) {
                    await this.sessionManager.updateConversationThreadStatus({
                        kind: 'archive',
                        tenantId,
                        conversationId: ref.id,
                        archivedAt: ts,
                        archivedByAgentId: senderAgentId,
                        archivedReasonText: options?.reason ?? null,
                    });
                    await this.emitThreadArchivedFanout(tenantId, ref, ts, senderAgentId, options?.reason);
                    return { status: 'ok', ref, closed: true, archived: true };
                }
                return { status: 'ok', ref, closed: true };
            }
            await this.sessionManager.updateConversationThreadStatus({
                kind: 'close',
                tenantId,
                conversationId: ref.id,
                closedAt: ts,
                closeReason: 'explicit',
                closeReasonText: options?.reason ?? null,
                closedByAgentId: senderAgentId,
            });
            const threadClosedObs = {
                source: 'conversation',
                payload: {
                    kind: 'thread.closed' as const,
                    thread: ref,
                    ts,
                    closedBy: senderAgentId,
                    closedReason: 'explicit' as const,
                    reasonText: options?.reason,
                },
            } as Observation;
            const ownerTarget = this.deps.routeTargetForThread({
                tenantId,
                threadId: ref.id,
                recipientAgentId: row.ownerAgentId,
            });
            const participantTarget = this.deps.routeTargetForThread({
                tenantId,
                threadId: ref.id,
                recipientAgentId: row.participantAgentId,
            });
            await this.router.routeObservations([
                {
                    tenantId,
                    sessionId: ownerTarget.sessionId,
                    agentId: row.ownerAgentId,
                    observation: threadClosedObs,
                },
                {
                    tenantId,
                    sessionId: participantTarget.sessionId,
                    agentId: row.participantAgentId,
                    observation: threadClosedObs,
                },
            ]);
            if (options?.archiveAfter === true) {
                await this.sessionManager.updateConversationThreadStatus({
                    kind: 'archive',
                    tenantId,
                    conversationId: ref.id,
                    archivedAt: ts,
                    archivedByAgentId: senderAgentId,
                    archivedReasonText: options?.reason ?? null,
                });
                await this.emitThreadArchivedFanout(tenantId, ref, ts, senderAgentId, options?.reason);
                return { status: 'ok', ref, closed: true, archived: true };
            }
            return { status: 'ok', ref, closed: true };
        }

        const topicRow = await this.sessionManager.getConversationTopic({
            tenantId,
            conversationId: ref.id,
        });
        if (!topicRow) {
            return {
                status: 'rejected',
                error: { type: 'ConversationNotFound', message: 'Conversation not found.' },
            };
        }
        if (topicRow.status === 'archived') {
            return {
                status: 'rejected',
                error: { type: 'ConversationClosed', message: 'Topic is archived.' },
            };
        }
        const ts = this.clock.now().toISOString();
        const closedByMemberId = await this.resolveTopicMemberIdForSession(
            tenantId,
            ref.id,
            _senderSessionId,
            senderAgentId
        );

        if (topicRow.status === 'open') {
            await this.sessionManager.updateConversationTopic({
                tenantId,
                conversationId: ref.id,
                patch: {
                    status: 'closed',
                    closedAt: ts,
                    closeReason: 'explicit',
                    closeReasonText: options?.reason ?? null,
                    closedByAgentId: senderAgentId,
                    closedByMemberId: closedByMemberId ?? null,
                },
            });
            const topicClosedObs = {
                source: 'conversation',
                payload: {
                    kind: 'topic.closed' as const,
                    topic: ref,
                    ts,
                    reason: options?.reason,
                    closedBy: senderAgentId,
                    closedReason: 'explicit' as const,
                    reasonText: options?.reason,
                    ...(closedByMemberId !== undefined ? { closedByMemberId } : {}),
                },
            } as Observation;
            const activeOpen = await this.sessionManager.listConversationTopicMembers({
                tenantId,
                conversationId: ref.id,
                activeOnly: true,
            });
            await this.router.routeObservations(
                activeOpen.map((m) => ({
                    tenantId,
                    sessionId: m.sessionId,
                    agentId: m.agentId,
                    observation: topicClosedObs,
                }))
            );
            if (options?.archiveAfter === true) {
                await this.sessionManager.updateConversationTopic({
                    tenantId,
                    conversationId: ref.id,
                    patch: {
                        status: 'archived',
                        archivedAt: ts,
                        archivedByAgentId: senderAgentId,
                        archivedByMemberId: closedByMemberId ?? null,
                        archivedReasonText: options?.reason ?? null,
                    },
                });
                await this.emitTopicArchivedFanout(
                    tenantId,
                    ref,
                    ts,
                    senderAgentId,
                    options?.reason,
                    closedByMemberId
                );
                return { status: 'ok', ref, closed: true, archived: true };
            }
            return { status: 'ok', ref, closed: true };
        }

        if (options?.archiveAfter === true) {
            const archiveTs = this.clock.now().toISOString();
            await this.sessionManager.updateConversationTopic({
                tenantId,
                conversationId: ref.id,
                patch: {
                    status: 'archived',
                    archivedAt: archiveTs,
                    archivedByAgentId: senderAgentId,
                    archivedByMemberId: closedByMemberId ?? null,
                    archivedReasonText: options?.reason ?? null,
                },
            });
            await this.emitTopicArchivedFanout(
                tenantId,
                ref,
                archiveTs,
                senderAgentId,
                options?.reason,
                closedByMemberId
            );
            return { status: 'ok', ref, closed: true, archived: true };
        }
        return { status: 'ok', ref, closed: true };
    }

    async archive(
        tenantId: string,
        _senderSessionId: string,
        senderAgentId: string,
        ref: ConversationRef,
        options?: ArchiveConversationOptions
    ): Promise<ArchiveConversationReceipt> {
        if (ref.kind === 'topic') {
            const topicRow = await this.sessionManager.getConversationTopic({
                tenantId,
                conversationId: ref.id,
            });
            if (!topicRow) {
                return {
                    status: 'rejected',
                    error: { type: 'ConversationNotFound', message: 'Conversation not found.' },
                };
            }
            if (topicRow.status === 'open') {
                return {
                    status: 'rejected',
                    error: { type: 'ConversationNotClosed', message: 'Topic is not closed.' },
                };
            }
            if (topicRow.status === 'archived') {
                return { status: 'ok', ref, archived: true };
            }
            const ts = this.clock.now().toISOString();
            const archivedByMemberId = await this.resolveTopicMemberIdForSession(
                tenantId,
                ref.id,
                _senderSessionId,
                senderAgentId
            );
            await this.sessionManager.updateConversationTopic({
                tenantId,
                conversationId: ref.id,
                patch: {
                    status: 'archived',
                    archivedAt: ts,
                    archivedByAgentId: senderAgentId,
                    archivedByMemberId: archivedByMemberId ?? null,
                    archivedReasonText: options?.reasonText ?? null,
                },
            });
            await this.emitTopicArchivedFanout(
                tenantId,
                ref,
                ts,
                senderAgentId,
                options?.reasonText,
                archivedByMemberId
            );
            return { status: 'ok', ref, archived: true };
        }

        const row = await this.sessionManager.getConversationThread({
            tenantId,
            conversationId: ref.id,
        });
        if (!row) {
            return {
                status: 'rejected',
                error: { type: 'ConversationNotFound', message: 'Conversation not found.' },
            };
        }
        if (row.status === 'open') {
            return {
                status: 'rejected',
                error: { type: 'ConversationNotClosed', message: 'Thread is not closed.' },
            };
        }
        if (row.status === 'archived') {
            return { status: 'ok', ref, archived: true };
        }
        const ts = this.clock.now().toISOString();
        await this.sessionManager.updateConversationThreadStatus({
            kind: 'archive',
            tenantId,
            conversationId: ref.id,
            archivedAt: ts,
            archivedByAgentId: senderAgentId,
            archivedReasonText: options?.reasonText ?? null,
        });
        await this.emitThreadArchivedFanout(tenantId, ref, ts, senderAgentId, options?.reasonText);
        return { status: 'ok', ref, archived: true };
    }

    private async resolveTopicMemberIdForSession(
        tenantId: string,
        topicId: string,
        senderSessionId: string,
        senderAgentId: string
    ): Promise<MemberId | undefined> {
        const members = await this.sessionManager.listConversationTopicMembers({
            tenantId,
            conversationId: topicId,
            activeOnly: true,
        });
        const match = members.filter((m) => m.sessionId === senderSessionId && m.agentId === senderAgentId);
        if (match.length === 1) {
            return MemberIdSchema.parse(match[0]!.memberId);
        }
        return undefined;
    }

    private async emitTopicArchivedFanout(
        tenantId: string,
        topicRef: TopicRef,
        ts: string,
        archivedBy: string | undefined,
        reasonText: string | undefined,
        archivedByMemberId?: MemberId
    ): Promise<void> {
        const obs = {
            source: 'conversation',
            payload: {
                kind: 'topic.archived' as const,
                topic: topicRef,
                ts,
                archivedBy,
                ...(archivedByMemberId !== undefined ? { archivedByMemberId } : {}),
                reasonText,
            },
        } as Observation;
        const active = await this.sessionManager.listConversationTopicMembers({
            tenantId,
            conversationId: topicRef.id,
            activeOnly: true,
        });
        await this.router.routeObservations(
            active.map((m) => ({
                tenantId,
                sessionId: m.sessionId,
                agentId: m.agentId,
                observation: obs,
            }))
        );
    }

    private async emitThreadArchivedFanout(
        tenantId: string,
        ref: ThreadRef,
        ts: string,
        archivedBy: string | undefined,
        reasonText: string | undefined
    ): Promise<void> {
        const row = await this.sessionManager.getConversationThread({
            tenantId,
            conversationId: ref.id,
        });
        if (!row) {
            return;
        }
        const obs = {
            source: 'conversation',
            payload: {
                kind: 'thread.archived' as const,
                thread: ref,
                ts,
                archivedBy,
                reasonText,
            },
        } as Observation;
        const ownerTarget = this.deps.routeTargetForThread({
            tenantId,
            threadId: ref.id,
            recipientAgentId: row.ownerAgentId,
        });
        const participantTarget = this.deps.routeTargetForThread({
            tenantId,
            threadId: ref.id,
            recipientAgentId: row.participantAgentId,
        });
        await this.router.routeObservations([
            {
                tenantId,
                sessionId: ownerTarget.sessionId,
                agentId: row.ownerAgentId,
                observation: obs,
            },
            {
                tenantId,
                sessionId: participantTarget.sessionId,
                agentId: row.participantAgentId,
                observation: obs,
            },
        ]);
    }

    async readProjection(
        tenantId: string,
        _senderSessionId: string,
        senderAgentId: string,
        topic: TopicRef,
        token: { projectionName: string },
        options?: ReadProjectionOptions
    ): Promise<import('../../public-types/conversation/topicProjection.js').ReadProjectionReceipt> {
        const topicRow = await this.sessionManager.getConversationTopic({
            tenantId,
            conversationId: topic.id,
        });
        if (!topicRow) {
            return { status: 'rejected', error: { type: 'TopicNotFound', message: 'Topic not found.' } };
        }
        if (topicRow.status !== 'open') {
            return {
                status: 'rejected',
                error: { type: 'ConversationClosed', message: 'Topic is not open.' },
            };
        }
        const seats = await this.sessionManager.listConversationTopicMembersByAgent({
            tenantId,
            conversationId: topic.id,
            agentId: senderAgentId,
            activeOnly: true,
        });
        if (seats.length === 0) {
            return { status: 'rejected', error: { type: 'NotAMember', message: 'Sender is not a member.' } };
        }
        const def = getTopicProjectionRegistry().get(token.projectionName);
        if (!def) {
            return {
                status: 'rejected',
                error: {
                    type: 'ProjectionNotRegistered',
                    message: `Projection "${token.projectionName}" is not registered.`,
                    projectionName: token.projectionName,
                },
            };
        }
        const fromSeq = options?.fromSequence ?? 0;
        const limit = options?.limit ?? 10_000;
        const rows = await this.deps.messageLog.read({
            tenantId,
            conversationId: topic.id,
            fromSequence: fromSeq,
            limit,
        });
        let state = def.initial();
        let lastSeq = 0;
        const maxSeq = options?.asOfSequence;
        for (const row of rows) {
            if (maxSeq !== undefined && row.sequenceNumber > maxSeq) {
                continue;
            }
            state = def.reduce(state, row);
            lastSeq = row.sequenceNumber;
        }
        const parsedState = def.stateSchema.safeParse(state);
        if (!parsedState.success) {
            return {
                status: 'rejected',
                error: {
                    type: 'ProjectionStateInvalid',
                    message: parsedState.error.message,
                    projectionName: token.projectionName,
                },
            };
        }
        return { status: 'ok', state: parsedState.data, asOfSequence: lastSeq };
    }

    async appendSignal(
        tenantId: string,
        senderSessionId: string,
        senderAgentId: string,
        topic: TopicRef,
        input: AppendSignalInput,
        options?: TopicPostOptions
    ): Promise<FanoutSendReceipt> {
        const st = SignalKindSchema.safeParse(input.signalType);
        if (!st.success) {
            return {
                status: 'rejected',
                topic,
                error: { type: 'InvalidSignalKind', message: st.error.message },
            };
        }
        return this.post(
            tenantId,
            senderSessionId,
            senderAgentId,
            topic,
            {
                senderAgentId,
                senderMemberId: input.senderMemberId,
                speechAct: 'signal',
                content: { signalType: st.data, body: input.payload },
                correlationId: input.correlationId,
            },
            {
                ...options,
                idempotencyKey: input.idempotencyKey ?? options?.idempotencyKey,
            }
        );
    }
}
