import { v7 as uuidv7 } from 'uuid';
import type { SessionManager } from '../../orchestration/SessionManager.js';
import type { InternalConversationApi, ConversationServiceDeps, ConversationActivateParams } from './types.js';
import type {
    CloseConversationOptions,
    CloseConversationReceipt,
    OutboundThreadMessage,
    SendOptions,
    SendReceipt,
    StartThreadOptions,
    StartThreadReceipt,
    ThreadRef,
} from '../../public-types/conversation/types.js';
import type { Observation } from '../../types/observation.js';
import { ConversationRouter } from './ConversationRouter.js';

const MAX_QUEUE_DEPTH = 32;

type QueueState = {
    byThread: Map<string, number>;
};

export class ConversationService implements InternalConversationApi {
    private readonly router: ConversationRouter;
    private readonly queueState: QueueState = {
        byThread: new Map<string, number>(),
    };

    constructor(
        private readonly sessionManager: SessionManager,
        private readonly deps: ConversationServiceDeps
    ) {
        this.router = new ConversationRouter(sessionManager);
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
                error: { type: 'ThreadClosed', message: 'Conversation thread is closed.' },
            };
        }

        const dedupeKey = options?.idempotencyKey;
        if (dedupeKey) {
            const existing = await this.sessionManager.findConversationMessageByIdempotencyKey({
                tenantId,
                conversationId: thread.id,
                senderAgentId: message.senderAgentId,
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
            recipientAgentId: message.recipientAgentId,
            speechAct: message.speechAct,
            payload: { content: message.content },
            correlationId: message.correlationId,
            idempotencyKey: dedupeKey,
        });

        const observation: Observation = {
            source: 'conversation',
            kind: 'message.received',
            payload: {
                kind: 'message.received',
                message: {
                    id: appended.messageId,
                    conversation: thread,
                    senderAgentId: appended.senderAgentId,
                    recipientAgentId: appended.recipientAgentId,
                    speechAct: message.speechAct,
                    content: appended.payload.content,
                    sequenceNumber: appended.sequenceNumber,
                    correlationId: appended.correlationId,
                    idempotencyKey: appended.idempotencyKey,
                    ts: appended.createdAt,
                },
            },
        };
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

    async close(
        tenantId: string,
        thread: ThreadRef,
        _options?: CloseConversationOptions
    ): Promise<CloseConversationReceipt> {
        await this.sessionManager.updateConversationThreadStatus({
            tenantId,
            conversationId: thread.id,
            status: 'closed',
        });
        return {
            thread,
            closed: true,
        };
    }
}

