import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import { createTestHarness } from '../src/testing/TestHarness.js';
import type { Intent } from '../src/types/intent.js';
import { PlanSchema, PlanStateSchema, PlanStepSchema } from '../src/types/plan.js';
import type { Observation } from '../src/types/observation.js';

const graphErrorCodes = (error: z.ZodError): string[] =>
    error.issues.flatMap((issue) => {
        if (
            issue.code === 'custom' &&
            issue.params &&
            typeof issue.params === 'object' &&
            'errorCode' in issue.params &&
            typeof issue.params.errorCode === 'string'
        ) {
            return [issue.params.errorCode];
        }
        return [];
    });

describe('Planning Model Schemas', () => {
    it('should validate a valid plan', () => {
        const validPlan = {
            id: 'plan_1',
            steps: [
                {
                    id: 'step_1',
                    kind: 'internal',
                    title: 'Do something',
                    status: 'pending',
                },
            ],
            cursor: 0,
            status: 'proposed',
            revision: 0,
        };
        const result = PlanSchema.safeParse(validPlan);
        if (!result.success) {
            console.error(result.error);
        }
        expect(result.success).toBe(true);
    });

    it('should reject a plan with cursor out of bounds', () => {
        const invalidPlan = {
            id: 'plan_1',
            steps: [
                {
                    id: 'step_1',
                    kind: 'internal',
                    title: 'Do something',
                    status: 'pending',
                },
            ],
            cursor: 2,
            status: 'proposed',
            revision: 0,
        };
        const result = PlanSchema.safeParse(invalidPlan);
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(graphErrorCodes(result.error)).toContain('PLAN_CURSOR_OUT_OF_BOUNDS');
        }
    });

    it('should validate PlanState', () => {
        const state = {
            plans: {
                plan_1: {
                    id: 'plan_1',
                    steps: [],
                    cursor: 0,
                    status: 'proposed',
                    revision: 0,
                },
            },
            activePlanId: 'plan_1',
        };
        const result = PlanStateSchema.safeParse(state);
        expect(result.success).toBe(true);
    });

    it('accepts empty steps, default cursor 0, and default status proposed', () => {
        const result = PlanSchema.safeParse({ id: 'p1', steps: [] });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.cursor).toBe(0);
            expect(result.data.status).toBe('proposed');
        }
    });

    it('accepts omitted timestamps', () => {
        const result = PlanSchema.safeParse({
            id: 'p1',
            steps: [{ id: 's1', kind: 'internal', title: 't' }],
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.createdAt).toBeUndefined();
            expect(result.data.updatedAt).toBeUndefined();
        }
    });

    it('accepts offset and Z timestamps', () => {
        const offset = PlanSchema.safeParse({
            id: 'p1',
            steps: [],
            createdAt: '2026-08-16T09:00:00.000+03:00',
            updatedAt: '2026-08-16T09:00:00.000+03:00',
        });
        const zulu = PlanSchema.safeParse({
            id: 'p1',
            steps: [],
            createdAt: '2026-08-16T06:00:00.000Z',
            updatedAt: '2026-08-16T06:00:00.000Z',
        });
        expect(offset.success).toBe(true);
        expect(zulu.success).toBe(true);
    });

    it('accepts omitted dependsOn and empty dependsOn', () => {
        const omitted = PlanStepSchema.safeParse({ id: 's1', kind: 'internal', title: 't' });
        const empty = PlanStepSchema.safeParse({
            id: 's1',
            kind: 'internal',
            title: 't',
            dependsOn: [],
        });
        expect(omitted.success).toBe(true);
        expect(empty.success).toBe(true);
        if (omitted.success) expect(omitted.data.dependsOn).toBeUndefined();
        if (empty.success) expect(empty.data.dependsOn).toEqual([]);
    });

    it('accepts duplicate dependsOn ids as one edge', () => {
        const result = PlanSchema.safeParse({
            id: 'p1',
            steps: [
                { id: 'A', kind: 'internal', title: 'a' },
                { id: 'B', kind: 'internal', title: 'b', dependsOn: ['A', 'A'] },
            ],
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.steps[1].dependsOn).toEqual(['A']);
        }
    });

    it('accepts status stale', () => {
        const result = PlanSchema.safeParse({ id: 'p1', steps: [], status: 'stale' });
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.status).toBe('stale');
    });

    it('accepts JSON meta on plan and step', () => {
        const result = PlanSchema.safeParse({
            id: 'p1',
            meta: { graphKind: 'atomic-task-graph' },
            steps: [
                {
                    id: 's1',
                    kind: 'internal',
                    title: 't',
                    meta: { graphKind: 'atomic-task-graph' },
                },
            ],
        });
        expect(result.success).toBe(true);
    });

    it('accepts executable step intent and omitted intent', () => {
        const withIntent = PlanSchema.safeParse({
            id: 'p1',
            steps: [
                {
                    id: 's1',
                    kind: 'action',
                    title: 'search',
                    intent: { kind: 'call_tool', toolName: 'search' },
                },
            ],
        });
        const withoutIntent = PlanSchema.safeParse({
            id: 'p1',
            steps: [{ id: 's1', kind: 'action', title: 'later' }],
        });
        expect(withIntent.success).toBe(true);
        expect(withoutIntent.success).toBe(true);
    });

    it('accepts cursor equal to steps.length', () => {
        const result = PlanSchema.safeParse({
            id: 'p1',
            cursor: 1,
            steps: [{ id: 's1', kind: 'internal', title: 't' }],
        });
        expect(result.success).toBe(true);
    });

    it('rejects description instead of title', () => {
        const result = PlanSchema.safeParse({
            id: 'p1',
            steps: [{ id: 's1', kind: 'internal', description: 'x' }],
        });
        expect(result.success).toBe(false);
    });

    it('rejects leftover result, args, action-kinds, and scheduling', () => {
        expect(
            PlanSchema.safeParse({
                id: 'p1',
                steps: [{ id: 's1', kind: 'internal', title: 't', result: { x: 1 } }],
            }).success
        ).toBe(false);
        expect(
            PlanSchema.safeParse({
                id: 'p1',
                steps: [{ id: 's1', kind: 'internal', title: 't', args: { a: 1 } }],
            }).success
        ).toBe(false);
        expect(
            PlanSchema.safeParse({
                id: 'p1',
                steps: [{ id: 's1', kind: 'call_tool', title: 't' }],
            }).success
        ).toBe(false);
        expect(
            PlanSchema.safeParse({
                id: 'p1',
                steps: [{ id: 's1', kind: 'ask_user', title: 't' }],
            }).success
        ).toBe(false);
        expect(
            PlanSchema.safeParse({
                id: 'p1',
                steps: [{ id: 's1', kind: 'todo', title: 't' }],
            }).success
        ).toBe(false);
        expect(
            PlanSchema.safeParse({
                id: 'p1',
                steps: [{ id: 's1', kind: 'done', title: 't' }],
            }).success
        ).toBe(false);
        expect(
            PlanSchema.safeParse({
                id: 'p1',
                status: 'draft',
                steps: [],
            }).success
        ).toBe(false);
        expect(
            PlanSchema.safeParse({
                id: 'p1',
                steps: [],
                scheduling: 'dependencies',
            }).success
        ).toBe(false);
    });

    it('rejects planning intents on a step', () => {
        expect(
            PlanSchema.safeParse({
                id: 'p1',
                steps: [
                    {
                        id: 's1',
                        kind: 'internal',
                        title: 't',
                        intent: { kind: 'create_plan', goalId: 'g1' },
                    },
                ],
            }).success
        ).toBe(false);
        expect(
            PlanSchema.safeParse({
                id: 'p1',
                steps: [
                    {
                        id: 's1',
                        kind: 'internal',
                        title: 't',
                        intent: { kind: 'execute_next_step', planId: 'p1' },
                    },
                ],
            }).success
        ).toBe(false);
        expect(
            PlanSchema.safeParse({
                id: 'p1',
                steps: [
                    {
                        id: 's1',
                        kind: 'internal',
                        title: 't',
                        intent: { kind: 'repair_plan', planId: 'p1', reason: 'x' },
                    },
                ],
            }).success
        ).toBe(false);
        expect(
            PlanSchema.safeParse({
                id: 'p1',
                steps: [
                    {
                        id: 's1',
                        kind: 'internal',
                        title: 't',
                        intent: { kind: 'execute_step', planId: 'p1', stepId: 's1' },
                    },
                ],
            }).success
        ).toBe(false);
    });

    it('rejects duplicate step ids', () => {
        const result = PlanSchema.safeParse({
            id: 'p1',
            steps: [
                { id: 's1', kind: 'internal', title: 'a' },
                { id: 's1', kind: 'internal', title: 'b' },
            ],
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(graphErrorCodes(result.error)).toContain('PLAN_DUPLICATE_STEP_ID');
        }
    });

    it('rejects missing, self, and cyclic dependsOn', () => {
        const missing = PlanSchema.safeParse({
            id: 'p1',
            steps: [{ id: 's1', kind: 'internal', title: 't', dependsOn: ['missing'] }],
        });
        const self = PlanSchema.safeParse({
            id: 'p1',
            steps: [{ id: 'A', kind: 'internal', title: 't', dependsOn: ['A'] }],
        });
        const cycle = PlanSchema.safeParse({
            id: 'p1',
            steps: [
                { id: 'A', kind: 'internal', title: 'a', dependsOn: ['C'] },
                { id: 'B', kind: 'internal', title: 'b', dependsOn: ['A'] },
                { id: 'C', kind: 'internal', title: 'c', dependsOn: ['B'] },
            ],
        });
        expect(missing.success).toBe(false);
        expect(self.success).toBe(false);
        expect(cycle.success).toBe(false);
        if (!missing.success) expect(graphErrorCodes(missing.error)).toContain('PLAN_DEPENDENCY_MISSING');
        if (!self.success) expect(graphErrorCodes(self.error)).toContain('PLAN_DEPENDENCY_SELF');
        if (!cycle.success) expect(graphErrorCodes(cycle.error)).toContain('PLAN_DEPENDENCY_CYCLE');
    });

    it('rejects numeric createdAt and non-JSON meta', () => {
        expect(
            PlanSchema.safeParse({
                id: 'p1',
                steps: [],
                createdAt: 123,
            }).success
        ).toBe(false);
        expect(
            PlanSchema.safeParse({
                id: 'p1',
                steps: [],
                meta: { ts: new Date() },
            }).success
        ).toBe(false);
    });

    it('rejects activePlanId that is not a key in plans', () => {
        const result = PlanStateSchema.safeParse({
            plans: {},
            activePlanId: 'missing',
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(graphErrorCodes(result.error)).toContain('PLAN_ACTIVE_ID_MISSING');
        }
    });

    it('accepts omitted, empty, and named output refs', () => {
        expect(PlanSchema.safeParse({ id: 'p1', steps: [{ id: 's1', kind: 'internal', title: 't' }] }).success).toBe(true);
        expect(
            PlanSchema.safeParse({
                id: 'p1',
                steps: [{ id: 's1', kind: 'internal', title: 't', outputs: [] }],
            }).success
        ).toBe(true);
        const parsed = PlanSchema.safeParse({
            id: 'p1',
            steps: [
                {
                    id: 's1',
                    kind: 'internal',
                    title: 't',
                    outputs: [
                        { kind: 'artifact', ref: 'art_1' },
                        { name: 'page', kind: 'artifact', ref: 'art_1' },
                        { kind: 'memory', ref: 'sem:user-prefs' },
                        { kind: 'evidence', ref: 'obs_turn_4' },
                    ],
                },
            ],
        });
        expect(parsed.success).toBe(true);
    });

    it('rejects value-kind outputs, extra payload, empty ref, and duplicate names', () => {
        expect(
            PlanSchema.safeParse({
                id: 'p1',
                steps: [{ id: 's1', kind: 'internal', title: 't', outputs: [{ kind: 'value', ref: 'x' }] }],
            }).success
        ).toBe(false);
        expect(
            PlanSchema.safeParse({
                id: 'p1',
                steps: [{
                    id: 's1',
                    kind: 'internal',
                    title: 't',
                    outputs: [{ kind: 'artifact', ref: 'art_1', payload: { x: 1 } }],
                }],
            }).success
        ).toBe(false);
        expect(
            PlanSchema.safeParse({
                id: 'p1',
                steps: [{ id: 's1', kind: 'internal', title: 't', outputs: [{ kind: 'artifact', ref: '' }] }],
            }).success
        ).toBe(false);
        expect(
            PlanSchema.safeParse({
                id: 'p1',
                steps: [{
                    id: 's1',
                    kind: 'internal',
                    title: 't',
                    outputs: [
                        { name: 'page', kind: 'artifact', ref: 'a' },
                        { name: 'page', kind: 'memory', ref: 'b' },
                    ],
                }],
            }).success
        ).toBe(false);
        expect(
            PlanSchema.safeParse({
                id: 'p1',
                steps: [{ id: 's1', kind: 'internal', title: 't', outputs: [{ kind: 'artifact', ref: { id: 1 } }] }],
            }).success
        ).toBe(false);
    });

    it('round-trips outputs, validation, and lineage through JSON', () => {
        const plan = PlanSchema.parse({
            id: 'p1',
            revision: 1,
            lineage: { parentRevision: 0, cause: { kind: 'failure' } },
            steps: [{
                id: 's1',
                kind: 'internal',
                title: 't',
                outputs: [{ name: 'page', kind: 'artifact', ref: 'art_1' }],
                validation: { status: 'valid', refs: ['art_1', 'art_1'] },
            }],
        });
        const round = PlanSchema.parse(JSON.parse(JSON.stringify(plan)));
        expect(round.steps[0].outputs).toEqual(plan.steps[0].outputs);
        expect(round.steps[0].validation).toEqual({ status: 'valid', refs: ['art_1'] });
        expect(round.lineage).toEqual(plan.lineage);
    });

    it('accepts optional validation and uniquifies duplicate refs', () => {
        expect(
            PlanSchema.safeParse({
                id: 'p1',
                steps: [{ id: 's1', kind: 'internal', title: 't', validation: { status: 'valid' } }],
            }).success
        ).toBe(true);
        const parsed = PlanSchema.parse({
            id: 'p1',
            steps: [{
                id: 's1',
                kind: 'internal',
                title: 't',
                validation: { status: 'invalid', refs: ['art_1', 'art_1'] },
            }],
        });
        expect(parsed.steps[0].validation?.refs).toEqual(['art_1']);
    });

    it('rejects illegal validation status, extra scores, and illegal lineage parent', () => {
        expect(
            PlanSchema.safeParse({
                id: 'p1',
                steps: [{ id: 's1', kind: 'internal', title: 't', validation: { status: 'done' } }],
            }).success
        ).toBe(false);
        expect(
            PlanSchema.safeParse({
                id: 'p1',
                steps: [{ id: 's1', kind: 'internal', title: 't', validation: { status: 'valid', score: 0.9 } }],
            }).success
        ).toBe(false);
        const same = PlanSchema.safeParse({
            id: 'p1',
            revision: 2,
            lineage: { parentRevision: 2 },
            steps: [],
        });
        const greater = PlanSchema.safeParse({
            id: 'p1',
            revision: 1,
            lineage: { parentRevision: 3 },
            steps: [],
        });
        expect(same.success).toBe(false);
        expect(greater.success).toBe(false);
        if (!same.success) expect(graphErrorCodes(same.error)).toContain('PLAN_LINEAGE_PARENT');
        if (!greater.success) expect(graphErrorCodes(greater.error)).toContain('PLAN_LINEAGE_PARENT');
        expect(
            PlanSchema.safeParse({
                id: 'p1',
                revision: 1,
                lineage: { parentRevision: 0, cause: { kind: 'failure' } },
                steps: [],
            }).success
        ).toBe(true);
    });
});

describe('Planning loop stub and invalid plan observations', () => {
    it('default create_plan emits a PlanSchema-valid plan.proposed payload', async () => {
        const harness = createTestHarness({
            policy: () => ({ kind: 'create_plan', goalId: 'g1' } as Intent),
        });
        await harness.runTurn();
        const data = harness.lastTrace().execResult?.data;
        expect(data && typeof data === 'object' && 'planProposed' in data).toBe(true);
        const payload =
            data && typeof data === 'object' && 'planProposed' in data
                ? (data as { planProposed: unknown }).planProposed
                : undefined;
        expect(PlanSchema.safeParse(payload).success).toBe(true);
        harness.expectTurn((t) => t.expectIntent('create_plan').expectTransition('continue'));
    });

    it('legacy plan.proposed becomes validation.failed and does not write M.plans', async () => {
        const harness = createTestHarness({
            policy: () => ({ kind: 'wait' } as Intent),
        });
        harness.injectObservation({
            source: 'internal',
            kind: 'plan.proposed',
            payload: {
                id: 'legacy',
                steps: [{ id: 's1', kind: 'internal', description: 'x' }],
            },
        } as unknown as Observation);
        await harness.runTurn();
        const kinds = harness.lastTrace().inboxCurrent.map((o) => o.kind);
        expect(kinds).toContain('validation.failed');
        const failed = harness.lastTrace().inboxCurrent.find((o) => o.kind === 'validation.failed');
        const payload = failed?.payload;
        if (payload && typeof payload === 'object' && 'schemaName' in payload) {
            expect((payload as { schemaName?: string }).schemaName).toBe('PlanSchema');
        }
        expect(harness.currentM().plans?.plans?.legacy).toBeUndefined();
    });
});
