import { createAgent } from '@a2arium/callagent-core';
import type {
    TaskContext,
    MentalState,
    ExecutableAction,
    EnvironmentState,
    AttentionSignal,
    ExecResult,
    ProposedAction,
    ObservationConfig
} from '@a2arium/callagent-core';

// === Types ===
type Stage = 'waiting_for_start' | 'waiting_for_click' | 'done';

type Sensory = {
    text?: string;
    payload?: string;
};

type Obs = {
    type: 'start' | 'button_click' | 'idle';
    text?: string;
    payload?: string;
};

export default createAgent<Sensory, Obs, AttentionSignal, unknown, any, any>({
    manifest: {
        name: 'echo-button-persistent-test',
        version: '1.0.0',
        description: 'APLRET reproduction of button interactions and resume state',
        runMode: 'loop',
        budgets: { maxTurns: 10 }
    },

    llmConfig: {
        provider: 'openai',
        modelAliasOrName: 'fast',
        systemPrompt: 'Internal test agent for reproduction.'
    },

    // A - Attention
    attention: (m, env): AttentionSignal => {
        return { wantPrompt: env.inbox.current.length === 0 };
    },

    // P - Perception
    perception: (env: EnvironmentState): Obs => {
        const userObs = env.inbox.current.find(o => o.source === 'user');
        if (!userObs) return { type: 'idle' };

        const value = userObs.payload.value;
        const text = typeof value === 'string' ? value : (value as any)?.text;

        if (text === '/start') {
            return { type: 'start' };
        }

        // Button clicks often come as the payload text or in a data field
        return { type: 'button_click', payload: text };
    },

    // L - Learning
    learning: (prev, _action, obs: Obs): MentalState<Sensory> => {
        if (obs.type === 'start') {
            return {
                ...prev,
                memory: {
                    ...prev.memory,
                    vars: { ...prev.memory.vars, stage: 'waiting_for_click' as Stage },
                    sensory: { text: '/start' }
                }
            };
        }
        if (obs.type === 'button_click') {
            return {
                ...prev,
                memory: {
                    ...prev.memory,
                    vars: { ...prev.memory.vars, stage: 'done' as Stage },
                    sensory: { payload: obs.payload }
                }
            };
        }
        return prev;
    },

    // R - Policy
    policy: (m: MentalState<Sensory>): ProposedAction => {
        const stage = (m.memory.vars?.stage as Stage) ?? 'waiting_for_start';

        if (stage === 'waiting_for_start') {
            return { kind: 'internal', intent: 'ask_to_start' } as any;
        }
        if (stage === 'waiting_for_click') {
            return { kind: 'internal', intent: 'send_button' } as any;
        }
        if (stage === 'done') {
            return { kind: 'internal', intent: 'echo_payload' } as any;
        }

        return { kind: 'internal', intent: 'wait' } as any;
    },

    // S - Shield
    shield: (_m, intent) => ({ action: 'pass', intent }),

    // E - Execution
    execution: async (action: ProposedAction, ctx: TaskContext, _mem: any, m: MentalState<Sensory>): Promise<{
        action: ExecutableAction;
        result: ExecResult<unknown>;
    }> => {
        const intent = (action as any).intent;

        if (intent === 'send_button') {
            const handle = await ctx.requestInput([
                { type: 'text', text: '👋 APLRET: Click to test persistence.' },
                {
                    type: 'data',
                    value: {
                        template: 'button',
                        label: 'Click Me',
                        payload: 'hello_from_button'
                    }
                }
            ]);
            // CRITICAL FIX: Return 'ask_user' action so LoopRunner knows to pause (outcome: await_input).
            // Without this, it defaults to 'internal' -> 'continue' -> infinite loop.
            return {
                action: { kind: 'ask_user', token: handle.token } as any,
                result: { status: 'ok' }
            };
        }

        if (intent === 'echo_payload') {
            const payload = m.memory.sensory?.payload;
            await ctx.reply(`✅ APLRET Success! Payload received: ${payload}`);
            ctx.complete(100, 'done');
            return {
                action: { kind: 'internal', done: true },
                result: { status: 'ok' }
            };
        }

        return {
            action: { kind: 'internal', done: false },
            result: { status: 'ok', ts: Date.now() }
        };
    }
}, import.meta.url);
