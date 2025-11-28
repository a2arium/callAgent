/**
 * Helper Agent for Bug #2 Testing
 * 
 * Simple agent that immediately completes with success.
 * Used to test multiple sequential A2A calls.
 */

import { createAgent } from '@a2arium/callagent-core';
import type {
    TaskContext,
    MentalState,
    ExecutableAction,
    EnvironmentState,
    TransitionOut,
    ExecResult,
    ExecErrorPayload,
    ProposedAction,
    ObservationConfig
} from '@a2arium/callagent-core';

type HelperSensory = {
    input?: unknown;
};

type HelperObs = {
    task?: string;
};

type HelperObservationConfig = ObservationConfig & {
    user: { task?: string };
};

export default createAgent<HelperSensory, HelperObs, unknown, unknown, ExecErrorPayload, HelperObservationConfig>({
    manifest: {
        name: 'helper-agent',
        version: '1.0.0',
        runMode: 'loop',
        budgets: { maxTurns: 1 }
    },

    perception: (env: EnvironmentState<HelperObservationConfig>): HelperObs => {
        const userInput = env.inbox.current.find(o => o.source === 'user' && o.kind === 'input.provided');
        const inputValue = userInput?.payload.value;
        return { task: inputValue?.task };
    },

    learning: (prev, _action, obs: HelperObs): MentalState<HelperSensory> => ({
        ...prev,
        memory: {
            ...prev.memory,
            sensory: { input: obs.task }
        }
    }),

    policy: (): ProposedAction => ({
        kind: 'internal' as const,
        intent: 'complete'
    }),

    execution: async (
        _action,
        ctx: TaskContext,
        _mem: any,
        m: MentalState<HelperSensory>
    ): Promise<{ action: ExecutableAction; result: ExecResult<unknown> }> => {
        const task = m.memory.sensory?.input;
        
        await ctx.reply(`Helper agent completed task: ${task}`);
        ctx.complete(100, 'completed');
        
        return {
            action: { kind: 'internal', done: true },
            result: {
                status: 'ok',
                ts: Date.now(),
                data: {
                    ok: true,
                    message: `Completed ${task}`,
                    task
                }
            }
        };
    },

    transition: (
        _env,
        exec
    ): TransitionOut<HelperObservationConfig> => {
        return {
            kind: 'complete',
            result: exec.result.data ?? { ok: true }
        };
    }
}, import.meta.url);
