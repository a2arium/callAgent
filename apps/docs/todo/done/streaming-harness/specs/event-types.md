# Event Type Catalog

This catalog is a draft closed vocabulary. Production implementation must define
these events as Zod schemas and infer TypeScript types from those schemas.

## Public Events

| Type | Purpose |
|---|---|
| `task.status` | Task lifecycle state. |
| `artifact.delta` | Incremental or replacement artifact content. |
| `artifact.done` | Artifact is complete. |
| `input.required` | Agent needs user input. |
| `message.output` | Optional normalized user-facing message projection. |

## Debug Events

| Type | Purpose |
|---|---|
| `llm.started` | LLM inference began. |
| `llm.delta` | LLM token/chunk generated. |
| `llm.completed` | LLM inference completed. |
| `tool.started` | Tool execution began. |
| `tool.completed` | Tool execution completed. |
| `child.started` | Child/subagent task began. |
| `child.message` | Child emitted user-visible output. |
| `child.completed` | Child/subagent task completed. |
| `conversation.message.sent` | Conversation message sent. |
| `conversation.message.received` | Conversation message received. |
| `goal.changed` | Goal added/updated/completed/failed. |
| `thought.added` | Thought added. |
| `decision.added` | Decision recorded. |
| `trace.summary` | Compact turn trace summary. |

## Private Events

Private events are implementation-specific and must not be sent to clients by
default. Examples include raw tool args, raw prompts, full thoughts, raw memory,
and unredacted traces.

## Payload Schema Draft

```ts
import { z } from 'zod';
import { RuntimeStreamEnvelopeBaseSchema } from './runtime-event-envelope';

const TextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  format: z.enum(['plain', 'markdown', 'html']).optional(),
}).strict();

const DataPartSchema = z.object({
  type: z.literal('data'),
  data: z.unknown(),
}).strict();

const MediaPartSchema = z.object({
  type: z.enum(['image', 'file', 'audio', 'video']),
  url: z.string().url().optional(),
  bytesBase64: z.string().optional(),
  mime: z.string().optional(),
  filename: z.string().optional(),
  caption: z.string().optional(),
}).strict();

const MarkupPartSchema = z.object({
  type: z.literal('markup'),
  value: z.unknown(),
}).strict();

const MessagePartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  DataPartSchema,
  MediaPartSchema,
  MarkupPartSchema,
]);

const TaskStateSchema = z.enum([
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
    state: TaskStateSchema,
    terminal: z.boolean(),
    message: z.object({
      role: z.string(),
      parts: z.array(MessagePartSchema),
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
    parts: z.array(MessagePartSchema),
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
    parts: z.array(MessagePartSchema),
    schemaRef: z.string().optional(),
    expiresAt: z.string().datetime().optional(),
  }).strict(),
}).strict();

const MessageOutputEventSchema = RuntimeStreamEnvelopeBaseSchema.extend({
  type: z.literal('message.output'),
  visibility: z.literal('public'),
  data: z.object({
    messageId: z.string().min(1).optional(),
    parts: z.array(MessagePartSchema),
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
    parts: z.array(MessagePartSchema),
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
```

## Schema Rules

- The final implementation must not export hand-written duplicate event types.
- Each event variant must use a literal `type`.
- `task.status.data.terminal` is the only field that controls stream closure.
- Debug/private events must remain filterable by `visibility`.
