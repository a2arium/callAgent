import { createAgent } from '@a2arium/callagent-core';
import type { EnvironmentState, MentalState, ProposedAction, ExecutableAction, TurnOutcome, TaskContext } from '@a2arium/callagent-core';
import { match, P } from 'ts-pattern';

// Minimal APLRET agent to test agent-level caching of transition result
type Sensory = { payload?: unknown };
type Obs = { payload?: unknown };

export default createAgent<Sensory, Obs>({
    manifest: 'agent.json',

    // A - Attention
    attention: (_m: MentalState<Sensory>, env: EnvironmentState) => ({ hasInput: Boolean(env.input) }),

    // P - Perception: normalize the initial input as-is
    perception: (env: EnvironmentState): Obs => ({ payload: env.input }),

    // L - Learning: store sensory snapshot
    learning: (prev: MentalState<Sensory>, _action: ProposedAction | undefined, obs: Obs): MentalState<Sensory> => ({
        ...prev,
        memory: { ...prev.memory, sensory: { payload: obs.payload } }
    }),

    // R - Policy: proceed if we have any payload
    policy: (m: MentalState<Sensory>): ProposedAction => {
        const hasPayload = typeof m.memory?.sensory?.payload !== 'undefined';
        return hasPayload
            ? ({ kind: 'internal', intent: 'process', data: { ok: true } } as const)
            : ({ kind: 'internal', intent: 'no_input' } as const);
    },

    // S - Shield
    shield: (_m: MentalState<Sensory>, a: ProposedAction) => ({ action: 'pass', intent: a } as const),

    // E - Execution: generate random number to verify cache hit (same number = cached)
    execution: async (a: ProposedAction, ctx: TaskContext): Promise<ExecutableAction> => {
        return await match(a)
            .with({ kind: 'internal', intent: 'process', data: P.select() }, async () => {
                const started = Date.now();
                const randomValue = Math.floor(Math.random() * 1000000);
                ctx.progress(5, `processing... (random=${randomValue})`);
                await new Promise((r) => setTimeout(r, 200));
                const elapsed = Date.now() - started;
                ctx.progress(95, `done in ${elapsed}ms`);
                ctx.logger.info(`Execution completed with random=${randomValue}`);
                // Return random number - if cache works, subsequent runs will return same number
                return { kind: 'internal', done: true, result: { ok: true, randomValue, elapsedMs: elapsed } } as unknown as ExecutableAction;
            })
            .with({ kind: 'internal', intent: 'no_input' }, async () => {
                ctx.progress(100, 'No input provided');
                return { kind: 'internal', done: true, result: { ok: false, reason: 'no_input' } } as unknown as ExecutableAction;
            })
            .otherwise(async () => ({ kind: 'internal', done: true } as ExecutableAction));
    },

    // T - Transition: produce final TurnOutcome with result -> cached by runner
    transition: (_env: EnvironmentState, exec: ExecutableAction, _m: MentalState<Sensory>): TurnOutcome => {
        const hasResult = (e: unknown): e is { result: unknown } => typeof e === 'object' && e !== null && 'result' in (e as Record<string, unknown>);
        return match(exec)
            .with({ kind: 'internal', done: true }, (e) => ({ kind: 'complete', result: hasResult(e) ? (e as { result: unknown }).result : { ok: true } } as TurnOutcome))
            .otherwise(() => ({ kind: 'complete', result: { ok: true } } as TurnOutcome));
    }
}, import.meta.url);