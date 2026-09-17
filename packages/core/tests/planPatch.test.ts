import { describe, expect, it } from '@jest/globals';
import { createTestHarness } from '../src/testing/TestHarness.js';
import { PlanSchema, type Plan } from '../src/types/plan.js';
import {
    applyPlanPatch,
    diffPlanGraph,
    PlanPatchSchema,
    validatePlanPatch,
    type PlanPatch,
} from '../src/plans/planPatch.js';
import type { Intent } from '../src/types/intent.js';
import type { Observation } from '../src/types/observation.js';

const basePlan = (): Plan =>
    PlanSchema.parse({
        id: 'p1',
        status: 'active',
        revision: 2,
        cursor: 1,
        steps: [
            { id: 'A', kind: 'action', title: 'a' },
            { id: 'B', kind: 'action', title: 'b', dependsOn: ['A'] },
            { id: 'C', kind: 'action', title: 'c', dependsOn: ['B'] },
        ],
    });

describe('applyPlanPatch / validatePlanPatch', () => {
    it('add_step then graph still parses', () => {
        const plan = basePlan();
        const patch = PlanPatchSchema.parse({
            baseRevision: 2,
            operations: [
                { op: 'add_step', step: { id: 'D', kind: 'internal', title: 'd' } },
            ],
        });
        const result = applyPlanPatch(plan, patch);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.plan.revision).toBe(2);
            expect(PlanSchema.safeParse(result.plan).success).toBe(true);
            expect(result.plan.steps.map((s) => s.id)).toEqual(['A', 'B', 'C', 'D']);
        }
    });

    it('remove_step strips downstream dependsOn', () => {
        const result = applyPlanPatch(
            basePlan(),
            PlanPatchSchema.parse({
                baseRevision: 2,
                operations: [{ op: 'remove_step', stepId: 'A' }],
            })
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.plan.steps.map((s) => s.id)).toEqual(['B', 'C']);
            expect(result.plan.steps.find((s) => s.id === 'B')?.dependsOn).toBeUndefined();
        }
    });

    it('remove_step that would OOB cursor succeeds and clamps cursor to steps.length', () => {
        const plan = PlanSchema.parse({
            id: 'p1',
            revision: 0,
            cursor: 2,
            steps: [
                { id: 'A', kind: 'internal', title: 'a' },
                { id: 'B', kind: 'internal', title: 'b' },
            ],
        });
        const result = applyPlanPatch(
            plan,
            PlanPatchSchema.parse({
                baseRevision: 0,
                operations: [{ op: 'remove_step', stepId: 'B' }],
            })
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.plan.steps).toHaveLength(1);
            expect(result.plan.cursor).toBe(1);
        }
    });

    it('set_cursor 0 after deleting a prefix resets cursor to 0', () => {
        const plan = PlanSchema.parse({
            id: 'p1',
            revision: 0,
            cursor: 2,
            steps: [
                { id: 'A', kind: 'internal', title: 'a' },
                { id: 'B', kind: 'internal', title: 'b' },
                { id: 'C', kind: 'internal', title: 'c' },
            ],
        });
        const result = applyPlanPatch(
            plan,
            PlanPatchSchema.parse({
                baseRevision: 0,
                operations: [
                    { op: 'remove_step', stepId: 'A' },
                    { op: 'remove_step', stepId: 'B' },
                    { op: 'set_cursor', cursor: 0 },
                ],
            })
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.plan.steps.map((s) => s.id)).toEqual(['C']);
            expect(result.plan.cursor).toBe(0);
        }
    });

    it('set_cursor past steps.length returns PLAN_CURSOR_OUT_OF_BOUNDS', () => {
        const result = applyPlanPatch(
            basePlan(),
            PlanPatchSchema.parse({
                baseRevision: 2,
                operations: [{ op: 'set_cursor', cursor: 99 }],
            })
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errors.map((e) => e.errorCode)).toContain('PLAN_CURSOR_OUT_OF_BOUNDS');
        }
    });

    it('update_step cannot change id', () => {
        expect(
            PlanPatchSchema.safeParse({
                baseRevision: 2,
                operations: [{ op: 'update_step', stepId: 'A', patch: { id: 'Z', title: 'renamed' } }],
            }).success
        ).toBe(false);
        const result = applyPlanPatch(
            basePlan(),
            PlanPatchSchema.parse({
                baseRevision: 2,
                operations: [{ op: 'update_step', stepId: 'A', patch: { title: 'renamed' } }],
            })
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.plan.steps.find((s) => s.id === 'A')?.title).toBe('renamed');
            expect(result.plan.steps.some((s) => s.id === 'Z')).toBe(false);
        }
    });

    it('add_dependency cycle fails with PLAN_DEPENDENCY_CYCLE', () => {
        const result = applyPlanPatch(
            basePlan(),
            PlanPatchSchema.parse({
                baseRevision: 2,
                operations: [{ op: 'add_dependency', stepId: 'A', dependsOn: 'C' }],
            })
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errors.map((e) => e.errorCode)).toContain('PLAN_DEPENDENCY_CYCLE');
        }
    });

    it('wrong baseRevision returns PLAN_PATCH_REVISION_MISMATCH', () => {
        const result = applyPlanPatch(
            basePlan(),
            PlanPatchSchema.parse({
                baseRevision: 0,
                operations: [{ op: 'set_cursor', cursor: 0 }],
            })
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errors.map((e) => e.errorCode)).toContain('PLAN_PATCH_REVISION_MISMATCH');
        }
    });

    it('validatePlanPatch never throws', () => {
        expect(() => validatePlanPatch(basePlan(), undefined)).not.toThrow();
        expect(() => validatePlanPatch(basePlan(), { operations: [] })).not.toThrow();
        const invalid = validatePlanPatch(basePlan(), { extra: true });
        expect(invalid.ok).toBe(false);
        if (!invalid.ok) expect(invalid.errors[0].errorCode).toBe('PLAN_PATCH_INVALID');
    });
});

describe('diffPlanGraph', () => {
    it('reports addedSteps and addedDependencies for add+edge', () => {
        const before = PlanSchema.parse({
            id: 'p1',
            steps: [{ id: 'A', kind: 'internal', title: 'a' }],
        });
        const after = PlanSchema.parse({
            id: 'p1',
            steps: [
                { id: 'A', kind: 'internal', title: 'a' },
                { id: 'B', kind: 'internal', title: 'b', dependsOn: ['A'] },
            ],
        });
        const diff = diffPlanGraph(before, after);
        expect(diff.addedSteps).toEqual(['B']);
        expect(diff.addedDependencies).toEqual([{ stepId: 'B', dependsOn: 'A' }]);
        expect(diff.removedSteps).toEqual([]);
    });
});

describe('default Learning plan.patch', () => {
    it('applies a valid patch and bumps revision', async () => {
        const plan = PlanSchema.parse({
            id: 'p1',
            revision: 1,
            steps: [{ id: 'A', kind: 'internal', title: 'a' }],
        });
        const patch: PlanPatch = PlanPatchSchema.parse({
            baseRevision: 1,
            operations: [{ op: 'add_step', step: { id: 'B', kind: 'internal', title: 'b' } }],
        });
        const h = createTestHarness({
            policy: () => ({ kind: 'wait' } as Intent),
        });
        h.seedMentalState({
            plans: { plans: { p1: plan }, activePlanId: 'p1' },
        });
        h.injectObservation({
            source: 'internal',
            kind: 'plan.patch',
            payload: { planId: 'p1', patch },
        });
        await h.runTurn();
        const after = h.currentM().plans?.plans?.p1;
        expect(after?.steps.map((s) => s.id)).toEqual(['A', 'B']);
        expect(after?.revision).toBe(2);
        expect(after?.lineage?.parentRevision).toBe(1);
    });

    it('replaces a bad patch with validation.failed and leaves M unchanged', async () => {
        const plan = PlanSchema.parse({
            id: 'p1',
            revision: 1,
            steps: [{ id: 'A', kind: 'internal', title: 'a' }],
        });
        const h = createTestHarness({
            policy: () => ({ kind: 'wait' } as Intent),
        });
        h.seedMentalState({
            plans: { plans: { p1: plan }, activePlanId: 'p1' },
        });
        h.injectObservation({
            source: 'internal',
            kind: 'plan.patch',
            payload: { planId: 'p1', patch: { baseRevision: 1, operations: [] } },
        } as unknown as Observation);
        await h.runTurn();
        expect(h.lastTrace().inboxCurrent.map((o) => o.kind)).toContain('validation.failed');
        expect(h.currentM().plans?.plans?.p1?.steps.map((s) => s.id)).toEqual(['A']);
        expect(h.currentM().plans?.plans?.p1?.revision).toBe(1);
    });
});

describe('default Transition data.planPatch', () => {
    it('maps result.data.planPatch to Learning applyPlanPatch', async () => {
        const plan = PlanSchema.parse({
            id: 'p1',
            revision: 1,
            steps: [{ id: 'A', kind: 'internal', title: 'a' }],
        });
        const patch: PlanPatch = PlanPatchSchema.parse({
            baseRevision: 1,
            operations: [{ op: 'add_step', step: { id: 'B', kind: 'internal', title: 'b' } }],
        });
        let dispatched = false;
        const h = createTestHarness({
            execution: async () => {
                if (!dispatched) {
                    dispatched = true;
                    return {
                        action: { kind: 'internal', done: false },
                        result: {
                            status: 'ok' as const,
                            ts: Date.now(),
                            data: { planPatch: { planId: 'p1', patch } },
                            toolId: 'internal',
                        },
                    };
                }
                return {
                    action: { kind: 'internal', done: false },
                    result: {
                        status: 'ok' as const,
                        ts: Date.now(),
                        data: { intent: 'wait', done: false },
                        toolId: 'internal',
                    },
                };
            },
            policy: () => ({ kind: 'wait' } as Intent),
        });
        h.seedMentalState({
            plans: { plans: { p1: plan }, activePlanId: 'p1' },
        });
        await h.runTurn();
        await h.runTurn();
        const after = h.currentM().plans?.plans?.p1;
        expect(after?.steps.map((s) => s.id)).toEqual(['A', 'B']);
        expect(after?.revision).toBe(2);
    });

    it('plan.updated still rejects a patch object', async () => {
        const plan = PlanSchema.parse({
            id: 'p1',
            revision: 1,
            steps: [{ id: 'A', kind: 'internal', title: 'a' }],
        });
        const patch: PlanPatch = PlanPatchSchema.parse({
            baseRevision: 1,
            operations: [{ op: 'add_step', step: { id: 'B', kind: 'internal', title: 'b' } }],
        });
        expect(PlanSchema.safeParse({ planId: 'p1', patch }).success).toBe(false);
        let dispatched = false;
        const h = createTestHarness({
            execution: async () => {
                if (!dispatched) {
                    dispatched = true;
                    return {
                        action: { kind: 'internal', done: false },
                        result: {
                            status: 'ok' as const,
                            ts: Date.now(),
                            data: { planUpdated: { planId: 'p1', patch } },
                            toolId: 'internal',
                        },
                    };
                }
                return {
                    action: { kind: 'internal', done: false },
                    result: {
                        status: 'ok' as const,
                        ts: Date.now(),
                        data: { intent: 'wait', done: false },
                        toolId: 'internal',
                    },
                };
            },
            policy: () => ({ kind: 'wait' } as Intent),
        });
        h.seedMentalState({
            plans: { plans: { p1: plan }, activePlanId: 'p1' },
        });
        await h.runTurn();
        await h.runTurn();
        expect(h.currentM().plans?.plans?.p1?.steps.map((s) => s.id)).toEqual(['A']);
        expect(h.currentM().plans?.plans?.p1?.revision).toBe(1);
    });
});
