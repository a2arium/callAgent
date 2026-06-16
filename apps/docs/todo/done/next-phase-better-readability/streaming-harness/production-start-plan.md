# Production Start Plan

This is the first production implementation target after the disposable harness
contract is accepted.

## First Target: Fix Artifact Completion Vs Task Final

Start with the smallest behavior change:

1. Preserve existing `ctx.reply`, `ctx.progress`, `tasks/send`, and
   `tasks/sendSubscribe` public behavior.
2. Stop treating artifact completion as task final.
3. Ensure `ctx.reply(..., { lastChunk: true })` marks the artifact as complete
   without closing the task stream.
4. Ensure only terminal task status closes SSE.
5. Add regression tests for current streaming behavior.

## Why This First

- It fixes the clearest known correctness bug.
- It is narrow and testable.
- It establishes the key semantic split needed by the canonical event model.
- It does not require immediately introducing all rich tool/child/conversation
  stream events.

## Initial Acceptance Tests

- `artifact.done` / legacy artifact `lastChunk` does not close SSE.
- `task.status(completed|failed|canceled, terminal=true)` closes SSE.
- A stream can deliver an artifact completion event and then later deliver final
  task status.
- Existing simple streaming clients still receive status and artifact updates.

