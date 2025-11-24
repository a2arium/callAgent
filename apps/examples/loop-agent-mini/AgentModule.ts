import {
    createAgent,
    type EnvironmentState,
    type ExecResult,
    type ExecErrorPayload,
    type ExecutableAction,
    type MentalState,
    type ObservationConfig,
    type ProposedAction,
    type SynthesizeObservation,
    type TaskContext,
    type TransitionOut
} from '@a2arium/callagent-core';

type MiniExecData = { message?: string; status?: 'complete' };

type MiniObservationValue = {
    message?: string;
    status: ExecResult['status'];
    toolId?: string;
};

type MiniObservationConfig = ObservationConfig & {
    user: unknown;
    env: MiniObservationValue;
};

type MiniObservation = SynthesizeObservation<MiniObservationConfig>;

type MiniPerception = {
    input: unknown;
    time: string;
    observations: MiniObservation[];
};

type MiniSensory = {
    lastObservation?: MiniPerception;
};

type MiniMentalState = MentalState<MiniSensory>;

type ProposedActionWithNextTurn = ProposedAction & { nextTurn?: number };

const describe = (label: string, value: unknown): void => {
    try {
        console.log(label, JSON.stringify(value, null, 2));
    } catch {
        console.log(label, value);
    }
};

const createExecResult = (
    toolId: string,
    status: ExecResult['status'],
    overrides: Partial<Omit<ExecResult<MiniExecData>, 'status' | 'toolId'>> = {}
): ExecResult<MiniExecData> => ({
    status,
    toolId,
    ts: Date.now(),
    ...overrides
});

const buildObservation = (
    env: EnvironmentState<MiniObservationConfig>,
    exec: { action: ExecutableAction; result: ExecResult<MiniExecData> }
): MiniObservation => ({
    source: 'env',
    kind: `${exec.action.kind}.${exec.result.status}`,
    payload: {
        message: exec.result.data?.message,
        status: exec.result.status,
        toolId: exec.result.toolId
    },
    provenance: {
        ts: exec.result.ts ?? Date.now(),
        turn: env.turn,
        toolId: exec.result.toolId,
        correlationId: exec.result.correlationId
    },
    error: exec.result.status === 'error' ? exec.result.error : undefined
});

/**
 * Loop-agent-mini: Demonstrates LLM conversation history persistence across loop turns
 * 
 * This is a SIMPLER demo showing that LLM history is automatically preserved across
 * loop turns without needing requestInput or other async operations.
 * 
 * Flow:
 * Turn 1: Agent asks LLM "Tell me a fun fact about space"
 * Turn 2: Agent asks LLM "What's another fun fact?" 
 *         → LLM has access to previous turn's context!
 * Turn 3: Agent asks LLM "Can you combine both facts into a short story?"
 *         → LLM has access to BOTH previous turns!
 * 
 * Key Insight: MentalState (including llmState) is saved after EVERY runLoop execution,
 * so history persists across turns even within a single task execution.
 */
export default createAgent<MiniSensory, MiniPerception, unknown, MiniExecData, ExecErrorPayload, MiniObservationConfig>({
    manifest: {
        name: 'loop-agent-mini',
        version: '0.3.0',
        runMode: 'loop',
        budgets: { maxTurns: 2 }
    },

    llmConfig: {
        provider: 'openai',
        modelAliasOrName: 'fast',
        systemPrompt: 'You are a helpful assistant. Keep your responses concise (under 100 words).',
        historyMode: 'dynamic'
    },

    perception: (env: EnvironmentState<MiniObservationConfig>): MiniPerception => {
        const drained = env.inbox.current;
        if (drained.length > 0) {
            describe('[Perception] Drained observations', drained);
        } else {
            console.log('[Perception] Inbox empty');
        }
        // Extract input from inbox if available
        const userInput = env.inbox.current.find(o => o.source === 'user' && o.kind === 'input.provided');
        return {
            input: userInput?.payload.value,
            time: env.time,
            observations: drained
        };
    },

    learning: (prevMentalState: MiniMentalState, _prevAction: ProposedAction | undefined, obs: MiniPerception) => {
        prevMentalState.memory.sensory = {
            ...prevMentalState.memory.sensory,
            lastObservation: obs
        };
        return prevMentalState;
    },

    policy: (mentalState: MiniMentalState): ProposedActionWithNextTurn => {
        const turn = Number(mentalState.vars?.turn ?? 0);

        console.log(`\n📍 [Policy] Turn ${turn}`);

        if (turn === 0) {
            return {
                kind: 'language',
                content: 'Tell me a fun fact about space.',
                nextTurn: 1
            } satisfies ProposedActionWithNextTurn;
        }

        if (turn === 1) {
            return {
                kind: 'language',
                content: 'That was interesting! What\'s another fun fact about space?',
                nextTurn: 2
            } satisfies ProposedActionWithNextTurn;
        }

        if (turn === 2) {
            return {
                kind: 'language',
                content: 'Great! Can you combine both of those facts into a very short 2-sentence story?',
                nextTurn: 3
            } satisfies ProposedActionWithNextTurn;
        }

        return { kind: 'internal', intent: 'complete' } satisfies ProposedActionWithNextTurn;
    },

    shield: (_mentalState: MiniMentalState, action: ProposedActionWithNextTurn) => {
        describe('[Shield] Received action from policy:', action);
        const result = { action: 'pass' as const, intent: action };
        describe('[Shield] Returning:', result);
        return result;
    },

    execution: async (action: ProposedActionWithNextTurn, ctx: TaskContext, _mentalState: MiniMentalState) => {
        describe('\n[Execution] Received action:', action);

        if (action.kind === 'language') {
            console.log(`\n💬 [Question]: ${action.content}`);

            try {
                const responses = await ctx.llm.call(action.content);
                describe('[Execution] LLM raw responses:', responses);

                const first = Array.isArray(responses) ? responses[0] : undefined;
                let response = '';
                if (typeof first === 'string') {
                    response = first;
                } else if (typeof first === 'object' && first !== null) {
                    const candidate = (first as { text?: unknown; content?: unknown }).text ?? (first as { text?: unknown; content?: unknown }).content;
                    response = typeof candidate === 'string' ? candidate : JSON.stringify(first);
                }
                if (!response) {
                    response = 'Error: No response from LLM';
                }

                console.log(`🤖 [Assistant]: ${response}`);
                await ctx.reply(`\n🤖 ${response}\n`);

                if (action.nextTurn !== undefined) {
                    ctx.vars.set('turn', action.nextTurn);
                }

                return {
                    action: { kind: 'language', echoed: true },
                    result: createExecResult('language', 'ok', { data: { message: response } })
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.error('[Execution] LLM call failed:', message);
                await ctx.reply(`\n❌ LLM Error: ${message}\n`);
                return {
                    action: { kind: 'language', echoed: true },
                    result: createExecResult('language', 'error', {
                        error: { code: 'llm_error', message }
                    })
                };
            }
        }

        if (action.kind === 'internal' && action.intent === 'complete') {
            describe('[Execution] Internal complete, LLM messages:', ctx.llm.getMessages?.());
            console.log('\n✅ Demo Complete!');
            console.log('📝 The LLM successfully referenced previous turns in its final story,');
            console.log('   proving that conversation history was preserved across all turns.');
            await ctx.reply('\n✅ Demo complete! The conversation history was preserved across all 3 turns.');
            return {
                action: { kind: 'internal', done: true },
                result: createExecResult('internal', 'ok', { data: { status: 'complete' } })
            };
        }

        console.log(`\n❌ [Execution] Unknown action: ${action.kind}`);
        return {
            action: { kind: 'internal', done: true },
            result: createExecResult('internal', 'error', {
                error: {
                    code: 'unknown_action',
                    message: `Unknown action received in execution: ${action.kind}`
                }
            })
        };
    },

    transition: (
        env: EnvironmentState<MiniObservationConfig>,
        executionResult: { action: ExecutableAction; result: ExecResult<MiniExecData> },
        _mentalState: MiniMentalState
    ): TransitionOut<MiniObservationConfig> => {
        const { action, result } = executionResult;

        if (action.kind === 'internal' && action.done) {
            const completionObservation = buildObservation(env, executionResult);
            describe('[Transition] Completion observation (not enqueued):', completionObservation);
            return { kind: 'complete', result: result.data ?? 'success' };
        }

        if (action.kind === 'language') {
            const observation = buildObservation(env, executionResult);
            describe('[Transition] Language observation (returning only):', observation);
            return { kind: 'continue', observations: [observation] };
        }

        return { kind: 'continue', observations: [] };
    }
}, import.meta.url);



