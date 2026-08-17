import { describe, expect, it } from '@jest/globals';
import { createTestHarness } from '../src/testing/TestHarness.js';
import { PlanSchema } from '../src/types/plan.js';
import type { Intent } from '../src/types/intent.js';

describe('TestHarness snapshot / fork', () => {
    it('isolates MentalState: seedMentalState on fork A does not change fork B', () => {
        const plan = PlanSchema.parse({
            id: 'p1',
            steps: [{ id: 'A', kind: 'internal', title: 'original' }],
        });
        const parent = createTestHarness({
            policy: () => ({ kind: 'wait' } as Intent),
        });
        parent.seedMentalState({
            plans: { plans: { p1: plan }, activePlanId: 'p1' },
        });
        parent.seedPending({ tools: { tok: { name: 't' } } });
        const snap = parent.snapshot();
        const a = parent.fork(snap);
        const b = parent.fork(snap);
        a.seedMentalState({
            plans: { plans: { p1: { ...plan, steps: [{ id: 'A', kind: 'internal', title: 'changed' }] } } },
        });
        expect(b.currentM().plans?.plans?.p1?.steps[0]?.title).toBe('original');
        expect(a.currentM().plans?.plans?.p1?.steps[0]?.title).toBe('changed');
    });

    it('runTurn on fork A does not change fork B traces or M', async () => {
        const parent = createTestHarness({
            policy: () => ({ kind: 'complete', result: { ok: true } } as Intent),
        });
        parent.seedMentalState({
            memory: { sensory: { mark: 'seed' } },
        });
        const snap = parent.snapshot();
        const a = parent.fork(snap);
        const b = parent.fork(snap);
        const tracesBefore = b.allTraces().length;
        await a.runTurn();
        expect(b.allTraces().length).toBe(tracesBefore);
        expect(b.currentM().memory.sensory).toEqual(expect.objectContaining({ mark: 'seed' }));
        expect(a.lastTrace().transition?.kind).toBe('complete');
    });

    it('copies LLM stub queues so forks consume independently', async () => {
        const parent = createTestHarness({
            policy: () => ({ kind: 'answer_with_llm', query: 'q' } as Intent),
        });
        parent.llmStub().enqueue('hello from queue');
        const snap = parent.snapshot();
        const a = parent.fork(snap);
        const b = parent.fork(snap);
        await a.runTurn();
        await b.runTurn();
        expect(a.replies().some((r) => JSON.stringify(r).includes('hello from queue'))).toBe(true);
        expect(b.replies().some((r) => JSON.stringify(r).includes('hello from queue'))).toBe(true);
    });

    it('same randomSeed samples the same intent.kind on both forks', async () => {
        const parent = createTestHarness(
            {
                policy: () => [
                    { action: { kind: 'wait' } as Intent, prob: 0.5 },
                    { action: { kind: 'complete', result: true } as Intent, prob: 0.5 },
                ],
            },
            { randomSeed: 42 }
        );
        parent.seedMentalState({ policyParams: { stochastic: true } });
        const snap = parent.snapshot();
        const a = parent.fork(snap);
        const b = parent.fork(snap);
        await a.runTurn();
        await b.runTurn();
        expect(a.lastTrace().intent?.kind).toBe(b.lastTrace().intent?.kind);
    });

    it('snapshot is not live state: mutating parent after snapshot does not affect forks', () => {
        const parent = createTestHarness({
            policy: () => ({ kind: 'wait' } as Intent),
        });
        parent.seedMentalState({
            plans: {
                plans: {
                    p1: PlanSchema.parse({
                        id: 'p1',
                        steps: [{ id: 'A', kind: 'internal', title: 'before' }],
                    }),
                },
            },
        });
        const snap = parent.snapshot();
        parent.seedMentalState({
            plans: {
                plans: {
                    p1: PlanSchema.parse({
                        id: 'p1',
                        steps: [{ id: 'A', kind: 'internal', title: 'after' }],
                    }),
                },
            },
        });
        const child = parent.fork(snap);
        expect(child.currentM().plans?.plans?.p1?.steps[0]?.title).toBe('before');
    });
});
