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
    InviteTokenSchema,
    MAX_TOPIC_MEMBERS,
    MemberIdSchema,
} from '../../public-types/conversation/schemas.js';
import type { TopicMember } from '../../public-types/conversation/types.js';
import { ConversationRouter } from './ConversationRouter.js';
import { wallClock, type Clock } from './Clock.js';
import {
    resolveTopicSelector,
    topicSelectorFromRecord,
    topicSelectorToStorage,
    type TopicMemberRow,
} from './TopicSelector.js';

function effectiveMemberId(m: TopicMember): string {
    return m.memberId !== undefined ? String(m.memberId) : m.agentId;
}
import { reconstructFanoutReceiptFromDeliveries } from './fanoutReplay.js';

const MAX_QUEUE_DEPTH = 32;
const DEFAULT_INVITE_TTL_SECONDS = 60 * 60 * 24;

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
    private readonly queueState: QueueState = {
        byThread: new Map(),
        byTopic: new Map(),
    };

    constructor(
        private readonly sessionManager: SessionManager,
        private readonly deps: ConversationServiceDeps
    ) {
        this.router = new ConversationRouter(sessionManager);
        this.clock = deps.clock ?? wallClock;
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
        const ttlMs = this.deps.resolveThreadTtlMs ? this.deps.resolveThreadTtlMs() : 3600000;
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
                },
            ],
        });
        const dedupeHit = appendResult.kind === 'dedupeHit';
        const messageId = appendResult.messageId;
        const sequenceNumber = appendResult.sequenceNumber;
        const ttlMsAfter = this.deps.resolveThreadTtlMs ? this.deps.resolveThreadTtlMs() : 3600000;
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
        await this.router.routeObservation({
            tenantId: target.tenantId,
            sessionId: target.sessionId,
            agentId: target.agentId,
            observation,
        });

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

        await this.sessionManager.createConversationTopic({
            tenantId,
            conversationId: topicId,
            ownerAgentId: senderAgentId,
            defaultSelectorKind: storage.kind,
            defaultSelectorData: storage.data,
            members: memberRows,
        });

        const ts = now;
        const resolvedMembers = memberRows.map((r) => ({
            agentId: r.agentId,
            memberId: MemberIdSchema.parse(r.memberId),
            role: r.role,
            sessionId: r.sessionId,
        }));
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
        const obs = {
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
                observation: obs,
            }))
        );
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

        const baseSelector = options?.selector ?? topicSelectorFromRecord(topicRow);
        const sel = resolveTopicSelector(
            baseSelector,
            senderMemberIdResolved,
            memberRows,
            topicRow.rotationCursor
        );

        if (!sel.ok) {
            const err =
                sel.error === 'RecipientAmbiguous'
                    ? ({ type: 'RecipientAmbiguous' as const, message: 'Multiple seats for agentId.' })
                    : ({ type: 'RecipientNotMember' as const, message: 'Recipient is not an active member.' });
            return {
                status: 'rejected',
                topic,
                error: err,
            };
        }
        const { recipients, nextRotationCursor } = sel;

        if (baseSelector.kind === 'round_robin') {
            await this.sessionManager.updateConversationTopic({
                tenantId,
                conversationId: topic.id,
                patch: { rotationCursor: nextRotationCursor },
            });
        }

        const queueMode = options?.queueMode ?? 'reject';

        type Scan = { memberId: string; agentId: string; sessionId: string; outcome: 'deliver' | 'queue' | 'reject' };
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
                });
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
            return {
                status: 'rejected',
                topic,
                error: { type: 'ThreadBusy', message: 'All recipients busy.' },
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
                    error: { type: 'ThreadBusy', message: 'Recipient session busy.' },
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
            speechAct: message.speechAct,
            content,
            sequenceNumber,
            correlationId: persisted?.correlationId ?? message.correlationId,
            idempotencyKey: persisted?.idempotencyKey ?? dedupeKey,
            ts: appendResult.createdAt,
        };

        const accepted: DeliverySummary[] = [];
        const rejected: Array<{ memberId: MemberId; recipientAgentId: string; error: ConversationError }> = [];

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
                    error: { type: 'ThreadBusy', message: 'Recipient session busy.' },
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
            await this.router.routeObservation({
                tenantId,
                sessionId: s.sessionId,
                agentId: recipientAgentId,
                observation: obs,
            });
            const activateParams: ConversationActivateParams = {
                kind: 'thread',
                tenantId,
                threadId: topic.id,
                routingSessionId: s.sessionId,
                recipientAgentId,
                messageId,
                senderSessionId,
                senderAgentId: message.senderAgentId,
            };
            await this.deps.activateConversationRecipient(activateParams);
            accepted.push({
                memberId: recipientMemberId,
                recipientAgentId,
                sessionId: s.sessionId,
                messageId,
                sequenceNumber,
                dedupeHit: false,
                correlationId: message.correlationId,
            });
        }

        const outboundObs = {
            source: 'conversation',
            payload: {
                kind: 'outbound.committed',
                ref: topic,
                messageId,
                sequenceNumber,
                correlationId: message.correlationId,
                deliveries: accepted,
            },
        } as Observation;
        await this.router.routeObservation({
            tenantId,
            sessionId: senderSeat.sessionId,
            agentId: senderAgentId,
            observation: outboundObs,
        });

        if (accepted.length > 0 && rejected.length === 0) {
            return { status: 'accepted', topic, deliveries: accepted };
        }
        if (accepted.length > 0 && rejected.length > 0) {
            return { status: 'partial', topic, accepted, rejected };
        }
        return {
            status: 'rejected',
            topic,
            error: { type: 'ThreadBusy', message: 'No recipients could accept delivery.' },
        };
    }

    async close(
        tenantId: string,
        _senderSessionId: string,
        senderAgentId: string,
        ref: ConversationRef,
        options?: CloseConversationOptions
    ): Promise<CloseConversationReceipt> {
        if (options?.archiveAfter === true && ref.kind === 'topic') {
            throw new Error('ArchiveUnsupportedForTopics');
        }
        if (ref.kind === 'thread') {
            const row = await this.sessionManager.getConversationThread({
                tenantId,
                conversationId: ref.id,
            });
            if (!row) {
                throw new Error('CONVERSATION_THREAD_NOT_FOUND');
            }
            if (row.status === 'archived') {
                throw new Error('ConversationClosed');
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
                    return { ref, closed: true, archived: true };
                }
                return { ref, closed: true };
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
                return { ref, closed: true, archived: true };
            }
            return { ref, closed: true };
        }
        await this.sessionManager.updateConversationTopic({
            tenantId,
            conversationId: ref.id,
            patch: { status: 'closed' },
        });
        const ts = new Date().toISOString();
        const obs = {
            source: 'conversation',
            payload: {
                kind: 'topic.closed',
                topic: ref,
                ts,
            },
        } as Observation;
        const active = await this.sessionManager.listConversationTopicMembers({
            tenantId,
            conversationId: ref.id,
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
        return { ref, closed: true };
    }

    async archive(
        tenantId: string,
        _senderSessionId: string,
        senderAgentId: string,
        ref: ThreadRef,
        options?: ArchiveConversationOptions
    ): Promise<ArchiveConversationReceipt> {
        const row = await this.sessionManager.getConversationThread({
            tenantId,
            conversationId: ref.id,
        });
        if (!row) {
            throw new Error('CONVERSATION_THREAD_NOT_FOUND');
        }
        if (row.status === 'open') {
            throw new Error('ThreadNotClosed');
        }
        if (row.status === 'archived') {
            return { ref, archived: true };
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
        return { ref, archived: true };
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
}
