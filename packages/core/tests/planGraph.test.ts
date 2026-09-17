import { describe, expect, it } from '@jest/globals';
import { PlanSchema } from '../src/types/plan.js';
import {
    getPlanAncestors,
    getPlanDependants,
    getPlanDescendants,
    selectBlockedPlanSteps,
    selectReadyPlanSteps,
    validatePlanGraph,
} from '../src/plans/planGraph.js';

const errorCodes = (input: unknown): string[] => {
    const result = validatePlanGraph(input);
    return result.ok ? [] : result.errors.map((e) => e.errorCode);
};

describe('validatePlanGraph', () => {
    it('accepts empty steps and never throws', () => {
        expect(() => validatePlanGraph({ id: 'p1', steps: [] })).not.toThrow();
        const result = validatePlanGraph({ id: 'p1', steps: [] });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.plan.steps).toEqual([]);
    });

    it('accepts linear A → B → C', () => {
        const result = validatePlanGraph({
            id: 'p1',
            steps: [
                { id: 'A', kind: 'internal', title: 'a' },
                { id: 'B', kind: 'internal', title: 'b', dependsOn: ['A'] },
                { id: 'C', kind: 'internal', title: 'c', dependsOn: ['B'] },
            ],
        });
        expect(result.ok).toBe(true);
    });

    it('accepts two independent pending steps', () => {
        const result = validatePlanGraph({
            id: 'p1',
            steps: [
                { id: 'A', kind: 'internal', title: 'a' },
                { id: 'B', kind: 'internal', title: 'b' },
            ],
        });
        expect(result.ok).toBe(true);
    });

    it('accepts duplicate dependsOn ids as one edge', () => {
        const result = validatePlanGraph({
            id: 'p1',
            steps: [
                { id: 'A', kind: 'internal', title: 'a' },
                { id: 'B', kind: 'internal', title: 'b', dependsOn: ['A', 'A'] },
            ],
        });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.plan.steps[1].dependsOn).toEqual(['A']);
    });

    it('maps missing / self / cycle / duplicate step id to the same codes as PlanSchema', () => {
        const missing = { id: 'p1', steps: [{ id: 's1', kind: 'internal', title: 't', dependsOn: ['missing'] }] };
        const self = { id: 'p1', steps: [{ id: 'A', kind: 'internal', title: 't', dependsOn: ['A'] }] };
        const cycle = {
            id: 'p1',
            steps: [
                { id: 'A', kind: 'internal', title: 'a', dependsOn: ['C'] },
                { id: 'B', kind: 'internal', title: 'b', dependsOn: ['A'] },
                { id: 'C', kind: 'internal', title: 'c', dependsOn: ['B'] },
            ],
        };
        const dup = {
            id: 'p1',
            steps: [
                { id: 's1', kind: 'internal', title: 'a' },
                { id: 's1', kind: 'internal', title: 'b' },
            ],
        };
        const graphCode = (input: unknown): string | undefined => {
            const parsed = PlanSchema.safeParse(input);
            if (parsed.success) return undefined;
            const custom = parsed.error.issues.find((i) => i.code === 'custom');
            const params = custom?.params;
            return params && typeof params === 'object' && 'errorCode' in params && typeof params.errorCode === 'string'
                ? params.errorCode
                : undefined;
        };
        expect(errorCodes(missing)).toContain('PLAN_DEPENDENCY_MISSING');
        expect(errorCodes(self)).toContain('PLAN_DEPENDENCY_SELF');
        expect(errorCodes(cycle)).toContain('PLAN_DEPENDENCY_CYCLE');
        expect(errorCodes(dup)).toContain('PLAN_DUPLICATE_STEP_ID');
        expect(errorCodes(missing)).toEqual(expect.arrayContaining([graphCode(missing)]));
        expect(errorCodes(self)).toEqual(expect.arrayContaining([graphCode(self)]));
        expect(errorCodes(cycle)).toEqual(expect.arrayContaining([graphCode(cycle)]));
        expect(errorCodes(dup)).toEqual(expect.arrayContaining([graphCode(dup)]));
    });

    it('rejects leftover description as PLAN_SCHEMA_INVALID without throwing', () => {
        const input = { id: 'p1', steps: [{ id: 's1', kind: 'internal', description: 'x' }] };
        expect(() => validatePlanGraph(input)).not.toThrow();
        expect(errorCodes(input)).toContain('PLAN_SCHEMA_INVALID');
    });

    it('rejects cursor out of bounds as PLAN_CURSOR_OUT_OF_BOUNDS without throwing', () => {
        const input = {
            id: 'p1',
            cursor: 3,
            steps: [{ id: 's1', kind: 'internal', title: 't' }],
        };
        expect(() => validatePlanGraph(input)).not.toThrow();
        expect(errorCodes(input)).toContain('PLAN_CURSOR_OUT_OF_BOUNDS');
    });
});

describe('selectReadyPlanSteps / selectBlockedPlanSteps', () => {
    it('returns A,B ready and C blocked when C depends on A and B', () => {
        const plan = PlanSchema.parse({
            id: 'p1',
            steps: [
                { id: 'A', kind: 'internal', title: 'a' },
                { id: 'B', kind: 'internal', title: 'b' },
                { id: 'C', kind: 'internal', title: 'c', dependsOn: ['A', 'B'] },
            ],
        });
        expect(selectReadyPlanSteps(plan).map((s) => s.id)).toEqual(['A', 'B']);
        expect(selectBlockedPlanSteps(plan).map((s) => s.id)).toEqual(['C']);
    });

    it('unblocks C only after A and B are completed', () => {
        const afterA = PlanSchema.parse({
            id: 'p1',
            steps: [
                { id: 'A', kind: 'internal', title: 'a', status: 'completed' },
                { id: 'B', kind: 'internal', title: 'b' },
                { id: 'C', kind: 'internal', title: 'c', dependsOn: ['A', 'B'] },
            ],
        });
        expect(selectReadyPlanSteps(afterA).map((s) => s.id)).toEqual(['B']);
        expect(selectBlockedPlanSteps(afterA).map((s) => s.id)).toEqual(['C']);

        const afterAB = PlanSchema.parse({
            id: 'p1',
            steps: [
                { id: 'A', kind: 'internal', title: 'a', status: 'completed' },
                { id: 'B', kind: 'internal', title: 'b', status: 'completed' },
                { id: 'C', kind: 'internal', title: 'c', dependsOn: ['A', 'B'] },
            ],
        });
        expect(selectReadyPlanSteps(afterAB).map((s) => s.id)).toEqual(['C']);
        expect(selectBlockedPlanSteps(afterAB).map((s) => s.id)).toEqual([]);
    });

    it('treats running C as neither ready nor blocked', () => {
        const plan = PlanSchema.parse({
            id: 'p1',
            steps: [
                { id: 'A', kind: 'internal', title: 'a', status: 'completed' },
                { id: 'B', kind: 'internal', title: 'b', status: 'completed' },
                { id: 'C', kind: 'internal', title: 'c', status: 'running', dependsOn: ['A', 'B'] },
            ],
        });
        expect(selectReadyPlanSteps(plan).map((s) => s.id)).toEqual([]);
        expect(selectBlockedPlanSteps(plan).map((s) => s.id)).toEqual([]);
    });

    it('keeps C blocked when A failed and B pending with no deps', () => {
        const plan = PlanSchema.parse({
            id: 'p1',
            steps: [
                { id: 'A', kind: 'internal', title: 'a', status: 'failed' },
                { id: 'B', kind: 'internal', title: 'b' },
                { id: 'C', kind: 'internal', title: 'c', dependsOn: ['A'] },
            ],
        });
        expect(selectReadyPlanSteps(plan).map((s) => s.id)).toEqual(['B']);
        expect(selectBlockedPlanSteps(plan).map((s) => s.id)).toEqual(['C']);
    });

    it('keeps C blocked when A is skipped or running', () => {
        const skipped = PlanSchema.parse({
            id: 'p1',
            steps: [
                { id: 'A', kind: 'internal', title: 'a', status: 'skipped' },
                { id: 'C', kind: 'internal', title: 'c', dependsOn: ['A'] },
            ],
        });
        const running = PlanSchema.parse({
            id: 'p1',
            steps: [
                { id: 'A', kind: 'internal', title: 'a', status: 'running' },
                { id: 'C', kind: 'internal', title: 'c', dependsOn: ['A'] },
            ],
        });
        expect(selectBlockedPlanSteps(skipped).map((s) => s.id)).toEqual(['C']);
        expect(selectBlockedPlanSteps(running).map((s) => s.id)).toEqual(['C']);
    });

    it('treats omitted dependsOn and empty dependsOn as ready', () => {
        const plan = PlanSchema.parse({
            id: 'p1',
            steps: [
                { id: 'A', kind: 'internal', title: 'a' },
                { id: 'B', kind: 'internal', title: 'b', dependsOn: [] },
            ],
        });
        expect(selectReadyPlanSteps(plan).map((s) => s.id)).toEqual(['A', 'B']);
        expect(selectBlockedPlanSteps(plan).map((s) => s.id)).toEqual([]);
    });

    it('cursor-only pending steps are all ready; sequential Policy still uses cursor', () => {
        const plan = PlanSchema.parse({
            id: 'p1',
            cursor: 0,
            steps: [
                { id: 'A', kind: 'internal', title: 'a' },
                { id: 'B', kind: 'internal', title: 'b' },
                { id: 'C', kind: 'internal', title: 'c' },
            ],
        });
        expect(selectReadyPlanSteps(plan).map((s) => s.id)).toEqual(['A', 'B', 'C']);
        expect(selectBlockedPlanSteps(plan).map((s) => s.id)).toEqual([]);
    });

    it('helpers ignore plan.status on a cancelled plan', () => {
        const plan = PlanSchema.parse({
            id: 'p1',
            status: 'cancelled',
            steps: [{ id: 'A', kind: 'internal', title: 'a' }],
        });
        expect(selectReadyPlanSteps(plan).map((s) => s.id)).toEqual(['A']);
    });

    it('helpers ignore plan.status on stale and failed plans', () => {
        const stale = PlanSchema.parse({
            id: 'p1',
            status: 'stale',
            steps: [{ id: 'A', kind: 'internal', title: 'a' }],
        });
        const failed = PlanSchema.parse({
            id: 'p1',
            status: 'failed',
            steps: [{ id: 'A', kind: 'internal', title: 'a' }],
        });
        expect(selectReadyPlanSteps(stale).map((s) => s.id)).toEqual(['A']);
        expect(selectReadyPlanSteps(failed).map((s) => s.id)).toEqual(['A']);
    });

    it('duplicate dependsOn is one edge for readiness', () => {
        const pending = PlanSchema.parse({
            id: 'p1',
            steps: [
                { id: 'A', kind: 'internal', title: 'a' },
                { id: 'B', kind: 'internal', title: 'b', dependsOn: ['A', 'A'] },
            ],
        });
        const done = PlanSchema.parse({
            id: 'p1',
            steps: [
                { id: 'A', kind: 'internal', title: 'a', status: 'completed' },
                { id: 'B', kind: 'internal', title: 'b', dependsOn: ['A', 'A'] },
            ],
        });
        expect(selectBlockedPlanSteps(pending).map((s) => s.id)).toEqual(['B']);
        expect(selectReadyPlanSteps(done).map((s) => s.id)).toEqual(['B']);
    });

    it('requireValidatedDependencies is opt-in and default matches Phase 2', () => {
        const unvalidated = PlanSchema.parse({
            id: 'p1',
            steps: [
                { id: 'A', kind: 'internal', title: 'a', status: 'completed' },
                { id: 'C', kind: 'internal', title: 'c', dependsOn: ['A'] },
            ],
        });
        expect(selectReadyPlanSteps(unvalidated).map((s) => s.id)).toEqual(['C']);
        expect(selectReadyPlanSteps(unvalidated, { requireValidatedDependencies: true }).map((s) => s.id)).toEqual([]);
        expect(selectBlockedPlanSteps(unvalidated, { requireValidatedDependencies: true }).map((s) => s.id)).toEqual(['C']);

        const valid = PlanSchema.parse({
            id: 'p1',
            steps: [
                { id: 'A', kind: 'internal', title: 'a', status: 'completed', validation: { status: 'valid' } },
                { id: 'C', kind: 'internal', title: 'c', dependsOn: ['A'] },
            ],
        });
        expect(selectReadyPlanSteps(valid, { requireValidatedDependencies: true }).map((s) => s.id)).toEqual(['C']);

        const invalid = PlanSchema.parse({
            id: 'p1',
            steps: [
                { id: 'A', kind: 'internal', title: 'a', status: 'completed', validation: { status: 'invalid' } },
                { id: 'C', kind: 'internal', title: 'c', dependsOn: ['A'] },
            ],
        });
        const pendingVal = PlanSchema.parse({
            id: 'p1',
            steps: [
                { id: 'A', kind: 'internal', title: 'a', status: 'completed', validation: { status: 'pending' } },
                { id: 'C', kind: 'internal', title: 'c', dependsOn: ['A'] },
            ],
        });
        expect(selectBlockedPlanSteps(invalid, { requireValidatedDependencies: true }).map((s) => s.id)).toEqual(['C']);
        expect(selectBlockedPlanSteps(pendingVal, { requireValidatedDependencies: true }).map((s) => s.id)).toEqual(['C']);

        const unknownVal = PlanSchema.parse({
            id: 'p1',
            steps: [
                { id: 'A', kind: 'internal', title: 'a', status: 'completed', validation: { status: 'unknown' } },
                { id: 'C', kind: 'internal', title: 'c', dependsOn: ['A'] },
            ],
        });
        expect(selectReadyPlanSteps(unknownVal, { requireValidatedDependencies: true }).map((s) => s.id)).toEqual([]);
        expect(selectBlockedPlanSteps(unknownVal, { requireValidatedDependencies: true }).map((s) => s.id)).toEqual(['C']);
    });
});

describe('plan graph lookups', () => {
    it('returns direct dependants in steps order', () => {
        const plan = PlanSchema.parse({
            id: 'p1',
            steps: [
                { id: 'A', kind: 'internal', title: 'a' },
                { id: 'B', kind: 'internal', title: 'b', dependsOn: ['A'] },
                { id: 'C', kind: 'internal', title: 'c', dependsOn: ['A'] },
            ],
        });
        const result = getPlanDependants(plan, 'A');
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.map((s) => s.id)).toEqual(['B', 'C']);
    });

    it('returns empty dependants for a present step with none', () => {
        const plan = PlanSchema.parse({
            id: 'p1',
            steps: [{ id: 'A', kind: 'internal', title: 'a' }],
        });
        const result = getPlanDependants(plan, 'A');
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value).toEqual([]);
    });

    it('returns ancestors and descendants in steps order and excludes self', () => {
        const plan = PlanSchema.parse({
            id: 'p1',
            steps: [
                { id: 'A', kind: 'internal', title: 'a' },
                { id: 'B', kind: 'internal', title: 'b', dependsOn: ['A'] },
                { id: 'C', kind: 'internal', title: 'c', dependsOn: ['B'] },
            ],
        });
        const ancestors = getPlanAncestors(plan, 'C');
        const descendants = getPlanDescendants(plan, 'A');
        expect(ancestors.ok).toBe(true);
        expect(descendants.ok).toBe(true);
        if (ancestors.ok) expect(ancestors.value.map((s) => s.id)).toEqual(['A', 'B']);
        if (descendants.ok) expect(descendants.value.map((s) => s.id)).toEqual(['B', 'C']);
        if (ancestors.ok) expect(ancestors.value.map((s) => s.id)).not.toContain('C');
        if (descendants.ok) expect(descendants.value.map((s) => s.id)).not.toContain('A');
        const selfDeps = getPlanDependants(plan, 'A');
        if (selfDeps.ok) expect(selfDeps.value.map((s) => s.id)).not.toContain('A');
    });

    it('returns unique diamond ancestors in steps order', () => {
        const plan = PlanSchema.parse({
            id: 'p1',
            steps: [
                { id: 'A', kind: 'internal', title: 'a' },
                { id: 'B', kind: 'internal', title: 'b', dependsOn: ['A'] },
                { id: 'C', kind: 'internal', title: 'c', dependsOn: ['A'] },
                { id: 'D', kind: 'internal', title: 'd', dependsOn: ['B', 'C'] },
            ],
        });
        const ancestors = getPlanAncestors(plan, 'D');
        expect(ancestors.ok).toBe(true);
        if (ancestors.ok) expect(ancestors.value.map((s) => s.id)).toEqual(['A', 'B', 'C']);
    });

    it('returns PLAN_STEP_NOT_FOUND for a missing id, not an empty list', () => {
        const plan = PlanSchema.parse({
            id: 'p1',
            steps: [{ id: 'A', kind: 'internal', title: 'a' }],
        });
        const result = getPlanDependants(plan, 'missing');
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errors[0].errorCode).toBe('PLAN_STEP_NOT_FOUND');
            expect(result.errors[0].stepId).toBe('missing');
        }
    });
});
