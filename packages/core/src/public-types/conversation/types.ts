import type { z } from 'zod';
import type {
    CloseConversationOptionsSchema,
    CloseConversationReceiptSchema,
    ConversationErrorSchema,
    ConversationRefSchema,
    InboundMessageSchema,
    OutboundThreadMessageSchema,
    SendOptionsSchema,
    SendReceiptSchema,
    StartThreadOptionsSchema,
    StartThreadReceiptSchema,
    ThreadRefSchema,
    ConversationIdSchema,
    MessageIdSchema,
    CorrelationIdSchema,
    IdempotencyKeySchema,
    AgentIdSchema,
} from './schemas.js';

export type ConversationId = z.infer<typeof ConversationIdSchema>;
export type MessageId = z.infer<typeof MessageIdSchema>;
export type CorrelationId = z.infer<typeof CorrelationIdSchema>;
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;
export type AgentId = z.infer<typeof AgentIdSchema>;

export type ThreadRef = z.infer<typeof ThreadRefSchema>;
export type ConversationRef = z.infer<typeof ConversationRefSchema>;
export type ConversationError = z.infer<typeof ConversationErrorSchema>;

export type OutboundThreadMessage = z.infer<typeof OutboundThreadMessageSchema>;
export type InboundMessage = z.infer<typeof InboundMessageSchema>;
export type SendReceipt = z.infer<typeof SendReceiptSchema>;

export type StartThreadOptions = z.infer<typeof StartThreadOptionsSchema>;
export type SendOptions = z.infer<typeof SendOptionsSchema>;
export type CloseConversationOptions = z.infer<typeof CloseConversationOptionsSchema>;

export type StartThreadReceipt = z.infer<typeof StartThreadReceiptSchema>;
export type CloseConversationReceipt = z.infer<typeof CloseConversationReceiptSchema>;

export type ConversationApi = {
    startThread: (options: StartThreadOptions) => Promise<StartThreadReceipt>;
    send: (
        thread: ThreadRef,
        message: OutboundThreadMessage,
        options?: SendOptions
    ) => Promise<SendReceipt>;
    close: (
        thread: ThreadRef,
        options?: CloseConversationOptions
    ) => Promise<CloseConversationReceipt>;
};

