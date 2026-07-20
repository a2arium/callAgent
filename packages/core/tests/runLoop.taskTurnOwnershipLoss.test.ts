import { jest } from '@jest/globals';
import { TaskLifecycleTerminalError } from '@a2arium/callagent-types/task-lifecycle-terminal';
import { TaskTurnSupersededError } from '@a2arium/callagent-types/task-turn-superseded';
import { runLoop } from '../src/loop/loopRunner.js';
import { initialM } from '../src/loop/init.js';
import { ModuleExecutionError } from '../src/utils/errors.js';
import type { EnvironmentState } from '../src/loop/types.js';

const baseEnv = (): EnvironmentState => ({
    time: new Date().toISOString(),
    sessionId: 'ownership-loss-session',
    turn: 0,
    budget: { maxTurns: 1, latencyMs: 0 },
    pending: { inputs: {}, children: {}, tools: {}, groups: {} },
    inbox: { current: [], all: [] } as never,
    lastExec: undefined,
});

describe('runLoop task-turn ownership loss propagation', () => {
    it.each([
        [
            'terminal lifecycle',
            new TaskLifecycleTerminalError({
                tenantId: 'tenant',
                taskId: 'task',
                state: 'detached',
                reason: 'ancestor_terminal',
                effectKind: 'tool',
            }),
        ],
        [
            'superseded claim',
            new TaskTurnSupersededError({
                tenantId: 'tenant',
                taskId: 'task',
                claimId: 'claim-1',
                fence: '1',
                operation: 'effect_registration',
            }),
        ],
    ])('preserves a wrapped %s error for durable segment classification', async (_label, ownershipError) => {
        const ctx: any = { task: { id: 'task', input: {} }, reply: jest.fn() };
        const modules = {
            policy: () => ({ kind: 'internal', intent: 'register-effect' }),
            execution: async () => {
                throw ownershipError;
            },
        } as any;

        await expect(runLoop(ctx, initialM(ctx), baseEnv(), modules, { maxTurns: 1 }))
            .rejects.toMatchObject({
                code: 'MODULE_EXECUTION_ERROR',
                cause: ownershipError,
            } satisfies Partial<ModuleExecutionError>);
    });
});
