import { jest } from '@jest/globals';
import { initialM } from '../src/loop/init.js';
import { runLoop } from '../src/loop/loopRunner.js';
import { normalizeObservationInbox, type EnvironmentState, type MentalState } from '../src/loop/types.js';
import type { TaskContext } from '../src/shared/types/index.js';

function context(): TaskContext {
    return {
        task: { id: 'provider-segment-budget-task', input: {} },
        agentId: 'segment-agent',
        logger: console,
    } as unknown as TaskContext;
}

function environment(maxTurns: number): EnvironmentState {
    return {
        time: new Date().toISOString(),
        sessionId: 'provider-segment-budget-task',
        turn: 1,
        budget: { maxTurns, latencyMs: Number.POSITIVE_INFINITY },
        pending: { inputs: {}, children: {}, tools: {}, groups: {} },
        inbox: normalizeObservationInbox(undefined),
        lastExec: undefined,
    };
}

function continuingModules(onTurn: () => boolean) {
    return {
        perception: (env: EnvironmentState) => ({
            inbox: env.inbox,
            time: env.time,
            pending: env.pending,
        }),
        learning: (previous: MentalState) => previous,
        policy: () => ({ kind: 'internal', intent: 'work' }),
        shield: (_m: MentalState, intent: unknown) => ({ action: 'pass', intent }),
        execution: async (intent: unknown) => ({
            action: intent,
            result: { status: 'ok', data: {} },
        }),
        transition: () => onTurn()
            ? { kind: 'complete', result: { ok: true } }
            : { kind: 'continue', observations: [] },
    };
}

describe('runLoop provider segment budgets', () => {
    afterEach(() => jest.restoreAllMocks());

    it('returns continue at segmentMaxTurns without exhausting the root turn budget', async () => {
        const ctx = context();
        const env = environment(100);
        let completedUnits = 0;

        const result = await runLoop(
            ctx,
            initialM(ctx),
            env,
            continuingModules(() => ++completedUnits >= 20) as any,
            { maxTurns: 100, segmentMaxTurns: 10 }
        );

        expect(completedUnits).toBe(10);
        expect(env.turn).toBe(10);
        expect(result.outcome).toMatchObject({ kind: 'continue' });
    });

    it('yields repeatedly across more than 3,920 internal units and preserves the root budget', async () => {
        const targetUnits = 3_921;
        const ctx = context();
        const env = environment(5_000);
        let completedUnits = 0;
        let state = initialM(ctx);
        let segmentCount = 0;

        while (completedUnits < targetUnits) {
            if (segmentCount > 0) env.turn += 1; // TaskExecutor starts each replacement segment.
            const result = await runLoop(
                ctx,
                state,
                env,
                continuingModules(() => ++completedUnits === targetUnits) as any,
                { maxTurns: 5_000, segmentMaxTurns: 10 }
            );
            state = result.M;
            segmentCount += 1;
            if (result.outcome.kind === 'complete') break;
            expect(result.outcome.kind).toBe('continue');
        }

        expect(completedUnits).toBe(targetUnits);
        expect(segmentCount).toBe(393);
        expect(env.turn).toBe(targetUnits);
    });

    it('yields after a completed turn when segmentLatencyMs is reached', async () => {
        const ctx = context();
        const env = environment(100);
        let completedUnits = 0;
        let now = 1_000;
        jest.spyOn(Date, 'now').mockImplementation(() => {
            now += 10;
            return now;
        });

        const result = await runLoop(
            ctx,
            initialM(ctx),
            env,
            continuingModules(() => {
                completedUnits += 1;
                return false;
            }) as any,
            { maxTurns: 100, segmentLatencyMs: 1 }
        );

        expect(completedUnits).toBe(1);
        expect(result.outcome.kind).toBe('continue');
    });
});
