# Durable task admission

`TaskEngine.submitTask()` admits a buffered, loop-mode root task without waiting
for its execution result. Use it from schedulers and other producers that need a
durable handoff rather than synchronous task completion.

```ts
const result = await engine.submitTask({
  tenantId: 'tenant-a',
  taskId: 'lifecycle:source-42:2026-07-31',
  agentId: 'site-source-coordinator',
  input: { sourceId: 'source-42' },
  options: {
    maxTurns: 20,
    taskRunTimeoutMs: 32 * 60_000,
  },
});
```

The first coherent request returns `accepted`. An exact retry returns
`duplicate_active` or `duplicate_terminal`. Reusing the same `(tenantId,
taskId)` with another agent, input, `maxTurns`, or `taskRunTimeoutMs` throws an
error whose stable code is `TASK_SUBMISSION_CONFLICT`.

`taskRunTimeoutMs` is an optional absolute budget for the admitted root task.
It must be an integer from 1 through 2,147,483,647. The deadline starts at the
durable admission timestamp, so queue delay, worker restart, recovery, and
provider redelivery all consume the same budget. Expiry converges through the
normal durable task-cancellation path; it is not a per-turn timeout or a hard
process kill. Independent roots submitted through `ctx.tasks.submit()` receive
their own deadline and do not reset the submitting task's budget.

Omitting `taskRunTimeoutMs` preserves the existing timeout-free durable
admission behavior. Existing v1 request digests for omitted timeouts are
unchanged.

Admission is logically exactly-once: the durable generation and claim fence
prevent more than one owning turn. Publication to the runtime provider is
at-least-once. A crash after provider acceptance but before acknowledgement may
therefore republish the same delivery key. Agent-side effects must continue to
honour the framework's claim and effect-idempotency contracts.

The method returns after the admission snapshot is committed and a direct
publication has either been accepted or deferred to reconciliation. When an
absolute task timeout is supplied, its durable timer is established before
direct publication. A timer-provider failure leaves the admission recoverable
and defers publication; the reconstructed initial segment repairs or enforces
the original deadline before it may claim execution. The method does not wait
for a worker or terminal completion. Provider execution can start before the
promise settles, but in-process admission does not enter the segment/agent
pipeline inline in the caller's stack.

Exact retries are classified from stored identity and do not depend on the
agent still being registered or on the caller using the original runtime
driver. Only the reconciler for the task's stored runtime surface may recover a
missing publication.

Admission requires a durable session store and a runtime driver advertising
recoverable starts. Invalid identities, non-JSON input, unsupported agents,
provider payload preflight failures, and pre-existing non-admission task state
fail before a new admission is committed.
