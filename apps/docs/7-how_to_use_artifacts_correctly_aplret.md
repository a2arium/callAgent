# How-to: Use Artifacts Correctly (APLRET)

Use this guide when your agent needs to handle large payloads without breaking snapshots, memory discipline, or Policy purity.

## Goal

- Keep large payloads out of inline snapshots.
- Preserve sync M-only Policy.
- Make large data available either for cognition or for action in the correct module.

## When to use artifacts

Use an artifact handle when payloads are too large or too raw to store directly in `MentalState` or inbox summaries.

Typical examples:

- long HTML pages
- large JSON responses
- OCR output
- base64 images
- long PDFs or extracted document text
- verbose tool responses that would bloat snapshots

## Non-negotiable rules

- Policy never awaits artifacts.
- Learning may await an artifact only when its content changes what the agent knows.
- Execution may await an artifact only when the content is needed to perform an action.
- `MentalState` stores artifact handles or compact derived facts, not giant raw values.

## Decide where the artifact belongs

Ask this first:

### Question 1

**Does the artifact content change the agent’s beliefs, memory, or decision-making?**

If yes:

- receive the artifact handle through an observation
- load it in Learning
- store the derived reasoning-relevant facts in `MentalState`

### Question 2

**Is the artifact needed only to perform an action?**

If yes:

- store the handle in memory if needed
- let Policy emit an intent based on existing facts
- load the artifact in Execution

## Correct pattern A: artifact affects cognition

Example: a child agent returns a large HTML page, but the parent only needs keywords and classification.

### Perception

Perception accepts the handle as part of a normalized observation.

```ts
perception: (env) => {
  const childObs = env.inbox.current.find(
    o => o.source === 'child' && o.kind === 'child.completed'
  );

  if (!childObs) return { kind: 'idle' };

  return {
    kind: 'document_received',
    document: childObs.payload.result.pageHandle
  };
};
```

### Learning

Learning awaits the artifact and stores compact facts.

```ts
learning: async (prev, _prevAction, obs) => {
  if (obs.kind !== 'document_received') return prev;

  const html = await obs.document;
  const keywords = extractKeywords(html);
  const classification = classifyDocument(html);

  return {
    ...prev,
    memory: {
      ...prev.memory,
      window: {
        ...(prev.memory?.window ?? {}),
        latestDocumentHandle: obs.document
      }
    },
    worldModel: {
      ...prev.worldModel,
      documentKeywords: keywords,
      documentClass: classification
    }
  };
};
```

### Policy

Policy remains sync and reads only the derived facts.

```ts
policy: (m) => {
  if (m.worldModel?.documentClass === 'invoice') {
    return { kind: 'process_invoice' };
  }
  return { kind: 'wait' };
};
```

## Correct pattern B: artifact is needed only to act

Example: the agent already knows it should summarize a document, but the full text is only needed at execution time.

### Learning

Store the handle, not the raw content.

```ts
learning: (prev, _prevAction, obs) => {
  if (obs.kind !== 'document_received') return prev;

  return {
    ...prev,
    memory: {
      ...prev.memory,
      window: {
        ...(prev.memory?.window ?? {}),
        latestDocumentHandle: obs.document
      }
    }
  };
};
```

### Policy

Policy decides based on existing cognition.

```ts
policy: (m) => {
  if (m.worldModel?.shouldSummarizeDocument) {
    return { kind: 'summarize_document' };
  }
  return { kind: 'wait' };
};
```

### Execution

Execution loads the artifact and performs the action.

```ts
execution: async (intent, ctx, m) => {
  if (intent.kind !== 'summarize_document') {
    return {
      action: { kind: 'internal', done: true },
      result: { status: 'ok', data: { skipped: true } }
    };
  }

  const handle = m.memory?.window?.latestDocumentHandle;
  
  if (!handle) {
    return {
      action: { kind: 'internal', done: true },
      result: { status: 'error', data: { missing_handle: true } }
    };
  }

  const text = await handle;
  const res = await ctx.llm.call(`Summarize:\n\n${text}`);

  return {
    action: { kind: 'internal', done: true },
    result: {
      status: 'ok',
      data: { summary: res[0]?.content ?? '' }
    }
  };
};
```

## What to store in memory

Prefer:

- artifact handle
- compact summary
- extracted entities
- classification labels
- durable facts Policy needs

Avoid:

- entire HTML string
- full OCR dump inline
- binary/base64 data inline
- raw transport wrappers

## Plan steps store refs, not inline tool JSON

A completed plan step MAY list `outputs?: PlanOutputRef[]` with
`kind: 'artifact' | 'memory' | 'evidence'` and a string `ref`. That is a
handle. Do not put tool JSON, HTML, or `kind: 'value'` on the step.
Learning writes the handle after it knows the artifact / memory id.
Policy reads the ref from `M.plans` and never awaits the artifact.

## Common mistakes

### Mistake 1: async Policy

```ts
policy: async (m) => {
  const html = await m.memory?.window?.latestDocumentHandle;
  return html.includes('urgent') ? { kind: 'escalate' } : { kind: 'archive' };
}
```

Why it is wrong:

- Policy is no longer sync
- reasoning now depends on hidden reads
- tests become harder
- replay becomes less clear

Fix:

- move artifact read to Learning if it changes cognition
- move artifact read to Execution if it only supports action

### Mistake 2: storing large raw values directly in memory

Why it is wrong:

- bloats snapshots
- increases memory churn
- makes diffs and traces noisy

Fix:

- store the artifact handle and compact derived facts only

### Mistake 3: using artifacts for tiny values

Artifacts are not a substitute for normal memory writes.

If the value is small and already reasoning-ready, write it directly to `MentalState`.

### Mistake 4: wrapping an artifact handle with `Artifact.create()`

`Artifact.create()` accepts a raw value. Do not call it on an artifact handle received
from a child, inbox entry, or memory read. Re-wrapping a handle creates an artifact
whose payload is the first artifact's marker instead of the underlying content.

```ts
// Wrong: `html` may already be an Artifact<string>.
const storedHtml = Artifact.create(html, { mimeType: 'text/html' });

// Correct: wrap only raw strings and preserve existing handles.
const storedHtml = typeof html === 'string'
  ? Artifact.create(html, { mimeType: 'text/html' })
  : html;
```

When the content is needed, await the existing handle and validate the loaded value's
runtime type before passing it to a parser.

## Testing checklist

Minimum tests:

- artifact affects cognition: Learning loads it and writes compact facts
- artifact affects action only: Execution loads it, Policy stays sync
- no inline giant payload stored in memory snapshot
- an incoming artifact handle is retained rather than wrapped in another artifact
- TurnTrace still shows the decision path even when raw content is offloaded

## Debug checklist

If behavior is wrong, ask:

- Did the artifact handle arrive through the inbox pipeline?
- Did Learning load it when cognition depended on it?
- Did Policy branch on a compact fact rather than trying to read the handle?
- Did Execution load it only when action required it?
