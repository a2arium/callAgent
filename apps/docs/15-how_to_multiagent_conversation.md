# How-to: Multi-agent Conversation

Use this guide when two or more agents need to exchange messages durably — as a **1:1 thread**, a **broadcast topic**, or a **moderated panel with custom turn-taking and shared state**.

The feature surface covered here landed across phases **5.1 → 5.4** (all except the Kafka adapter). This is the canonical developer reference for building conversation-driven agents. See also: [Child-agent await and resume](./6-how_to_child_agent_await_and_resume_aplret.md), [Test APLRET agents](./11-how_to_test_aplret_agents.md), [Debug with TurnTrace](./12-how_to_debug_with_turn_trace.md).

**Package:** all conversation types, helpers, and APIs are exported from **`@a2arium/callagent-core`**. NATS transport is the optional **`@a2arium/callagent-eventbus-nats`** package.

---

## Goal

- Pick the right primitive (**thread** vs **topic**) for your scenario.
- Open, maintain, close, and archive conversations correctly.
- Deliver messages with the right **selector** (broadcast / round-robin / explicit / custom policy).
- Wire **stop policies**, **invites**, **shared projections**, and **manifest capabilities**.
- Keep every conversation effect inside Execution and make every received message flow through the canonical APLRET pipeline.
- Scale from in-process (default) to **cross-runtime NATS** without changing agent code.

## The one rule

**Conversation calls are effects. Effects belong in Execution.**

Policy may **decide** to post a message; Policy never calls `ctx.conversation.*`. Every inbound message enters cognition as an observation on `env.inbox.current` and is interpreted by **Perception → Learning → MentalState → Policy** on the next turn. This is APLRET Rule 3 (Single Effect Boundary) and Rule 5 (Sync, M-only Policy). See [How to keep Policy pure](./3-how_to_keep_policy_pure.md).

---

## Concepts at a glance

| Primitive | What it is | When to use |
|-----------|-----------|-------------|
| **Thread** (`ThreadRef`) | 1:1, ordered, durable exchange between exactly **two** agents. | Request/response, clarifying Q&A, long-running dialogs with one peer, `sendTaskToAgent` delegation reuse. |
| **Topic** (`TopicRef`) | N-member room with per-message **selector** (who receives), typed **stop policies**, **invites**, and **shared projections**. | Panels, debate, multi-specialist review, broadcast signals, any interaction with ≥ 3 distinct speakers or a rotating speaker role. |
| **ConversationRef** | Discriminated union `ThreadRef \| TopicRef` used by lifecycle APIs (`close`, `archive`). | Anywhere that should accept either kind. |

| Concept | Purpose |
|---------|---------|
| **`agentId`** | Identity of a deployed agent runtime. 1:1 with manifest `name`. |
| **`MemberId`** | A **seat** inside a topic. Multiple seats can map to the same `agentId` (multi-seat panels). Created via `memberId(string)` or framework-generated. |
| **Speech act** | Closed enum on every message: `question \| answer \| inform \| request \| task \| followup \| signal \| vote \| system`. |
| **Signal kind** | Closed sub-vocabulary used when `speechAct: 'signal'` is appended — e.g. `topic.backpressure.changed`. Use `x-...` namespace for custom signals. |
| **Selector** | Per-post recipient rule: `broadcast \| round_robin \| explicit_recipient \| selector_policy`. |
| **Stop policy** | Rule evaluated after each append that can close the topic: `maxTurns \| maxRounds \| timeout \| signalBased \| custom`. |
| **Projection** | Pure fold over the topic `MessageLog` producing typed shared state, read via `readProjection`. |
| **Invite** | Capability token (`InviteToken`) that lets a non-member join a topic. |
| **`MessageLog`** | Durable, totally-ordered log of every conversation message (DB-backed by default; NATS-backed optionally). The **stronger truth** across all runtimes. |

---

## Decision table: which primitive?

| You need… | Use |
|-----------|-----|
| Delegate one task to one agent, reuse the channel for follow-ups | `startThread` → `send` |
| Wait synchronously for a single peer reply with a timeout | `startThread({ awaitMode: 'blocking', timeoutMs })` |
| Broadcast an announcement to many agents | `createTopic` + `post({ selector: { kind: 'broadcast' } })` |
| Rotate speaker role deterministically | `createTopic({ defaultSelector: { kind: 'round_robin' } })` |
| Route to one named recipient inside a topic | `post({ selector: { kind: 'explicit_recipient', recipient: { by: 'memberId', memberId } } })` |
| Custom turn-taking (e.g. pick speaker with fewest contributions) | `selector_policy` + `TopicSelectorPolicyRegistry` |
| Auto-close after N messages / timeout / signal | `TopicStopPolicy` on `createTopic` |
| Derive typed shared state (transcript, vote tally, goal board) from all posts | `defineTopicProjection` + `readProjection` |
| Invite new members mid-flight | `invite` → peer `join` or `decline` |
| Same agent holding several seats | Topic members with distinct `memberId`s pointing to the same `agentId` |
| Cross-process / cross-host broker | `@a2arium/callagent-eventbus-nats` with adapter config |

---

## The canonical data flow

Every conversation exchange follows the same APLRET pipeline. **Turn N** dispatches an effect; **Turn N+1** reacts to the result.

```
Turn N (sender):
  Policy emits intent            → { kind: 'internal', intent: 'send_greeting' }
  Shield passes                  → { action: 'pass' }
  Execution calls ctx.conversation.{startThread|send|post|invite|...}
  Transition returns { kind: 'await_input' | 'await_tool' | 'await_child', token }

Turn N (recipient, if wakeOnTopicMessage/wakeOnThread triggers):
  Runtime injects observation into env.inbox.current
    source: 'conversation', kind: 'message.received' | 'topic.message.received' | ...
  Perception validates payload
  Learning writes durable facts into M.memory.conversation
  Policy branches on durable facts (never on pending tokens)
```

`M.memory.conversation` is populated by the default **`reduceConversationProjection`** — treat it as **read-only** in Policy.

---

## Step 1: Enable conversation on your agent

### 1a) Declare capabilities in `agent-runtime.json`

The optional `communication` block in your runtime manifest declares what your agent accepts and how the runtime should wake it. It is the capability contract between coordinators and your agent.

```json
{
  "name": "my-panel-seat-agent",
  "version": "0.1.0",
  "runMode": "loop",
  "budgets": { "maxTurns": 30 },
  "communication": {
    "autoJoinInvitedTopics": true,
    "wakeOnTopicMessage": true,
    "threadable": true,
    "threadTtlMs": 3600000,
    "acceptedSpeechActs": ["inform", "question", "answer", "task", "followup", "signal"],
    "acceptedContentTypes": ["application/json", "text/plain"],
    "topicPoliciesSupported": ["selector_policy:even-speaker", "stop_custom:quorum"],
    "topicSweeper": {
      "intervalMs": 30000,
      "autoArchiveAfterMs": 86400000
    }
  },
  "observability": { "turnTrace": { "enabled": true, "level": "summary" } }
}
```

| Field | Effect |
|-------|--------|
| `autoJoinInvitedTopics` | When `true`, invite observations are auto-joined by the runtime and an `injectTopicMemberJoined` follows. Default `false`. |
| `wakeOnTopicMessage` | When `true`, a topic delivery cold-starts a turn (same as thread messages). Default `false` — the observation queues for the next natural wake. |
| `threadable` | When `false`, peers calling `startThread({ targetAgentId: this })` get `RecipientNotThreadable`. Default `true`. |
| `threadTtlMs` | Idle TTL after which a thread auto-closes with `closedReason: 'ttl'`. `null` disables TTL for this agent. Framework default `3_600_000` (1h). |
| `acceptedSpeechActs` | Whitelist; delivery of a non-listed speech act rejects with `SpeechActNotAccepted`. |
| `acceptedContentTypes` | Whitelist applied when outbound `content` carries a `mimeType`; mismatch returns `ContentTypeNotAccepted`. |
| `topicPoliciesSupported` | Advertised policy ids. Coordinators can probe this before assigning a topic policy; mismatches emit `topic.policy.unsupported`. |
| `topicSweeper` | While a loop is running, periodically auto-archive closed topics older than `autoArchiveAfterMs`. Requires a registered `TaskEngine`. |

See [Manifest spec](./2-manifest_spec_agent_card_runtime_manifest.md).

### 1b) `ctx.conversation` access

Inside Execution:

```ts
execution: async (intent, ctx) => {
  if (!ctx.conversation) {
    return {
      action: { kind: 'internal', done: true },
      result: { status: 'error', error: { code: 'no_conversation', message: 'TaskContext.conversation is not bound' } }
    };
  }
  // ... use ctx.conversation.*
}
```

`ctx.conversation` is typed **`ConversationApi`** and is present only on runtime contexts that wired a `ConversationService` (CLI runner, streaming runner, and `createTestHarness` all do).

---

## Recipe 1: 1:1 thread between two agents

A **thread** is the simplest multi-agent exchange: one sender, one recipient, durable ordering, idempotent replay.

### Open the thread

```ts
execution: async (intent, ctx) => {
  if (intent.kind !== 'internal' || intent.intent !== 'open_thread') {
    // ...
  }
  const started = await ctx.conversation!.startThread({
    targetAgentId: 'pricing-agent',
    message: {
      senderAgentId: ctx.agentId,
      speechAct: 'request',
      content: { task: 'price_quote', sku: 'X-100' },
    },
  });
  if (started.receipt.status !== 'accepted') {
    return {
      action: { kind: 'internal', done: true },
      result: { status: 'error', error: { code: 'start_thread', message: 'open rejected' } }
    };
  }
  return {
    action: { kind: 'internal', done: true },
    result: { status: 'ok', data: {
      threadId: started.thread.id,
      outboundMessageId: started.receipt.messageId,
      sequenceNumber: started.receipt.sequenceNumber,
    } }
  };
}
```

`StartThreadOptions` highlights:

- `conversationId` — optional stable id; omit to get a framework-generated one. Useful for idempotent resumes.
- `idempotencyKey` — replays with the same key return the same `messageId` with `dedupeHit: true`.
- `awaitMode: 'deferred' | 'blocking'` — default `deferred`. Use `blocking` only when you must wait inline for a correlated reply (requires a `correlationId` on the message). `blocking` can time out with `ConversationTimeout`.
- `timeoutMs` — bounds `blocking` waits only.
- `queueMode: 'queue' | 'reject'` — what to do if the recipient session is busy (`ThreadBusy`).

### Follow up on an existing thread

```ts
const thread = { kind: 'thread' as const, id: 'my-thread-id' };

const sent = await ctx.conversation!.send(
  thread,
  {
    senderAgentId: ctx.agentId,
    recipientAgentId: 'pricing-agent',
    speechAct: 'question',
    content: { clarify: 'is shipping included?' },
  },
  { idempotencyKey: 'q-shipping-1' }
);

if (sent.status === 'accepted') {
  // sent.messageId, sent.sequenceNumber, sent.dedupeHit
} else if (sent.status === 'queued') {
  // sent.queuePosition — queued on recipient session
} else if (sent.status === 'rejected') {
  // sent.error: ConversationError — narrow on sent.error.type
}
```

### Close and archive

```ts
const closed = await ctx.conversation!.close(thread, {
  reason: 'done',
  archiveAfter: true,
});

if (closed.status !== 'ok' || !closed.closed) {
  // closed.error: ConversationError when status === 'rejected'
}
```

`close` emits `thread.closed` to both participants' inboxes; `{ archiveAfter: true }` additionally emits `thread.archived`. You can also call `ctx.conversation.archive(threadRef, ...)` after a prior close; archiving an open thread returns `ConversationNotClosed`.

### Idle TTL

With `communication.threadTtlMs` set, the framework's sweeper closes idle threads with `closedReason: 'ttl'` after that many ms of inactivity. Subsequent `send` attempts return `ThreadExpired` (distinct from operator `ConversationClosed`).

### What the recipient sees

On the next turn after a send:

```ts
// env.inbox.current[n]
{
  source: 'conversation',
  kind: 'message.received',
  payload: {
    kind: 'message.received',
    message: {
      id, conversation: { kind: 'thread', id },
      senderAgentId, recipientAgentId, recipientMemberId,
      speechAct, content, sequenceNumber, correlationId?, idempotencyKey?, ts
    }
  }
}
```

The recipient's Perception should narrow on `o.source === 'conversation' && o.kind === 'message.received'` and read `payload.message`.

### `sendTaskToAgent` is sugar over threads

`ctx.sendTaskToAgent(...)` bootstraps a thread (`startThread` + optional `send`) before invoking A2A. Pass `A2ACallOptions.conversation: ThreadRef` to continue the **same** thread across multiple child calls; the child can reply via `ctx.conversation.send(threadRef, ...)`.

See [Child-agent await and resume](./6-how_to_child_agent_await_and_resume_aplret.md) for the full dispatch → `await_child` → resume pattern; the conversation-level plumbing described there is the same as in this guide.

---

## Recipe 2: Topic with multiple members and selectors

A **topic** is an N-member durable room. Every post resolves a **selector** to decide who receives that specific message; every post also runs all registered **stop policies** after append.

### Create a topic

```ts
import { memberId } from '@a2arium/callagent-core';

const OWNER = memberId('my-coord#owner');
const CRITIC = memberId('panel-seat#critic');
const DREAMER = memberId('panel-seat#dreamer');
const REALIST = memberId('panel-seat#realist');

const created = await ctx.conversation!.createTopic({
  topicId: 'topic-panel-001',       // optional; framework generates when omitted
  members: [
    { agentId: ctx.agentId,   memberId: OWNER,   role: 'owner' },
    { agentId: 'panel-seat',  memberId: CRITIC,  role: 'participant' },
    { agentId: 'panel-seat',  memberId: DREAMER, role: 'participant' },
    { agentId: 'panel-seat',  memberId: REALIST, role: 'participant' },
  ],
  defaultSelector: { kind: 'round_robin' },
  stopPolicies: [
    { kind: 'maxRounds', n: 3 },
    { kind: 'timeout', afterMs: 86_400_000 },
  ],
});

if (created.status !== 'ok') {
  // created.error: ConversationError (TopicCapacityExceeded, Forbidden, ...)
}
const topicRef = created.topic;          // TopicRef
const resolved = created.members;        // ResolvedTopicMember[] with sessionId fields
```

Key points:

- **`members`** lists `{ agentId, memberId?, role, sessionIdOverride? }`. One `agentId` can hold **multiple seats** by using distinct `memberId`s — this is how a single deployed agent can speak as `critic`, `dreamer`, and `realist` in the same topic.
- **`defaultSelector`** is the fallback when `post` does not specify a selector.
- **`stopPolicies`** is required — at least one rule. They are evaluated in order after every successful append; the first `stop` closes the topic.
- **`sessionIdOverride`** controls which recipient session an agent's deliveries route to; useful when one `agentId` owns several loop sessions.

### Post with a selector

```ts
// Broadcast to every member (except sender)
await ctx.conversation!.post(
  topicRef,
  { senderAgentId: ctx.agentId, senderMemberId: OWNER, speechAct: 'inform', content: { phase: 'intro' } },
  { selector: { kind: 'broadcast' }, idempotencyKey: 'intro-1' }
);

// Round-robin — the framework rotates `rotationCursor` across members
await ctx.conversation!.post(
  topicRef,
  { senderAgentId: ctx.agentId, senderMemberId: OWNER, speechAct: 'question', content: { q: 'what next?' } },
  { selector: { kind: 'round_robin' } }
);

// Explicit recipient (by memberId or agentId)
await ctx.conversation!.post(
  topicRef,
  { senderAgentId: ctx.agentId, senderMemberId: OWNER, speechAct: 'task', content: { task: 'draft spec' } },
  { selector: { kind: 'explicit_recipient', recipient: { by: 'memberId', memberId: CRITIC } } }
);
```

### Fan-out receipts

```ts
type FanoutSendReceipt =
  | { status: 'accepted'; topic; deliveries: DeliverySummary[]; selectorPolicyTrace?; stopPolicyTrace? }
  | { status: 'partial';  topic; accepted: DeliverySummary[]; rejected: { memberId, recipientAgentId, error }[]; selectorPolicyTrace?; stopPolicyTrace? }
  | { status: 'queued';   topic; queuePosition }
  | { status: 'rejected'; topic; error: ConversationError };
```

`DeliverySummary` exposes `memberId`, `recipientAgentId`, `sessionId`, `messageId`, `sequenceNumber`, `dedupeHit`. Inspect `dedupeHit` to distinguish first delivery from idempotent replay.

### What a participant sees

```ts
{
  source: 'conversation',
  kind: 'topic.message.received',
  payload: {
    kind: 'topic.message.received',
    topic: { kind: 'topic', id },
    selector: { kind: 'round_robin' },      // kind only; opaque for explicit_recipient
    recipient: { memberId, agentId },
    message: { ...InboundMessage }
  }
}
```

Perception must narrow on `recipient.memberId` to know which seat was addressed. In the canonical panel example, each Perception run routes only messages where `recipient.memberId` matches the loop session's seat.

### Leaving

```ts
await ctx.conversation!.leave(topicRef, { memberId: CRITIC });   // explicit seat to leave
```

The framework emits `topic.member.left` to remaining members. Omit `memberId` to leave all seats for this `agentId` in that topic.

### Close / archive

`ctx.conversation.close(topicRef, { archiveAfter: true })` closes and archives the topic, emitting `topic.closed` then `topic.archived` to all members. `ctx.conversation.archive(topicRef, ...)` works on any already-closed topic; on an open topic it returns `ConversationNotClosed`.

---

## Recipe 3: Invite lifecycle (join / decline / auto-join)

Invites let agents that weren't in the original `members` list become members at runtime.

### Issue an invite

```ts
const inv = await ctx.conversation!.invite({
  topic: topicRef,
  invitee: {
    agentId: 'observer-agent',
    role: 'participant',
    // memberId and sessionIdOverride are optional
  },
  ttlSeconds: 3600,
});

if (inv.status === 'ok') {
  const token = inv.token;          // InviteToken; opaque capability
  const expiresAt = inv.expiresAt;
}
```

The framework emits a `topic.invite.issued` observation to the inviter and **durably persists** the invite (so it survives restarts). On startup the framework replays undelivered invites to their target.

### Receive, accept, or decline

An invited agent sees:

```ts
{ source: 'conversation', kind: 'topic.invite.received',
  payload: { kind: 'topic.invite.received', topic, token, expiresAt, role, inviterAgentId, ... } }
```

**Accept** (from Execution):

```ts
const joined = await ctx.conversation!.join(topicRef, { inviteToken: token });
// joined.member — ResolvedTopicMember
```

**Decline**:

```ts
await ctx.conversation!.decline(topicRef, { inviteToken: token, reason: 'busy' });
```

`decline` returns typed `ConversationError` branches for `InviteNotFound | InviteExpired | InviteAlreadyConsumed | InviteTargetMismatch`.

### Auto-join

If the agent manifest declares `communication.autoJoinInvitedTopics: true`, the runtime auto-joins on receipt. The turn trace captures this as `inviteDelivery.received[].autoJoinAttempted`; on failure, `autoJoinError` carries the typed reason.

### Invite sweeper

Expired invites are periodically swept by `InviteSweeper`. Tests drive it with `harness.triggerExpiredInviteSweep(...)` and advance clock with `harness.setInviteClockNow(iso)`.

---

## Recipe 4: Custom turn-taking with `selector_policy`

Sometimes `broadcast` / `round_robin` / `explicit_recipient` aren't enough — for example, "always pick the seat with the fewest contributions so far" or "pick by declared expertise tag".

### Declare the policy as a pure function

Selector policies are **pure, deterministic functions** registered at composition time. They MUST NOT call `Date.now()` / `Math.random()` — `context.nowIso` is supplied.

```ts
import type { TopicSelectorPolicy } from '@a2arium/callagent-core';
import { z } from 'zod';

const EvenSpeakerSchema = z.object({ preferRole: z.enum(['owner', 'participant']).optional() });

export const evenSpeakerPolicy: TopicSelectorPolicy = {
  policyId: 'even-speaker',
  paramsSchema: EvenSpeakerSchema,
  select(ctx) {
    const params = ctx.params as z.infer<typeof EvenSpeakerSchema> | undefined;
    const pool = ctx.members.filter(m =>
      m.memberId !== ctx.senderMemberId &&
      (!params?.preferRole || m.role === params.preferRole)
    );
    if (pool.length === 0) {
      return { kind: 'rejected', error: { type: 'PolicyAbstain', message: 'no eligible speaker' } };
    }
    const idx = ctx.sequenceNumber % pool.length;
    return {
      kind: 'selected',
      recipients: [pool[idx]!],
      nextRotationCursor: String(idx),
    };
  },
};
```

### Register it at composition

Production wiring via `TaskEngine` constructor options; test wiring via the harness:

```ts
// Tests
const h = createTestHarness(modules);
h.registerTopicSelectorPolicy(evenSpeakerPolicy);
```

### Use it on post

```ts
await ctx.conversation!.post(
  topicRef,
  { senderAgentId: ctx.agentId, senderMemberId: OWNER, speechAct: 'inform', content: {} },
  { selector: { kind: 'selector_policy', policyId: 'even-speaker', params: { preferRole: 'participant' } } }
);
```

If the policy is missing, `post` returns a typed `SelectorPolicyNotRegistered` error. A `PolicyAbstain` falls back to broadcast and the trace records both the abstention and the fallback (`selectorPolicyTrace.result: 'abstained_fallback_broadcast'`). `PolicyParamsInvalid` / `PolicyInternalError` are hard rejections.

### Determinism enforcement

The framework asserts `select(...)` returns the same result given identical context. `createTestHarness` runs policies in **strict mode** by default — `Date.now`, `Date.getTime`, and `Math.random` inside `select` throw. Opt out with `createTestHarness(modules, { policyPurityStrict: false })` only for tests that intentionally exercise impure policies.

---

## Recipe 5: Stop policies

`TopicStopPolicy` rules are evaluated after every successful append. The first rule returning `stop` closes the topic (emitting `topic.closed`) and stamps the trace.

### Built-in rules

```ts
stopPolicies: [
  { kind: 'maxTurns',  n: 10 },                             // total messages
  { kind: 'maxRounds', n: 3 },                              // complete member-rounds
  { kind: 'timeout',   afterMs: 3_600_000 },                // wall-clock from creation
  { kind: 'signalBased', signals: ['topic.archive.scheduled'], requiredCount: 1 },
]
```

### Custom stop policy

```ts
import type { StopPolicyDefinition } from '@a2arium/callagent-core';
import { z } from 'zod';

const QuorumParamsSchema = z.object({ threshold: z.number().int().positive() });

export const quorumStopPolicy: StopPolicyDefinition = {
  policyId: 'quorum',
  paramsSchema: QuorumParamsSchema,
  evaluate(ctx) {
    const params = ctx.params as z.infer<typeof QuorumParamsSchema>;
    // ctx.totalMessages, ctx.totalRounds, ctx.lastMessage, ctx.members...
    if (ctx.lastMessage?.speechAct === 'vote' && ctx.totalMessages >= params.threshold) {
      return { kind: 'stop', reason: `quorum reached (${params.threshold})` };
    }
    return { kind: 'continue' };
  },
};
```

Register it (same shape as selector policies):

```ts
h.registerStopPolicy(quorumStopPolicy);
```

Use it on create:

```ts
stopPolicies: [
  { kind: 'custom', policyId: 'quorum', params: { threshold: 5 } },
]
```

Missing / invalid custom policies return typed branches — `StopPolicyNotRegistered`, `StopPolicyParamsInvalid`, `StopPolicyInternalError`.

### Reading the stop trace

```ts
if (receipt.status === 'accepted' && receipt.stopPolicyTrace?.result === 'stop') {
  // receipt.stopPolicyTrace.reason
}
```

`TurnTrace.stopPolicy` mirrors this when the turn runner stamps the post.

---

## Recipe 6: Typed shared topic state with projections

Projections are pure folds over the durable topic `MessageLog`. They give cross-member typed shared state without CRDTs. Use them when you need a derived view — a transcript, vote tally, goal board, per-member contribution counter — that every agent can read consistently.

### Define a projection

```ts
import { defineTopicProjection, type MessageLogRecord } from '@a2arium/callagent-core';
import { z } from 'zod';

const VoteStateSchema = z.object({
  yes: z.number().int().nonnegative(),
  no: z.number().int().nonnegative(),
  byMember: z.record(z.string(), z.enum(['yes', 'no'])),
});

const voteProjection = defineTopicProjection({
  projectionName: 'panel.vote',
  stateSchema: VoteStateSchema,
  initial: () => ({ yes: 0, no: 0, byMember: {} }),
  reduce: (state, rec: MessageLogRecord) => {
    if (rec.speechAct !== 'vote') return state;
    const payload = rec.payload as { content?: { ballot?: 'yes' | 'no'; memberId?: string } };
    const ballot = payload.content?.ballot;
    const memberId = payload.content?.memberId;
    if (!ballot || !memberId || state.byMember[memberId]) return state;
    return {
      yes: state.yes + (ballot === 'yes' ? 1 : 0),
      no:  state.no  + (ballot === 'no'  ? 1 : 0),
      byMember: { ...state.byMember, [memberId]: ballot },
    };
  },
});

// Export these:
export const voteProjectionToken = voteProjection.token;         // typed token
export const voteProjectionDefinition = voteProjection.definition;
```

### Register the projection

The framework has a process-wide `TopicProjectionRegistry`. Built-ins (like `topic.transcript`) auto-register via `ensureBuiltinTopicProjectionsRegistered()`, which `TaskEngine` calls in its constructor.

Register custom projections at composition time:

```ts
import { getTopicProjectionRegistry } from '@a2arium/callagent-core';

getTopicProjectionRegistry().register(voteProjectionDefinition);
```

### Read it from Execution

```ts
import { topicTranscriptProjectionToken } from '@a2arium/callagent-core';

const transcript = await ctx.conversation!.readProjection(topicRef, topicTranscriptProjectionToken);
if (transcript.status === 'ok') {
  // transcript.state: { lines: [{ sequenceNumber, speechAct, text }, ...] }
  // transcript.asOfSequence
}

const vote = await ctx.conversation!.readProjection(topicRef, voteProjectionToken);
if (vote.status === 'ok') {
  // vote.state is typed as z.infer<typeof VoteStateSchema>
}
```

Options: `readProjection(topic, token, { asOfSequence?, fromSequence?, limit? })` for bounded reads.

Errors: `ProjectionNotRegistered`, `ProjectionStateInvalid`.

### Append a typed signal

Signals are special messages with `speechAct: 'signal'` and a closed `signalType` drawn from `SignalKindSchema` (core vocabulary + `x-…` custom namespace). Use them to drive projections, wake sweepers, or feed `signalBased` stop policies.

```ts
await ctx.conversation!.appendSignal(
  topicRef,
  {
    signalType: 'x-panel.round-complete',          // closed + x- namespace
    payload: { round: 2, summary: 'agreement on scope' },
    senderMemberId: OWNER,
    idempotencyKey: 'round-2-done',
  }
);
```

`appendSignal` returns a `FanoutSendReceipt`. Invalid signal types return `InvalidSignalKind`.

### Built-in transcript

The framework ships `topic.transcript` with token `topicTranscriptProjectionToken`, suitable for dropping into any agent that needs a rolling transcript without rolling its own fold.

---

## Recipe 7: Cross-runtime deployment (NATS adapter)

By default, `TaskEngine` runs with an in-memory event bus and a DB-backed `MessageLog` — fine for one process. For multi-process / multi-host, switch to NATS JetStream.

### Install

```bash
yarn add @a2arium/callagent-eventbus-nats
```

### Configure at the composition root

```ts
import { resolveTransportAdapters } from '@a2arium/callagent-core';

const { eventBus, messageLog, createDurableSubscription, close } =
  await resolveTransportAdapters({
    transport: {
      eventBus: { adapter: 'nats', nats: { servers: ['nats://broker:4222'] } },
      messageLog: {
        adapter: 'nats',
        nats: {
          servers: ['nats://broker:4222'],
          stream: 'CALLAGENT_MSGLOG',
          idempotencyKvBucket: 'CALLAGENT_MSGLOG_IDEMP',
        },
      },
    },
    sessionManager,
  });

const taskEngine = new TaskEngine({
  sessionStore,
  eventBus,
  messageLog,
  createDurableSubscription,
  transportClose: close,
  // ...
});

// On shutdown
await taskEngine.closeTransportAdapters();
```

- `messageLog.adapter: 'nats'` **requires** `eventBus.adapter: 'nats'` (fan-out uses the same broker).
- The adapter wraps your `MessageLog` with `wrapMessageLogWithTopicStream` automatically.
- Failures are typed `AdapterError` (`AdapterNotInstalled | AdapterUnknown | AdapterConfigInvalid | AdapterConnectFailed | AdapterVersionIncompatible`) thrown as `AdapterErrorThrowable`.

### Durable subscriptions

Cross-runtime delivery uses `DurableSubscription` with cursor / ack / nack / dead-letter semantics. The in-process default is `createInProcessDurableSubscription`; NATS uses `createNatsJetStreamDurableSubscription` (alias). No agent code changes are needed — the same `ctx.conversation.*` calls route through the configured bus.

### What stays the same

- All public APIs (`startThread`, `post`, `readProjection`, …) are adapter-agnostic.
- `MessageLog` remains the **single stronger truth** — agents crash and resume against the log.
- Idempotency (`findByIdempotency`) collapses duplicates at-least-once delivery produces.

Kafka is **not** implemented (see `apps/docs/todo/5.4-deferred-kafka-adapter-implementation-spec.md`).

---

## Observations reference

Every conversation inbound enters `env.inbox.current` as `{ source: 'conversation', kind, payload }`. Narrow on `payload.kind` inside Perception:

| `payload.kind` | Who receives | Key fields |
|----------------|--------------|------------|
| `message.received` | Thread recipient | `message: InboundMessage` |
| `delivery.failed` | Sender | `thread`, `error`, `messageId?`, `recipientAgentId?` |
| `thread.closed` | Both participants | `thread`, `ts`, `closedBy?`, `closedReason?`, `reasonText?` |
| `thread.archived` | Both participants | `thread`, `ts`, `archivedBy?`, `reasonText?` |
| `topic.message.received` | Selected recipients | `topic`, `selector`, `recipient.{memberId, agentId}`, `message` |
| `topic.invite.issued` | Inviter | `topic`, `invitee`, `token`, `expiresAt`, `inviterAgentId` |
| `topic.invite.received` | Invitee | `topic`, `token`, `expiresAt`, `role`, `inviterAgentId` |
| `topic.invite.accepted` | Inviter & joiner | `topic`, `token`, `member` |
| `topic.invite.declined` | Inviter | `topic`, `token`, `inviteeAgentId`, `reason?` |
| `topic.invite.expired` | Inviter | `topic`, `token`, `inviteeAgentId`, `expiresAt` |
| `topic.member.joined` | All topic members | `topic`, `member` |
| `topic.member.left` | Remaining members | `topic`, `agentId`, `memberId`, `reason?` |
| `topic.closed` | All topic members | `topic`, `ts`, `closedBy?`, `closedReason?`, `reasonText?` |
| `topic.archived` | All topic members | `topic`, `ts`, `archivedBy?`, `reasonText?` |
| `topic.stopPolicy.rejected` | Sender | `topic`, `error` — a stop policy returned `rejected` |
| `topic.policy.unsupported` | Coordinator | `topic`, `unsupported: [{ agentId, missing: [...] }]` |
| `outbound.committed` | Sender | `ref`, `messageId`, `sequenceNumber`, `deliveries`, `selectorKind?`, `topicAppend?` — drives Learning's projection fold |

---

## Typed errors you'll handle

`ConversationError` is a closed discriminated union. Always narrow on `.type`:

| Type | Where it surfaces |
|------|-------------------|
| `ThreadBusy` | Recipient session is processing another message and `queueMode: 'reject'` was used. |
| `NoEligibleRecipients` | Topic post selector yielded zero deliverable recipients. |
| `ConversationClosed` | Operator-closed thread/topic. |
| `ConversationNotClosed` | `archive` called on an open conversation. |
| `ConversationNotFound` | Ref does not exist. |
| `ThreadExpired` | Idle TTL fired; distinct from operator-close. |
| `ConversationTimeout` | `awaitMode: 'blocking'` exceeded `timeoutMs`. |
| `RecipientNotThreadable` | Target agent declared `communication.threadable: false`. |
| `SpeechActNotAccepted` / `ContentTypeNotAccepted` | Pre-dispatch capability validation rejected the payload. |
| `RecipientNotMember` / `RecipientAmbiguous` / `RecipientNotResolvable` | Explicit-recipient selector couldn't route. |
| `SelectorPolicyNotRegistered` / `PolicyParamsInvalid` / `PolicyInternalError` | Custom selector policy issues. |
| `StopPolicyNotRegistered` / `StopPolicyParamsInvalid` / `StopPolicyInternalError` | Custom stop policy issues. |
| `ProjectionNotRegistered` / `ProjectionStateInvalid` | `readProjection` issues. |
| `InvalidSignalKind` | `appendSignal` with a signal outside the closed vocabulary / `x-` namespace. |
| `InviteNotFound` / `InviteExpired` / `InviteAlreadyConsumed` / `InviteTargetMismatch` | `join`/`decline` with a bad or stale token. |
| `TopicCapacityExceeded` | `createTopic` beyond `MAX_TOPIC_MEMBERS`. |
| `AlreadyMember` / `NotAMember` | Join/leave invariants. |
| `QueueFull` | Recipient queue full on `queue`-mode. |
| `Forbidden` | Auth/role invariants. |
| `Unsupported` | Capability flag prevents the operation. |
| `JsonSchemaValidationFailed` | Reserved for future payload validation. |

Handle with exhaustive switches:

```ts
switch (err.type) {
  case 'ThreadExpired':       /* ... */ break;
  case 'ConversationClosed':  /* ... */ break;
  // ...
  default: {
    const _exhaustive: never = err;
    throw new Error(`unhandled ConversationError: ${_exhaustive}`);
  }
}
```

---

## Recipe 8: How Perception + Learning should handle conversation observations

### Perception: narrow, validate, return a domain-shaped `Obs`

```ts
import type { Observation, EnvironmentState, MemoryReader } from '@a2arium/callagent-core';
import type { Obs } from './types.js';

export function perception(env: EnvironmentState, _alpha: unknown, _mem: MemoryReader): Obs {
  for (const obs of env.inbox.current as Observation[]) {
    if (obs.source !== 'conversation') continue;

    if (obs.kind === 'topic.message.received') {
      const p = obs.payload as {
        topic: { id: string };
        recipient: { memberId: string };
        message: { id: string; sequenceNumber: number; senderAgentId: string; speechAct: string;
                   content?: { task?: string; prompt?: string } };
      };
      // Only care about messages addressed to *my* seat:
      const myMemberId = /* resolve from session */ '';
      if (p.recipient.memberId !== myMemberId) continue;
      if (p.message.speechAct !== 'task') continue;
      return {
        kind: 'new_task',
        topicId: p.topic.id,
        inboundMessageId: p.message.id,
        sequenceNumber: p.message.sequenceNumber,
        prompt: String(p.message.content?.prompt ?? ''),
      };
    }

    if (obs.kind === 'topic.closed') {
      return { kind: 'topic_closed' };
    }
  }
  return { kind: 'idle' };
}
```

### Learning: write durable facts, not tokens

Record only the facts Policy will need. `M.memory.conversation` is already folded by the framework's default projection — your domain Learning writes **your** facts.

```ts
export function learning(prev, _prevAction, obs) {
  if (obs.kind === 'new_task') {
    return {
      ...prev,
      memory: {
        ...prev.memory,
        sensory: {
          ...prev.memory.sensory,
          lastTopicId: obs.topicId,
          lastInboundMessageId: obs.inboundMessageId,
          pendingPrompt: obs.prompt,
        },
      },
    };
  }
  if (obs.kind === 'topic_closed') {
    return { ...prev, worldModel: { ...prev.worldModel, topicDone: true } };
  }
  return prev;
}
```

### Policy: decide from `M`, never call `ctx.conversation`

```ts
export function policy(m) {
  if (m.worldModel?.topicDone) return { kind: 'complete', result: 'done' };
  if (m.memory.sensory?.pendingPrompt) {
    return {
      kind: 'internal',
      intent: 'reply_to_task',
      data: { topicId: m.memory.sensory.lastTopicId, promptText: m.memory.sensory.pendingPrompt },
    };
  }
  return { kind: 'wait' };
}
```

### Execution: perform the effect

```ts
export async function execution(intent, ctx) {
  if (intent.kind !== 'internal' || intent.intent !== 'reply_to_task') {
    return { action: { kind: 'internal', done: true }, result: { status: 'ok', data: {} } };
  }
  const data = intent.data as { topicId: string; promptText: string };
  const answer = await ctx.llm.call(`Respond: ${data.promptText}`);
  await ctx.conversation!.post(
    { kind: 'topic', id: data.topicId },
    { senderAgentId: ctx.agentId, speechAct: 'answer', content: { text: answer[0]?.content ?? '' } },
    { selector: { kind: 'broadcast' }, idempotencyKey: `reply:${data.topicId}:${intent.data.inboundMessageId}` }
  );
  return { action: { kind: 'internal', done: true }, result: { status: 'ok', data: {} } };
}
```

---

## Testing multi-agent conversations

Use `createTestHarness` — see [How-to: Test APLRET agents](./11-how_to_test_aplret_agents.md) for the foundation. Conversation-specific helpers:

### Inject inbound observations

```ts
h.injectTopicMessageReceived({ /* topic, selector, recipient, message */ });
h.injectTopicMemberJoined({ topic, member });
h.injectTopicMemberLeft({ topic, agentId, memberId });
h.injectTopicClosed({ topic, ts });
h.injectOutboundCommitted({ /* ref, messageId, sequenceNumber, deliveries, selectorKind */ });
```

### Register policies and projections

```ts
h.registerTopicSelectorPolicy(evenSpeakerPolicy);
h.registerStopPolicy(quorumStopPolicy);
// (Topic projections share the process-wide registry. Use resetTopicProjectionRegistryForTests +
//  re-register built-ins if you're creating custom projections in tests.)
```

### Drive time / sweepers

```ts
h.setInviteClockNow('2026-04-18T10:00:00Z');
await h.triggerExpiredInviteSweep({ nowIso: '2026-04-18T11:00:00Z', limit: 100 });
await h.runInviteStartupSweep({ limit: 100 });            // replays undelivered invites

await h.tickTopicLifecycleSweep({ autoArchiveAfterMs: 86_400_000 });
await h.tickThreadLifecycleSweep({ autoArchiveAfterMs: null });
```

The lifecycle sweeps require `EngineLocator.setEngine(taskEngine)` beforehand.

### Communication manifest in tests

```ts
h.setCommunicationManifest({
  threadTtlMs: 60_000,
  autoJoinInvitedTopics: true,
  wakeOnTopicMessage: true,
  acceptedSpeechActs: ['inform', 'question'],
});
```

### Adapter overrides

```ts
h.useEventBusAdapter(myBus);
h.useMessageLogAdapter(myLog);
```

### What to assert

For every conversation feature you use, assert at least these in a deterministic test:

- **Receipts:** `SendReceipt` / `FanoutSendReceipt` `status` + `dedupeHit` on replay
- **Selector decision:** `TurnTrace.topicSelectorDecision.{kind, resolvedMembers, selectorPolicy?}`
- **Fan-out tally:** `TurnTrace.fanoutSummary.{accepted, rejected, queued, dedupeHits}`
- **Stop policy:** `TurnTrace.stopPolicy.result` / `reason` when stop fires
- **Invites:** `TurnTrace.inviteDelivery.{issued, received, accepted, declined, expired}`, `received[].autoJoinAttempted`, `received[].autoJoinError`
- **Backpressure (5.4b):** `TurnTrace.backpressure.{consumerId, state, unackedCount}` when present
- **Typed errors:** narrow on `err.type` using exhaustive `switch` with a `never` default
- **Projection reads:** `readProjection` returns typed state with the expected `asOfSequence`

---

## TurnTrace quick reference (conversation fields)

| Field | Meaning |
|-------|---------|
| `conversation: { id, kind }` | The conversation this turn touched. |
| `incomingMessages[]` / `outgoingMessages[]` | Compact per-message summaries: `{ id, conversationId, kind, senderAgentId, recipientAgentId, speechAct, sequenceNumber, ... }`. |
| `messageSequenceNumber` / `dedupeHit` / `deliveryLagMs` | Flat conveniences for single-message turns. |
| `topicSelectorDecision.kind` | `broadcast \| round_robin \| explicit_recipient \| selector_policy`. |
| `topicSelectorDecision.resolvedMembers` | Who was selected for the post. |
| `topicSelectorDecision.selectorPolicy.{policyId, result, paramsHash?}` | Present when `selector_policy` ran; `result` is `selected \| abstained_fallback_broadcast \| params_invalid \| not_registered \| internal_error`. |
| `fanoutSummary.{accepted, rejected, queued, dedupeHits}` | Tally for topic posts. |
| `stopPolicy.result` + `reason?` / `error?` | Post-append stop outcome. |
| `inviteDelivery.*` | Per-invite lifecycle state for the turn. |
| `backpressure.{consumerId, state, unackedCount}` | Delivery-side backpressure when the adapter buffers/throttles. |

---

## Common mistakes

### 1. Calling `ctx.conversation` from Policy

```ts
// WRONG
policy: async (m) => {
  const r = await ctx.conversation.post(/* ... */); // Policy is sync and effect-free
}

// RIGHT
policy: (m) => ({ kind: 'internal', intent: 'send_broadcast' });
// ...Execution performs the post.
```

### 2. Reading `M.memory.conversation` and mutating it in Policy

It's the default projection, read-only. Use your own `worldModel`/`memory.sensory` fields for domain facts.

### 3. Using `agentId` when you should use `memberId`

In a topic where one `agentId` holds several seats, routing by `agentId` is ambiguous. Use `selector.explicit_recipient.by: 'memberId'` and assert `recipient.memberId` in Perception.

### 4. Forgetting `idempotencyKey` on retries

Every `send` / `post` / `invite` should carry a stable `idempotencyKey` when called from code that may retry. Replays return the same receipt with `dedupeHit: true`.

### 5. Blocking waits everywhere

`awaitMode: 'blocking'` + `timeoutMs` is convenient but burns a loop slot and can time out with `ConversationTimeout`. Prefer the default **deferred** mode and handle the reply as a `message.received` observation on a later turn.

### 6. Impure selector / stop policies

`Date.now()`, `Math.random()`, I/O inside `select` / `evaluate` break determinism. Take `nowIso` from context and encode randomness as a seed in `params` if you must. The test harness enforces this in strict mode.

### 7. Auto-join assumed on by default

`autoJoinInvitedTopics` defaults to `false`. If you rely on auto-join, set it explicitly in the manifest and assert `inviteDelivery.received[].autoJoinAttempted === true` in tests.

### 8. `wakeOnTopicMessage` assumed on

`wakeOnTopicMessage` also defaults to `false`. If your agent must react to topic messages without another stimulus, set it explicitly.

### 9. `archive` on an open thread

Returns `ConversationNotClosed`. Either `close` first, or use `close(ref, { archiveAfter: true })`.

### 10. Topic without at least one stop policy

`TopicCreateOptions.stopPolicies` must have `.min(1)`. Pick at least a generous `timeout` so topics can't leak.

---

## Quick reference

| Need | API |
|------|-----|
| Open thread | `ctx.conversation.startThread({ targetAgentId, message, ... })` |
| Send in thread | `ctx.conversation.send(threadRef, message, options?)` |
| Blocking call | `startThread({ ..., awaitMode: 'blocking', timeoutMs, message: { ..., correlationId } })` |
| Create topic | `ctx.conversation.createTopic({ topicId?, members, defaultSelector?, stopPolicies })` |
| Post to topic | `ctx.conversation.post(topicRef, message, { selector?, idempotencyKey? })` |
| Invite | `ctx.conversation.invite({ topic, invitee, ttlSeconds? })` |
| Join | `ctx.conversation.join(topicRef, { inviteToken })` |
| Decline | `ctx.conversation.decline(topicRef, { inviteToken, reason? })` |
| Leave | `ctx.conversation.leave(topicRef, { memberId? })` |
| Close | `ctx.conversation.close(ref, { reason?, archiveAfter? })` |
| Archive | `ctx.conversation.archive(ref, { reasonText? })` |
| Read projection | `ctx.conversation.readProjection(topicRef, token, { asOfSequence? })` |
| Append signal | `ctx.conversation.appendSignal(topicRef, { signalType, payload?, senderMemberId? })` |
| Selector policy | `TopicSelectorPolicy` + `TopicSelectorPolicyRegistry` (register at composition / harness) |
| Stop policy | `StopPolicyDefinition` + `StopPolicyRegistry` |
| Define projection | `defineTopicProjection({ projectionName, stateSchema, initial, reduce })` |
| Brand member id | `memberId('agent#seat')` |
| Brand invite token | `inviteToken('tok-...')` |
| Cross-runtime (NATS) | `resolveTransportAdapters({ transport: { eventBus: { adapter: 'nats' }, messageLog: { adapter: 'nats' } }, sessionManager })` |

---

## Canonical examples

- **`apps/examples/conversation-reference-agent`** — threads + Phase 2 topic demos + Phase 3 close/archive.
- **`apps/examples/conversation-responder-agent`** — pairs with the reference agent; join + leave + reply.
- **`apps/examples/conversation-panel-orchestrator-agent`** + **`conversation-panel-persona-agent`** — multi-seat panel with round-based explicit-recipient selection and an `idempotencyKey`-protected post loop.

Read those side-by-side with this guide for real wiring; they are the happy-path tests the framework is built against.

---

## Related docs

- [APLRET contracts](./0-aplret_contracts.md) — the non-negotiable rules every module obeys.
- [Child-agent await and resume](./6-how_to_child_agent_await_and_resume_aplret.md) — delegation via `sendTaskToAgent`, which is built on `startThread`/`send`.
- [How to keep Policy pure](./3-how_to_keep_policy_pure.md) — why Policy never calls `ctx.conversation`.
- [Test APLRET agents](./11-how_to_test_aplret_agents.md) — harness foundation this guide extends.
- [Debug with TurnTrace](./12-how_to_debug_with_turn_trace.md) — walk parent / child / fan-out trace links.
- [Manifest spec](./2-manifest_spec_agent_card_runtime_manifest.md) — full `communication` block.
- [Planned architecture — multi-agent communication](./planned_architecture/multi-agent-communication.md) — the normative spec this feature implements.
