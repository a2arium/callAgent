import type { TaskInput } from '../../shared/types/index.js';
import type { InternalConversationApi } from '../../internal/conversation/types.js';
import type { ThreadRef } from '../../public-types/conversation/types.js';

export type ConversationBootstrapStamp = {
    thread: ThreadRef;
    messageId: string;
    sequenceNumber: number;
};

/**
 * Persists the initial thread message (or follow-up send) before `A2AService` runs the child,
 * so `conversation_messages` and inbox observations exist. Uses `skipRecipientActivation` so the
 * child is executed once via A2A (`startTask`), not twice via cold activation.
 */
export async function bootstrapConversationForSendTaskToAgent(params: {
    conversationService: InternalConversationApi;
    tenantId: string;
    senderSessionId: string;
    senderAgentId: string;
    targetAgent: string;
    taskInput: TaskInput;
    idempotencyKey: string;
    conversation?: ThreadRef;
}): Promise<ConversationBootstrapStamp> {
    const {
        conversationService,
        tenantId,
        senderSessionId,
        senderAgentId,
        targetAgent,
        taskInput,
        idempotencyKey,
        conversation,
    } = params;
    const messageBase = {
        senderAgentId,
        speechAct: 'request' as const,
        content: taskInput as unknown,
    };
    if (conversation) {
        const receipt = await conversationService.send(
            tenantId,
            senderSessionId,
            conversation,
            {
                ...messageBase,
                recipientAgentId: targetAgent,
            },
            { idempotencyKey, skipRecipientActivation: true }
        );
        if (receipt.status !== 'accepted') {
            const err =
                receipt.status === 'rejected' && 'error' in receipt
                    ? (receipt as { error: { message?: string } }).error?.message
                    : receipt.status;
            throw new Error(`Conversation send rejected: ${String(err)}`);
        }
        return {
            thread: conversation,
            messageId: receipt.messageId,
            sequenceNumber: receipt.sequenceNumber,
        };
    }
    const started = await conversationService.startThread(tenantId, senderSessionId, senderAgentId, {
        targetAgentId: targetAgent,
        message: {
            ...messageBase,
            recipientAgentId: targetAgent,
        },
        idempotencyKey,
        skipRecipientActivation: true,
    });
    const sr = started.receipt;
    if (sr.status !== 'accepted') {
        const err =
            sr.status === 'rejected' && 'error' in sr
                ? (sr as { error: { message?: string } }).error?.message
                : sr.status;
        throw new Error(`Conversation startThread rejected: ${String(err)}`);
    }
    return {
        thread: started.thread,
        messageId: sr.messageId,
        sequenceNumber: sr.sequenceNumber,
    };
}
