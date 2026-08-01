# Feature Request: Durable Admission-Only Root Task Submission

## Status

**Implemented with the revised logical-exactly-once contract.**

A scheduled sweep must durably admit coordinator tasks and exit without running
the first agent segment inline or waiting for the terminal result. Existing
`TaskEngine.startTask()` starts execution, while `tasks/send` waits for terminal
completion.

This request is additive. Existing task APIs and execution behavior must remain
unchanged.

## Required Contract

Add an admission-only TaskEngine method:

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

type SubmitTaskResult = {
    taskId: string;
    status:
        | 'accepted'
        | 'duplicate_active'
        | 'duplicate_terminal';
};

TaskEngine.submitTask(params: SubmitTaskParams): Promise<SubmitTaskResult>;
```

`submitTask()` must:

1. validate the agent and canonical task input;
2. establish the same tenant, agent, manifest provenance, reply-delivery, budget,
   lifecycle, and task input state used by `startTask()`;
3. durably register generation one before best-effort provider publication;
4. return after the authoritative admission can survive process termination;
5. never invoke an agent handler inline in the submission call stack or wait for
   terminal execution. Provider work may begin concurrently before the returned
   promise settles.

When supplied, `taskRunTimeoutMs` is validated as an integer in the inclusive
range 1 through 2,147,483,647. Admission stores one immutable absolute root-run
deadline based on the durable storage timestamp. Queue delay, restart,
reconciliation, and provider redelivery do not renew it. The deadline is
enforced through durable task cancellation and does not replace per-operation
child deadlines. Omitting the option retains the previous timeout-free
admission behavior.

## Idempotency

`(tenantId, taskId)` is the admission identity.

- The first coherent submission returns `accepted`.
- Repeating the exact agent, input, and options for an active task returns
  `duplicate_active`.
- Repeating them for a terminal task returns `duplicate_terminal`.
- Reusing the identity with different agent, input, or execution options returns
  `TASK_SUBMISSION_CONFLICT`.
- Concurrent submitters produce one accepted logical generation. Provider
  publication is at-least-once and may be repeated after a crash.
- A process crash at any instruction boundary must converge to either no
  admission or one recoverable admission, never an unstartable partial task.

Input comparison uses CallAgent's canonical JSON rules and a stored digest. Raw
large inputs remain subject to existing artifact and payload limits.

## Driver Semantics

- In-process and Hatchet drivers implement identical admission behavior.
- Hatchet admission uses the existing canonical CallAgent task protocol and
  workflow names.
- The method must not call Hatchet workflows directly without first establishing
  authoritative CallAgent task state.
- Existing task-start reconciliation can safely republish an admitted start
  request under the same delivery identity but cannot create a second logical
  generation or owning claim.
- Submission does not imply successful execution and does not wait for a worker.
- A supplied root-run deadline timer is registered before direct publication;
  recovery repairs missing timer registration and checks expiry before the
  initial owning turn is claimed.

An optional RPC method may expose this capability later, but no new public
endpoint is required for the initial framework contract.

## Tests

- In-process admission does not invoke the segment pipeline in the submission
  call stack; Hatchet publication is not awaited to terminal execution.
- Concurrent identical submissions produce one `accepted` and coherent duplicate
  results.
- Conflicting reuse returns `TASK_SUBMISSION_CONFLICT`.
- Crash/restart after every durable admission boundary eventually executes once.
- In-process and real Hatchet integration tests have equivalent results.
- Active and terminal duplicate submissions do not create new turns.
- Tenant isolation permits the same task ID in two tenants without collision.
- Invalid root timeouts fail before admission, and changing an admitted timeout
  is a submission conflict.
- Queue delay, restart, and redelivery consume the original absolute timeout;
  in-process and Hatchet execution share the same enforcement path.
- Existing `startTask`, `tasks/send`, streaming, child dispatch, and runner tests
  remain unchanged.

## Acceptance Criteria

1. A scheduler can submit a root coordinator task and terminate immediately.
2. Admission is durable and idempotent by tenant and task ID.
3. No agent segment executes inline in `submitTask()` and submission never waits
   for task completion.
4. Restart reconciliation cannot lose or duplicate the logical start.
5. Existing APIs and drivers retain their current behavior.
