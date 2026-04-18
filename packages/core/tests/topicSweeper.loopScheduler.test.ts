import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { createTestHarness } from '../src/testing/TestHarness.js';
import type { Intent } from '../src/types/intent.js';
import type { Observation } from '../src/types/observation.js';
import { EngineLocator } from '../src/orchestration/EngineLocator.js';
import type { TaskEngine } from '../src/orchestration/taskEngine.js';

/** `continue` requires at least one observation (see `CONTINUE_WITHOUT_OBSERVATIONS`). */
function sweepTestContinue(turn: number): { kind: 'continue'; observations: Observation[] } {
    return {
        kind: 'continue',
        observations: [
            {
                source: 'internal',
                kind: 'state.noted',
                payload: { sweepTestTurn: turn },
            },
        ],
    };
}

describe('runLoop topicSweeper scheduling', () => {
    afterEach(() => {
        EngineLocator.setEngine(null as unknown as TaskEngine);
    });

    it('calls TaskEngine.triggerTopicLifecycleSweep on interval while the loop runs', async () => {
        const sweep = jest.fn().mockResolvedValue({ archivedTopicIds: [] });
        EngineLocator.setEngine({ triggerTopicLifecycleSweep: sweep } as unknown as TaskEngine);

        let turn = 0;
        const harness = createTestHarness(
            {
                attention: () => undefined as never,
                perception: () => ({ kind: 'idle' as const }),
                learning: (prev) => prev,
                policy: () => ({ kind: 'internal' as const, intent: 'noop', data: {} }),
                shield: (_m, intent: Intent) => ({ action: 'pass' as const, intent }),
                execution: async () => {
                    await new Promise<void>((resolve) => setTimeout(resolve, 35));
                    return {
                        action: { kind: 'internal' as const, done: true },
                        result: { status: 'ok' as const, data: {} },
                    };
                },
                transition: () => {
                    turn++;
                    if (turn < 4) {
                        return sweepTestContinue(turn);
                    }
                    return { kind: 'complete' as const };
                },
            },
            {
                maxTurns: 8,
                topicSweeper: {
                    intervalMs: 30,
                    batchSize: 7,
                    autoArchiveAfterMs: 60_000,
                },
            }
        );

        await harness.runTurn();

        expect(sweep).toHaveBeenCalled();
        expect(sweep.mock.calls[0]![0]).toMatchObject({
            tenantId: 'test-tenant',
            limit: 7,
            autoArchiveAfterMs: 60_000,
        });
    });

    it('schedules multiple sweeps when the loop runs long enough (wall clock)', async () => {
        const sweep = jest.fn().mockResolvedValue({ archivedTopicIds: [] });
        EngineLocator.setEngine({ triggerTopicLifecycleSweep: sweep } as unknown as TaskEngine);

        let turn = 0;
        const harness = createTestHarness(
            {
                attention: () => undefined as never,
                perception: () => ({ kind: 'idle' as const }),
                learning: (prev) => prev,
                policy: () => ({ kind: 'internal' as const, intent: 'noop', data: {} }),
                shield: (_m, intent: Intent) => ({ action: 'pass' as const, intent }),
                execution: async () => {
                    await new Promise<void>((resolve) => setTimeout(resolve, 3));
                    return {
                        action: { kind: 'internal' as const, done: true },
                        result: { status: 'ok' as const, data: {} },
                    };
                },
                transition: () => {
                    turn++;
                    if (turn < 40) {
                        return sweepTestContinue(turn);
                    }
                    return { kind: 'complete' as const };
                },
            },
            {
                maxTurns: 50,
                topicSweeper: {
                    intervalMs: 8,
                    batchSize: 3,
                    autoArchiveAfterMs: 60_000,
                },
            }
        );

        await harness.runTurn();

        expect(sweep.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
});
