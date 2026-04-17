import type {
    MessageLogAppendParams,
    MessageLogAppendResult,
    MessageLogDelivery,
    MessageLogFindByIdempotencyParams,
    MessageLogReadParams,
    MessageLogRecord,
} from './schemas.js';

export type {
    MessageLogAppendParams,
    MessageLogAppendResult,
    MessageLogDelivery,
    MessageLogFindByIdempotencyParams,
    MessageLogReadParams,
    MessageLogRecord,
};

export type MessageLog = {
    append(params: MessageLogAppendParams): Promise<MessageLogAppendResult>;
    read(params: MessageLogReadParams): Promise<ReadonlyArray<MessageLogRecord>>;
    replay(params: MessageLogReadParams): AsyncIterable<MessageLogRecord>;
    findByIdempotency(params: MessageLogFindByIdempotencyParams): Promise<MessageLogRecord | null>;
};
