import { v7 as uuidv7 } from 'uuid';
import type { SessionManager } from '../../orchestration/SessionManager.js';
import type {
    InternalConversationApi,
    ConversationServiceDeps,
    ConversationActivateParams,
} from './types.js';
import type {
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
    TopicLeaveOptions,
    TopicLeaveReceipt,
    TopicPostOptions,
    TopicRef,
    ConversationRef,
    TopicSelector,
    DeliverySummary,
} from '../../public-types/conversation/types.js';
import type { Observation } from '../../types/observation.js';
import { MAX_TOPIC_MEMBERS, MemberIdSchema } from '../../public-types/conversation/schemas.js';
import type { TopicMember } from '../../public-types/conversation/types.js';
import { ConversationRouter } from './ConversationRouter.js';
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

type QueueState = {
    byThread: Map<string, number>;
    byTopic: Map<string, number>;
};

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
    private readonly queueState: QueueState = {
        byThread: new Map(),
        byTopic: new Map(),
    };

    constructor(
        private readonly sessionManager: SessionManager,
        private readonly deps: ConversationServiceDeps
    ) {
        this.router = new ConversationRouter(sessionManager);
    }

    private async sessionInflight(tenantId: string, sessionId: string): Promise<boolean> {
        const loaded = await this.sessionManager.load(tenantId, sessionId);
        const base = (loaded?.snapshot as Record<string, unknown>) ?? {};
        return isInflightSnapshot(base);
    }

    async startThread(
        tenantId: string,
        senderSessionId: string,
        senderAgentId: string,
        options: StartThreadOptions
    ): Promise<StartThreadReceipt> {
        const threadId = options.conversationId ?? (`thread-${uuidv7()}` as ThreadRef['id']);
        const thread: ThreadRef = { kind: 'thread', id: threadId };
        await this.sessionManager.createConversationThread({
            tenantId,
            conversationId: thread.id,
            ownerAgentId: senderAgentId,
            participantAgentId: options.targetAgentId,
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
            }
        );
        return { thread, receipt: sendReceipt };
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
            return {
                status: 'rejected',
                thread,
                error: { type: 'ConversationClosed', message: 'Conversation thread is closed.' },
            };
        }

        const dedupeKey = options?.idempotencyKey;
        if (dedupeKey) {
            const existing = await this.sessionManager.findConversationMessageByIdempotencyKey({
                tenantId,
                conversationId: thread.id,
                senderMemberId: message.senderAgentId,
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

        const messageId = `msg-${uuidv7()}`;
        const appended = await this.sessionManager.appendConversationMessage({
            tenantId,
            conversationId: thread.id,
            messageId,
            senderAgentId: message.senderAgentId,
            senderMemberId: message.senderAgentId,
            recipientAgentId: message.recipientAgentId,
            conversationKind: 'thread',
            selectorKind: null,
            speechAct: message.speechAct,
            payload: { content: message.content },
            correlationId: message.correlationId,
            idempotencyKey: dedupeKey,
        });

        const observation = {
            source: 'conversation',
            payload: {
                kind: 'message.received',
                message: {
                    id: appended.messageId,
                    conversation: thread,
                    senderAgentId: appended.senderAgentId,
                    recipientAgentId: message.recipientAgentId,
                    recipientMemberId: MemberIdSchema.parse(message.recipientAgentId),
                    speechAct: message.speechAct,
                    content: appended.payload.content,
                    sequenceNumber: appended.sequenceNumber,
                    correlationId: appended.correlationId,
                    idempotencyKey: appended.idempotencyKey,
                    ts: appended.createdAt,
                },
            },
        } as Observation;
        await this.router.routeObservation({
            tenantId: target.tenantId,
            sessionId: target.sessionId,
            agentId: target.agentId,
            observation,
        });

        const activateParams: ConversationActivateParams = {
            tenantId,
            threadId: thread.id,
            routingSessionId: target.sessionId,
            recipientAgentId: message.recipientAgentId,
            messageId: appended.messageId,
            senderSessionId,
            senderAgentId: message.senderAgentId,
        };
        await this.deps.activateConversationRecipient(activateParams);

        return {
            status: 'accepted',
            thread,
            messageId: appended.messageId,
            sequenceNumber: appended.sequenceNumber,
            dedupeHit: false,
            correlationId: appended.correlationId,
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
        _senderSessionId: string,
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
        const token = `inv-${uuidv7()}`;
        const issuedAt = new Date().toISOString();
        await this.sessionManager.issueConversationTopicInvite({
            tenantId,
            conversationId: options.topic.id,
            token,
            inviteeAgentId: options.invitee.agentId,
            inviteeMemberId,
            role: options.invitee.role,
            sessionIdOverride: options.invitee.sessionIdOverride ?? null,
            issuedAt,
        });
        return { status: 'ok', token };
    }

    async join(
        tenantId: string,
        _senderSessionId: string,
        senderAgentId: string,
        topic: TopicRef,
        options: TopicJoinOptions
    ): Promise<TopicJoinReceipt> {
        const consumed = await this.sessionManager.consumeConversationTopicInvite({
            tenantId,
            token: options.inviteToken,
            consumedAt: new Date().toISOString(),
        });
        if (!consumed) {
            return { status: 'rejected', error: { type: 'InviteInvalid', message: 'Invalid or used invite.' } };
        }
        if (consumed.inviteeAgentId !== senderAgentId) {
            return { status: 'rejected', error: { type: 'InviteInvalid', message: 'Invite not for this agent.' } };
        }
        if (consumed.conversationId !== topic.id) {
            return { status: 'rejected', error: { type: 'InviteInvalid', message: 'Topic mismatch.' } };
        }
        const memberIdStr = consumed.inviteeMemberId;
        const sessionId = consumed.sessionIdOverride ?? `topic-${topic.id}:${memberIdStr}`;
        const registeredAt = new Date().toISOString();
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
            const existing = await this.sessionManager.findConversationMessageByIdempotencyKey({
                tenantId,
                conversationId: topic.id,
                senderMemberId: senderMemberIdResolved,
                idempotencyKey: dedupeKey,
            });
            if (existing) {
                const deliveries = await this.sessionManager.listConversationMessageDeliveries({
                    tenantId,
                    conversationId: topic.id,
                    sequenceNumber: existing.sequenceNumber,
                });
                return reconstructFanoutReceiptFromDeliveries(topic, existing, deliveries);
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

        const messageId = `msg-${uuidv7()}`;
        const appended = await this.sessionManager.appendConversationMessage({
            tenantId,
            conversationId: topic.id,
            messageId,
            senderAgentId: message.senderAgentId,
            senderMemberId: senderMemberIdResolved,
            recipientAgentId: null,
            conversationKind: 'topic',
            selectorKind: baseSelector.kind,
            speechAct: message.speechAct,
            payload: { content: message.content },
            correlationId: message.correlationId,
            idempotencyKey: dedupeKey,
        });

        const selectorUsed: TopicSelector = baseSelector;
        const inboundBase = {
            id: appended.messageId,
            conversation: topic,
            senderAgentId: appended.senderAgentId,
            speechAct: message.speechAct,
            content: appended.payload.content,
            sequenceNumber: appended.sequenceNumber,
            correlationId: appended.correlationId,
            idempotencyKey: appended.idempotencyKey,
            ts: appended.createdAt,
        };

        const accepted: DeliverySummary[] = [];
        const rejected: Array<{ memberId: MemberId; recipientAgentId: string; error: ConversationError }> = [];

        const deliveryRows: Array<{
            memberId: string;
            recipientAgentId: string;
            sessionId: string;
            dedupeHit: boolean;
            status: 'delivered' | 'rejected' | 'queued';
            error: Record<string, unknown> | null;
            queuePosition: number | null;
        }> = [];

        for (const s of scans) {
            if (s.outcome === 'queue') {
                deliveryRows.push({
                    memberId: s.memberId,
                    recipientAgentId: s.agentId,
                    sessionId: s.sessionId,
                    dedupeHit: false,
                    status: 'queued',
                    error: null,
                    queuePosition: (this.queueState.byTopic.get(topic.id) ?? 0) + 1,
                });
                rejected.push({
                    memberId: MemberIdSchema.parse(s.memberId),
                    recipientAgentId: s.agentId,
                    error: { type: 'ThreadBusy', message: 'Recipient session busy.' },
                });
                continue;
            }
            if (s.outcome === 'reject') {
                deliveryRows.push({
                    memberId: s.memberId,
                    recipientAgentId: s.agentId,
                    sessionId: s.sessionId,
                    dedupeHit: false,
                    status: 'rejected',
                    error: { type: 'ThreadBusy', message: 'Recipient session busy.' },
                    queuePosition: null,
                });
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
                tenantId,
                threadId: topic.id,
                routingSessionId: s.sessionId,
                recipientAgentId,
                messageId: appended.messageId,
                senderSessionId,
                senderAgentId: message.senderAgentId,
            };
            await this.deps.activateConversationRecipient(activateParams);
            accepted.push({
                memberId: recipientMemberId,
                recipientAgentId,
                sessionId: s.sessionId,
                messageId: appended.messageId,
                sequenceNumber: appended.sequenceNumber,
                dedupeHit: false,
                correlationId: message.correlationId,
            });
            deliveryRows.push({
                memberId: s.memberId,
                recipientAgentId,
                sessionId: s.sessionId,
                dedupeHit: false,
                status: 'delivered',
                error: null,
                queuePosition: null,
            });
        }

        await this.sessionManager.recordConversationMessageDeliveries({
            tenantId,
            conversationId: topic.id,
            sequenceNumber: appended.sequenceNumber,
            rows: deliveryRows,
        });

        const outboundObs = {
            source: 'conversation',
            payload: {
                kind: 'outbound.committed',
                ref: topic,
                messageId: appended.messageId,
                sequenceNumber: appended.sequenceNumber,
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
        _senderAgentId: string,
        ref: ConversationRef,
        _options?: CloseConversationOptions
    ): Promise<CloseConversationReceipt> {
        if (ref.kind === 'thread') {
            await this.sessionManager.updateConversationThreadStatus({
                tenantId,
                conversationId: ref.id,
                status: 'closed',
            });
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
}
