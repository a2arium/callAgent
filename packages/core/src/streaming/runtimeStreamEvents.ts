import { z } from 'zod';

export const RUNTIME_STREAM_EVENT_VERSION = '2026-05-02' as const;

export const StreamVisibilitySchema = z.enum(['public', 'debug', 'private']);
export const StreamChannelSchema = z.enum(['user', 'debug', 'telemetry']);

export const RuntimeStreamEnvelopeBaseSchema = z.object({
    version: z.literal(RUNTIME_STREAM_EVENT_VERSION),
    id: z.string().min(1),
    seq: z.number().int().nonnegative(),
    taskId: z.string().min(1),
    tenantId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    parentTaskId: z.string().min(1).optional(),
    traceId: z.string().min(1).optional(),
    spanId: z.string().min(1).optional(),
    ts: z.string().datetime(),
    visibility: StreamVisibilitySchema,
    channel: StreamChannelSchema.optional(),
}).strict();

const TextPartSchema = z.object({
    type: z.literal('text'),
    text: z.string(),
    format: z.enum(['plain', 'markdown', 'html']).optional(),
}).strict();

const DataPartSchema = z.object({
    type: z.literal('data'),
    data: z.unknown(),
}).strict();

const ImagePartSchema = z.object({
    type: z.literal('image'),
    url: z.string().url().optional(),
    bytesBase64: z.string().optional(),
    mime: z.string().optional(),
    filename: z.string().optional(),
    caption: z.string().optional(),
}).strict();

const FilePartSchema = ImagePartSchema.extend({ type: z.literal('file') }).strict();
const AudioPartSchema = ImagePartSchema.extend({ type: z.literal('audio') }).strict();
const VideoPartSchema = ImagePartSchema.extend({ type: z.literal('video') }).strict();

const MarkupPartSchema = z.object({
    type: z.literal('markup'),
    value: z.unknown(),
}).strict();

export const RuntimeStreamMessagePartSchema = z.discriminatedUnion('type', [
    TextPartSchema,
    DataPartSchema,
    ImagePartSchema,
    FilePartSchema,
    AudioPartSchema,
    VideoPartSchema,
    MarkupPartSchema,
]);

export const RuntimeStreamTaskStateSchema = z.enum([
    'submitted',
    'working',
    'input-required',
    'completed',
    'canceled',
    'failed',
    'unknown',
]);

const TaskStatusEventSchema = RuntimeStreamEnvelopeBaseSchema.extend({
    type: z.literal('task.status'),
    visibility: z.literal('public'),
    data: z.object({
        state: RuntimeStreamTaskStateSchema,
        terminal: z.boolean(),
        message: z.object({
            role: z.string(),
            parts: z.array(RuntimeStreamMessagePartSchema),
        }).strict().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
    }).strict(),
}).strict();

const ArtifactDeltaEventSchema = RuntimeStreamEnvelopeBaseSchema.extend({
    type: z.literal('artifact.delta'),
    visibility: z.literal('public'),
    data: z.object({
        artifactId: z.string().min(1),
        name: z.string().optional(),
        index: z.number().int().nonnegative(),
        append: z.boolean(),
        parts: z.array(RuntimeStreamMessagePartSchema),
    }).strict(),
}).strict();

const ArtifactDoneEventSchema = RuntimeStreamEnvelopeBaseSchema.extend({
    type: z.literal('artifact.done'),
    visibility: z.literal('public'),
    data: z.object({
        artifactId: z.string().min(1),
        index: z.number().int().nonnegative(),
    }).strict(),
}).strict();

const InputRequiredEventSchema = RuntimeStreamEnvelopeBaseSchema.extend({
    type: z.literal('input.required'),
    visibility: z.literal('public'),
    data: z.object({
        token: z.string().min(1),
        parts: z.array(RuntimeStreamMessagePartSchema),
        schemaRef: z.string().optional(),
        expiresAt: z.string().datetime().optional(),
    }).strict(),
}).strict();

const MessageOutputEventSchema = RuntimeStreamEnvelopeBaseSchema.extend({
    type: z.literal('message.output'),
    visibility: z.literal('public'),
    data: z.object({
        messageId: z.string().min(1).optional(),
        parts: z.array(RuntimeStreamMessagePartSchema),
    }).strict(),
}).strict();

const LlmStartedEventSchema = RuntimeStreamEnvelopeBaseSchema.extend({
    type: z.literal('llm.started'),
    visibility: z.literal('debug'),
    data: z.object({
        callId: z.string().min(1),
        provider: z.string().optional(),
        model: z.string().optional(),
        module: z.string().optional(),
    }).strict(),
}).strict();

const LlmDeltaEventSchema = RuntimeStreamEnvelopeBaseSchema.extend({
    type: z.literal('llm.delta'),
    visibility: z.enum(['public', 'debug']),
    data: z.object({
        callId: z.string().min(1),
        content: z.string().optional(),
        contentObjectDelta: z.unknown().optional(),
    }).strict(),
}).strict();

const LlmCompletedEventSchema = RuntimeStreamEnvelopeBaseSchema.extend({
    type: z.literal('llm.completed'),
    visibility: z.literal('debug'),
    data: z.object({
        callId: z.string().min(1),
        status: z.enum(['completed', 'failed']),
        usage: z.object({
            cost: z.number().nonnegative().optional(),
            inputTokens: z.number().int().nonnegative().optional(),
            outputTokens: z.number().int().nonnegative().optional(),
        }).strict().optional(),
        error: z.object({
            code: z.string().optional(),
            message: z.string(),
        }).strict().optional(),
    }).strict(),
}).strict();

const ToolStartedEventSchema = RuntimeStreamEnvelopeBaseSchema.extend({
    type: z.literal('tool.started'),
    visibility: z.literal('debug'),
    data: z.object({
        token: z.string().min(1),
        toolName: z.string().min(1),
        argsPreview: z.unknown().optional(),
    }).strict(),
}).strict();

const ToolCompletedEventSchema = RuntimeStreamEnvelopeBaseSchema.extend({
    type: z.literal('tool.completed'),
    visibility: z.literal('debug'),
    data: z.object({
        token: z.string().min(1),
        toolName: z.string().min(1),
        status: z.enum(['completed', 'failed']),
        resultPreview: z.unknown().optional(),
        error: z.object({
            code: z.string().optional(),
            message: z.string(),
        }).strict().optional(),
    }).strict(),
}).strict();

const ChildStartedEventSchema = RuntimeStreamEnvelopeBaseSchema.extend({
    type: z.literal('child.started'),
    visibility: z.literal('debug'),
    data: z.object({
        token: z.string().min(1),
        agentId: z.string().min(1),
        childTaskId: z.string().min(1).optional(),
    }).strict(),
}).strict();

const ChildMessageEventSchema = RuntimeStreamEnvelopeBaseSchema.extend({
    type: z.literal('child.message'),
    visibility: z.enum(['public', 'debug']),
    data: z.object({
        token: z.string().min(1).optional(),
        agentId: z.string().min(1),
        childTaskId: z.string().min(1).optional(),
        parts: z.array(RuntimeStreamMessagePartSchema),
    }).strict(),
}).strict();

const ChildCompletedEventSchema = RuntimeStreamEnvelopeBaseSchema.extend({
    type: z.literal('child.completed'),
    visibility: z.literal('debug'),
    data: z.object({
        token: z.string().min(1),
        agentId: z.string().min(1),
        childTaskId: z.string().min(1).optional(),
        status: z.enum(['completed', 'failed']),
        resultPreview: z.unknown().optional(),
        error: z.object({
            code: z.string().optional(),
            message: z.string(),
        }).strict().optional(),
    }).strict(),
}).strict();

const ConversationMessageSentEventSchema = RuntimeStreamEnvelopeBaseSchema.extend({
    type: z.literal('conversation.message.sent'),
    visibility: z.literal('debug'),
    data: z.object({
        conversationId: z.string().min(1),
        kind: z.enum(['thread', 'topic']).optional(),
        messageId: z.string().min(1).optional(),
        senderAgentId: z.string().min(1).optional(),
        recipientAgentId: z.string().min(1).optional(),
        speechAct: z.string().optional(),
        sequenceNumber: z.number().int().nonnegative().optional(),
    }).strict(),
}).strict();

const ConversationMessageReceivedEventSchema = RuntimeStreamEnvelopeBaseSchema.extend({
    type: z.literal('conversation.message.received'),
    visibility: z.literal('debug'),
    data: z.object({
        conversationId: z.string().min(1),
        kind: z.enum(['thread', 'topic']).optional(),
        messageId: z.string().min(1).optional(),
        senderAgentId: z.string().min(1).optional(),
        recipientAgentId: z.string().min(1).optional(),
        speechAct: z.string().optional(),
        sequenceNumber: z.number().int().nonnegative().optional(),
    }).strict(),
}).strict();

const GoalChangedEventSchema = RuntimeStreamEnvelopeBaseSchema.extend({
    type: z.literal('goal.changed'),
    visibility: z.enum(['debug', 'private']),
    data: z.object({
        op: z.enum(['added', 'updated', 'completed', 'failed', 'removed']),
        goalId: z.string().min(1),
        titlePreview: z.string().optional(),
    }).strict(),
}).strict();

const ThoughtAddedEventSchema = RuntimeStreamEnvelopeBaseSchema.extend({
    type: z.literal('thought.added'),
    visibility: z.enum(['debug', 'private']),
    data: z.object({
        thoughtId: z.string().min(1).optional(),
        preview: z.string().optional(),
    }).strict(),
}).strict();

const DecisionAddedEventSchema = RuntimeStreamEnvelopeBaseSchema.extend({
    type: z.literal('decision.added'),
    visibility: z.enum(['debug', 'private']),
    data: z.object({
        key: z.string().min(1),
        valuePreview: z.unknown().optional(),
        reasoningPreview: z.string().optional(),
    }).strict(),
}).strict();

const TraceSummaryEventSchema = RuntimeStreamEnvelopeBaseSchema.extend({
    type: z.literal('trace.summary'),
    visibility: z.literal('debug'),
    data: z.object({
        turn: z.number().int().nonnegative(),
        intentKind: z.string().optional(),
        transitionKind: z.string().optional(),
        pendingSummary: z.record(z.string(), z.unknown()).optional(),
        llmCalls: z.number().int().nonnegative().optional(),
        toolCalls: z.number().int().nonnegative().optional(),
        childCalls: z.number().int().nonnegative().optional(),
    }).strict(),
}).strict();

export const RuntimeStreamEventSchema = z.discriminatedUnion('type', [
    TaskStatusEventSchema,
    ArtifactDeltaEventSchema,
    ArtifactDoneEventSchema,
    InputRequiredEventSchema,
    MessageOutputEventSchema,
    LlmStartedEventSchema,
    LlmDeltaEventSchema,
    LlmCompletedEventSchema,
    ToolStartedEventSchema,
    ToolCompletedEventSchema,
    ChildStartedEventSchema,
    ChildMessageEventSchema,
    ChildCompletedEventSchema,
    ConversationMessageSentEventSchema,
    ConversationMessageReceivedEventSchema,
    GoalChangedEventSchema,
    ThoughtAddedEventSchema,
    DecisionAddedEventSchema,
    TraceSummaryEventSchema,
]);

export type RuntimeStreamEvent = z.infer<typeof RuntimeStreamEventSchema>;
export type RuntimeStreamMessagePart = z.infer<typeof RuntimeStreamMessagePartSchema>;
export type RuntimeStreamTaskState = z.infer<typeof RuntimeStreamTaskStateSchema>;
export type RuntimeStreamVisibility = z.infer<typeof StreamVisibilitySchema>;
export type RuntimeStreamChannel = z.infer<typeof StreamChannelSchema>;
export type RuntimeStreamTaskStatusEvent = Extract<RuntimeStreamEvent, { type: 'task.status' }>;

export function isTerminalRuntimeStreamStatus(event: RuntimeStreamEvent): event is RuntimeStreamTaskStatusEvent {
    return (
        event.type === 'task.status' &&
        event.data.terminal === true &&
        (event.data.state === 'completed' || event.data.state === 'failed' || event.data.state === 'canceled')
    );
}
