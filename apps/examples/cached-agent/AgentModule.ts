import { createAgent } from '@a2arium/callagent-core';
import type { EnvironmentState, MentalState, ProposedAction, ExecutableAction, TurnOutcome, TaskContext, Modules, ExecResult } from '@a2arium/callagent-core';
import { match, P } from 'ts-pattern';
import { logger } from '@a2arium/callagent-utils';

// Minimal APLRET agent to test agent-level caching of transition result
type Sensory = { payload?: unknown };
type Obs = { payload?: unknown };

const modules: Partial<Modules<Sensory, Obs>> = {
    attention: (_m: MentalState<Sensory>, env: EnvironmentState) => ({ hasInput: env.inbox.current.length > 0 }),
    perception: (env: EnvironmentState) => {
        const userInput = env.inbox.current.find(o => o.source === 'user' && o.kind === 'input.provided');
        return { payload: (userInput?.payload as any)?.value };
    },
    learning: (prev: MentalState<Sensory>, _action: ProposedAction | undefined, obs: Obs) => ({
        ...prev,
        memory: { ...prev.memory, sensory: { payload: obs.payload } }
    }),
    policy: (m: MentalState<Sensory>): ProposedAction => {
        const hasPayload = typeof m.memory?.sensory?.payload !== 'undefined';
        return hasPayload
            ? ({ kind: 'internal', intent: 'process', data: { ok: true } } as const)
            : ({ kind: 'internal', intent: 'no_input' } as const);
    },
    shield: (_m: MentalState<Sensory>, a: ProposedAction) => ({ action: 'pass', intent: a } as const),
    execution: async (a: ProposedAction, ctx: TaskContext, _m: MentalState<Sensory>) => {
        const baseResult = (): ExecResult => ({ status: 'ok', ts: Date.now(), toolId: 'cached-agent' });

        return await match(a)
            .with({ kind: 'internal', intent: 'process', data: P.select() }, async () => {
                const started = Date.now();
                const randomValue = Math.floor(Math.random() * 1000000);
                ctx.progress(5, `processing... (random=${randomValue})`);
                await new Promise((r) => setTimeout(r, 200));
                const elapsed = Date.now() - started;
                ctx.progress(95, `done in ${elapsed}ms`);
                logger.info(`Execution completed with random=${randomValue}`);
                return {
                    action: { kind: 'internal', done: true } as ExecutableAction,
                    result: { ...baseResult(), data: { ok: true, randomValue, elapsedMs: elapsed } }
                };
            })
            .with({ kind: 'internal', intent: 'no_input' }, async () => ({
                action: { kind: 'internal', done: true } as ExecutableAction,
                result: { ...baseResult(), data: { ok: false, reason: 'no_input' } }
            }))
            .otherwise(async () => ({
                action: { kind: 'internal', done: true } as ExecutableAction,
                result: baseResult()
            }));
    },
    transition: (_env: EnvironmentState, exec: { action: ExecutableAction; result: ExecResult }, _m: MentalState<Sensory>): TurnOutcome => {
        const payload = typeof exec.result.data !== 'undefined' ? exec.result.data : { ok: true };
        return { kind: 'complete', result: payload } as TurnOutcome;
    }
};

export default createAgent<Sensory, Obs>({
    manifest: 'agent.json',
    loop: { modules }
}, import.meta.url);