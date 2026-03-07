import {
    createAgent,
    type EnvironmentState,
    type MentalState,
    type MemoryReader,
    type ProposedAction,
    type ExecutableAction,
    type ExecResult,
    type TransitionOut,
    type TaskContext,
    type ObservationConfig
} from '@a2arium/callagent-core';
import { logger } from '@a2arium/callagent-utils';

type Sensory = {
    name?: string;
};

type HelloPerception = {
    nameFromInput?: string;
};

type HelloExecData = {
    greeting: string;
    processedAt: string;
};

type HelloError = {
    code: string;
    message: string;
};

export default createAgent<Sensory, HelloPerception, unknown, HelloExecData, HelloError, ObservationConfig>({
    manifest: {
        name: 'hello-agent',
        version: '0.2.0',
        runMode: 'loop',
        budgets: {
            maxTurns: 2 // Enough to observe input and complete
        }
    },

    perception: (env: EnvironmentState<ObservationConfig>): HelloPerception => {
        // Look for user input in the inbox
        const inputs = env.inbox.all.filter(obs => obs.source === 'user' && obs.kind === 'input.provided');
        const latestInput = inputs[inputs.length - 1]; // most recent
        const payload = latestInput?.payload?.value as Record<string, unknown> | undefined;

        const nameFromInput = typeof payload?.name === 'string' ? payload.name : undefined;

        logger.info('[Perception] Recognized input', { nameFromInput });

        return { nameFromInput };
    },

    learning: (prev: MentalState<Sensory>, _prevAction: ProposedAction | undefined, obs: HelloPerception) => {
        const currentName = obs.nameFromInput || prev.memory?.sensory?.name;

        return {
            ...prev,
            memory: {
                ...prev.memory,
                sensory: {
                    name: currentName
                }
            }
        };
    },

    policy: (m: MentalState<Sensory>, _mem: MemoryReader): ProposedAction => {
        const name = m.memory?.sensory?.name;

        // If we have a name, we can greet
        if (name) {
            logger.info('[Policy] Name is available, intent is to greet.');
            return { kind: 'internal', intent: 'greet' };
        }

        // If no name, request input or fallback
        logger.info('[Policy] Name NOT available, defaulting to greet anyway (fallback).');
        return { kind: 'internal', intent: 'greet' };
    },

    shield: (_m, action, _mem) => {
        // Unconditionally allow
        return { action: 'pass', intent: action };
    },

    execution: async (action: ProposedAction, ctx: TaskContext, _mem: MemoryReader, m: MentalState<Sensory>) => {
        if (action.kind === 'internal' && action.intent === 'greet') {
            const name = m.memory?.sensory?.name || 'World';
            const greeting = `Hello, ${name}! 👋`;
            const processedAt = new Date().toISOString();

            logger.info('[Execution] Executing greeting', { greeting });

            await ctx.reply([{
                type: 'text',
                text: `${greeting}\n\nProcessed at: ${processedAt}\n\n(Generated via APLRET Execution module)`
            }]);

            return {
                action: { kind: 'internal', done: true } satisfies ExecutableAction,
                result: {
                    status: 'ok',
                    data: { greeting, processedAt }
                } satisfies ExecResult<HelloExecData>
            };
        }

        return {
            action: { kind: 'internal', done: true } satisfies ExecutableAction,
            result: {
                status: 'error',
                error: { code: 'unknown_intent', message: `Unhandled action: ${action.kind}` }
            } satisfies ExecResult<HelloExecData>
        };
    },

    transition: (env: EnvironmentState<ObservationConfig>, exec: { action: ExecutableAction; result: ExecResult<HelloExecData> }, _m: MentalState<Sensory>): TransitionOut<ObservationConfig> => {
        if (exec.result.status === 'ok') {
            logger.info('[Transition] Completing loop successfully.');
            return { kind: 'complete', result: exec.result.data };
        }

        logger.warn('[Transition] Failing loop due to execution error.');
        return { kind: 'fail', reason: 'execution_error' };
    }
}, import.meta.url);