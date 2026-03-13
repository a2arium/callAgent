import {
    createAgent,
    type EnvironmentState,
    type MentalState,
    type MemoryReader,
    type Intent,
    type ExecutableAction,
    type ExecResult,
    type TransitionOut,
    type TaskContext
} from '@a2arium/callagent-core';
import { logger } from '@a2arium/callagent-utils';
import { z } from 'zod';

type Sensory = {
    name?: string;
};

type WorldModel = {
    generatedGreeting?: { greeting: string; emoji: string };
};

type HelloPerception = {
    nameFromInput?: string;
    generatedGreeting?: { greeting: string; emoji: string };
};

type HelloExecData = {
    kind?: string;
    payload?: any;
    greeting?: string;
    processedAt?: string;
};

type HelloError = {
    code: string;
    message: string;
};

const GreetingSchema = z.object({
    greeting: z.string().describe('The personalized greeting text for the user'),
    emoji: z.string().describe('A single suitable emoji that fits the enthusiastic tone')
});

export default createAgent<Sensory, HelloPerception, WorldModel, HelloExecData, HelloError>({

    llmConfig: {
        provider: 'openai',
        modelAliasOrName: 'gpt-4o-mini',
        systemPrompt: 'You are a highly enthusiastic greeting assistant.',
        historyMode: 'stateless'
    },

    perception: (env: EnvironmentState): HelloPerception => {
        // Look for user input in the inbox
        const userInputs = env.inbox.all.filter(obs => obs.source === 'user' && obs.kind === 'input.provided');
        const latestInput = userInputs[userInputs.length - 1]; // most recent
        const payload = latestInput?.payload as Record<string, unknown> | undefined;
        const nameFromInput = typeof payload?.value === 'string' ? payload.value : (payload?.value as any)?.name;

        // Look for LLM generated greeting from internal transitions
        const llmOutputs = env.inbox.all.filter(obs => obs.kind === 'state.noted');
        const generatedGreeting = llmOutputs[llmOutputs.length - 1]?.payload as { greeting: string; emoji: string } | undefined;

        logger.info('[Perception] Recognized signals', { nameFromInput, hasGeneratedGreeting: !!generatedGreeting });

        return { nameFromInput, generatedGreeting };
    },

    learning: (prev: MentalState<Sensory>, _prevAction: Intent | undefined, obs: HelloPerception) => {
        const next = { ...prev, memory: { ...prev.memory } };

        if (obs.nameFromInput) {
            next.memory.sensory = { ...next.memory.sensory, name: obs.nameFromInput };
        }

        if (obs.generatedGreeting) {
            next.worldModel = { ...next.worldModel, generatedGreeting: obs.generatedGreeting };
        }

        return next;
    },

    policy: (m: MentalState<Sensory>, _mem: MemoryReader): Intent => {
        // Did we already generate the greeting? If so, complete the loop.
        if (m.worldModel?.generatedGreeting) {
            logger.info('[Policy] Greeting is ready. Yielding complete.');
            return { kind: 'internal', intent: 'complete', data: m.worldModel.generatedGreeting };
        }

        // Do we have a name to generate a greeting for?
        const name = m.memory?.sensory?.name;
        if (name) {
            // Emitting intent to use LLM, but policy does NOT call LLM directly
            logger.info('[Policy] Requesting execution to generate greeting via LLM.');
            return { kind: 'internal', intent: 'generate_greeting', data: { name } };
        }

        // Fallback or explicit request for user
        logger.info('[Policy] Name NOT available, using fallback intent.');
        return { kind: 'internal', intent: 'fallback_greet' };
    },

    shield: (_m, action, _mem) => {
        // Unconditionally allow
        return { action: 'pass', intent: action };
    },

    execution: async (action: Intent, ctx: TaskContext, _mem: MemoryReader, _m: MentalState<Sensory>) => {
        if (action.kind === 'internal' && action.intent === 'generate_greeting') {
            const name = (action.data as { name: string })?.name || 'World';

            try {
                if (!ctx.llm) {
                    throw new Error('LLM not configured in context');
                }

                logger.info('[Execution] Generating structured greeting using LLM...');
                const prompt = `Generate a short greeting for the user named "${name}".`;
                const responses = await ctx.llm.call(prompt, {
                    jsonSchema: { name: 'GreetingParams', schema: GreetingSchema }
                });

                const result = responses[0]?.contentObject;

                if (!result) {
                    throw new Error('LLM failed to produce structured output based on contract');
                }

                logger.info('[Execution] LLM generation successful.', { result });
                return {
                    action: { kind: 'internal', done: false } satisfies ExecutableAction,
                    result: { status: 'ok', data: { kind: 'greeting_completed', payload: result } } satisfies ExecResult<HelloExecData>
                };
            } catch (error) {
                logger.error('[Execution] LLM error', { error: error instanceof Error ? error.message : String(error) });
                return {
                    action: { kind: 'internal', done: false } satisfies ExecutableAction,
                    result: { status: 'error', error: { code: 'llm_error', message: 'Failed to generate greeting' } } satisfies ExecResult<HelloExecData>
                };
            }
        }

        if (action.kind === 'internal' && action.intent === 'complete') {
            const { greeting, emoji } = action.data as { greeting: string, emoji: string };
            const processedAt = new Date().toISOString();

            logger.info('[Execution] Dispatching reply with completed LLM text');
            await ctx.reply([{
                type: 'text',
                text: `${greeting} ${emoji}\n\nProcessed at: ${processedAt}\n\n(Generated via canonical LLM Flow in APLRET)`
            }]);

            return {
                action: { kind: 'internal', done: true } satisfies ExecutableAction,
                result: { status: 'ok', data: { greeting, processedAt } } satisfies ExecResult<HelloExecData>
            };
        }

        if (action.kind === 'internal' && action.intent === 'fallback_greet') {
            const processedAt = new Date().toISOString();
            await ctx.reply([{
                type: 'text',
                text: `Hello, World! 👋\n\nProcessed at: ${processedAt}\n\n(Generated via fallback)`
            }]);
            return {
                action: { kind: 'internal', done: true } satisfies ExecutableAction,
                result: { status: 'ok', data: { greeting: 'Hello, World!', processedAt } } satisfies ExecResult<HelloExecData>
            };
        }

        return {
            action: { kind: 'internal', done: true } satisfies ExecutableAction,
            result: {
                status: 'error',
                error: { code: 'unknown_intent', message: `Unhandled action: ${(action as any).kind || 'unknown'}` }
            } satisfies ExecResult<HelloExecData>
        };
    },

    transition: (_env: EnvironmentState, exec: { action: ExecutableAction; result: ExecResult<HelloExecData> }, _m: MentalState<Sensory>): TransitionOut => {
        if (exec.action.kind === 'internal' && exec.action.done) {
            logger.info('[Transition] Completing loop successfully.');
            return { kind: 'complete', result: exec.result.data };
        }

        if (exec.result.status === 'ok' && exec.result.data?.kind === 'greeting_completed') {
            logger.info('[Transition] Emitting observation for generated greeting.');
            return {
                kind: 'continue',
                observations: [{
                    source: 'internal',
                    kind: 'state.noted',
                    payload: exec.result.data.payload
                }]
            };
        }

        logger.warn('[Transition] Failed or continuing without observation.', exec.result);
        return { kind: 'fail', reason: 'execution_error' };
    }
}, import.meta.url);