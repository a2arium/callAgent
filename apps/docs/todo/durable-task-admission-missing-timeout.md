# Bug: Durable Root Submission Drops `taskRunTimeoutMs`

## Status

**Resolved.**

Implemented as an additive durable-admission option. The timeout is bound to
the canonical submission identity, stored with an admission-time absolute
deadline, registered before direct provider publication, and enforced before
the reconstructed initial turn can claim execution. In-process and Hatchet
drivers use the same Core enforcement path.

## Summary

The accepted durable admission contract includes an optional
`options.taskRunTimeoutMs`, but the implemented `TaskEngine.submitTask()` and
manifest-gated `ctx.tasks.submit()` contracts accept only `maxTurns`.

This prevents a scheduler from binding an admitted root task to the same
absolute execution budget used by its durable admission/retry protocol. The
itupdated lifecycle scheduler has different reviewed root limits for source
discovery, selector repair, activation projection, and reconciliation.

## Expected Contract

```ts
type SubmitTaskParams = {
  tenantId: string;
  taskId: string;
  agentId: string;
  input: unknown;
  options?: {
    maxTurns?: number;
    taskRunTimeoutMs?: number;
  };
};

type TaskContext = {
  tasks?: {
    submit(
      agentId: string,
      input: unknown,
      options: {
        taskId: string;
        maxTurns?: number;
        taskRunTimeoutMs?: number;
      },
    ): Promise<SubmitTaskResult>;
  };
};
```

The option is additive and optional. Existing submissions that omit it must
retain their current manifest-derived timeout behavior.

## Original Observed Implementation

- `packages/core/src/orchestration/TaskSubmission.ts` defines only
  `options?: { maxTurns?: number }`.
- `packages/core/src/shared/types/index.ts` exposes only `taskId` and
  `maxTurns` through `ctx.tasks.submit()`.
- The request digest and persisted task-submission metadata do not bind a task
  run timeout.
- The durable-task-admission specification documents only `maxTurns`.

## Required Behavior

1. Validate `taskRunTimeoutMs` as a positive bounded safe integer before any
   durable side effect.
2. Include its normalized value in the canonical submission digest and stored
   submission metadata.
3. Treat reuse of `(tenantId, taskId)` with a different timeout as
   `TASK_SUBMISSION_CONFLICT`.
4. Persist and enforce one absolute task-run deadline across queue delay,
   restart, recovery, and driver redelivery. Nested work must not reset it.
5. Use the same behavior for in-process and Hatchet drivers.
6. Propagate the option unchanged through manifest-gated `ctx.tasks.submit()`.
7. Preserve current behavior when the option is absent.

The timeout controls the admitted root task. It does not replace child-operation
deadlines, and it must not be interpreted as a per-turn timeout.

## Acceptance Tests

- Type tests cover direct and `ctx.tasks.submit()` usage with and without the
  option.
- Invalid zero, negative, fractional, non-finite, and excessive values fail
  before admission.
- Exact duplicate submissions with the same timeout return
  `duplicate_active` or `duplicate_terminal`.
- A duplicate with a different timeout returns `TASK_SUBMISSION_CONFLICT`.
- A queued task that starts late receives only its remaining absolute budget.
- Restart and redelivery do not renew the deadline.
- In-process and real Hatchet runs terminate at the configured task deadline.
- Existing callers that omit the option and existing schedule APIs remain
  unchanged.

## Consumer Reproduction

The itupdated scheduler needs to submit envelopes equivalent to:

```ts
await ctx.tasks!.submit(
  "site-source-coordinator",
  command,
  {
    taskId: deterministicAdmissionTaskId,
    maxTurns: 20,
    taskRunTimeoutMs: 32 * 60_000,
  },
);
```

This call now type-checks and preserves the same absolute deadline across queue
delay, restart, recovery, and provider redelivery. Calls that omit the option
retain their prior behavior and their existing v1 digest identity.
