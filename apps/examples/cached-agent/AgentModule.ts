import { createAgent } from '@a2arium/callagent-core';
import type {
    EnvironmentState,
    MentalState,
    ProposedAction,
    ExecutableAction,
    TurnOutcome,
    TaskContext,
    Modules,
    ExecResult,
    ExecErrorPayload,
    ObservationConfig,
    SynthesizeObservation
} from '@a2arium/callagent-core';
import { match, P } from 'ts-pattern';
import { logger } from '@a2arium/callagent-utils';

type Sensory = { payload?: unknown };

type CachedObservationConfig = ObservationConfig & {
    user: unknown;
    tool: unknown;
    child: unknown;
    env: unknown;
    internal: { value?: unknown };
};

type InboxObservation = SynthesizeObservation<CachedObservationConfig>;

const createIdleObservation = (): InboxObservation => ({
    source: 'internal',
    kind: 'internal.idle',
    payload: { value: undefined }
});

const modules: Partial<Modules<Sensory, InboxObservation, unknown, unknown, ExecErrorPayload, CachedObservationConfig>> = {
    attention: (_m: MentalState<Sensory>, env: EnvironmentState<CachedObservationConfig>) => ({ hasInput: env.inbox.current.length > 0 }),
    perception: (env: EnvironmentState<CachedObservationConfig>) => {
        return env.inbox.current[0] ?? createIdleObservation();
    },
    learning: (prev: MentalState<Sensory>, _action: ProposedAction | undefined, obs: InboxObservation) => {
        const payload = obs.source === 'user' ? obs.payload.value : undefined;
        return {
            ...prev,
            memory: { ...prev.memory, sensory: { payload } }
        };
    },
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
    transition: (_env: EnvironmentState<CachedObservationConfig>, exec: { action: ExecutableAction; result: ExecResult }, _m: MentalState<Sensory>): TurnOutcome<CachedObservationConfig> => {
        const payload = typeof exec.result.data !== 'undefined' ? exec.result.data : { ok: true };
        return { kind: 'complete', result: payload };
    }
};

export default createAgent<Sensory, InboxObservation, unknown, unknown, ExecErrorPayload, CachedObservationConfig>({
    manifest: 'agent.json',
    loop: { modules }
}, import.meta.url);