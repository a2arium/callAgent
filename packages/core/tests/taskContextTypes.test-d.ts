import { expectType } from 'tsd';
import type { TaskContext } from '../src/shared/types/index.js';
import type { SubmitTaskParams, SubmitTaskResult } from '../src/orchestration/TaskSubmission.js';
import type {
    TaskContextGoalAddInput,
    TaskContextGoalUpdatePatch,
    TaskContextGoalsReadFilter,
    GoalNode,
} from '../src/loop/types.js';

declare const ctx: TaskContext;

expectType<SubmitTaskParams>({
    tenantId: 'tenant', taskId: 'root', agentId: 'agent', input: {},
});
expectType<SubmitTaskParams>({
    tenantId: 'tenant', taskId: 'bounded-root', agentId: 'agent', input: {},
    options: { maxTurns: 20, taskRunTimeoutMs: 32 * 60_000 },
});

if (ctx.tasks) {
    expectType<Promise<SubmitTaskResult>>(
        ctx.tasks.submit('agent', {}, { taskId: 'root' })
    );
    expectType<Promise<SubmitTaskResult>>(
        ctx.tasks.submit('agent', {}, {
            taskId: 'bounded-root', maxTurns: 20, taskRunTimeoutMs: 32 * 60_000,
        })
    );
}

const addInput: TaskContextGoalAddInput = { title: 'x' };
expectType<TaskContextGoalAddInput>(addInput);

const patch: TaskContextGoalUpdatePatch = { status: 'done' };
expectType<TaskContextGoalUpdatePatch>(patch);

const filter: TaskContextGoalsReadFilter = { status: 'active' };
expectType<TaskContextGoalsReadFilter>(filter);

if (ctx.goals) {
    expectType<Promise<string> | string>(ctx.goals.add({ title: 't' }));
    expectType<Promise<void> | void>(ctx.goals.update('id', { status: 'failed' }));
    expectType<Promise<void> | void>(ctx.goals.remove('id'));
    expectType<Promise<void> | void>(ctx.goals.clear((g: GoalNode) => g.status === 'done'));
    expectType<Promise<GoalNode[]> | GoalNode[]>(ctx.goals.read({ type: 'short' }));
}
