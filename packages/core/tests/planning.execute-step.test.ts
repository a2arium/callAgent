import { describe, expect, it } from '@jest/globals';
import { createTestHarness } from '../src/testing/TestHarness.js';
import { IntentSchema, type Intent } from '../src/types/intent.js';
import { PlanSchema, PlanStepUpdatedPayloadSchema, type Plan } from '../src/types/plan.js';
import { selectReadyPlanSteps } from '../src/plans/planGraph.js';
import { resolveStoredPlanStep } from '../src/plans/dispatchStoredPlanStep.js';
import { claimToolTerminalInSnapshot } from '../src/orchestration/ToolTerminalCoordinator.js';
import type { EnvironmentState, MentalState } from '../src/loop/types.js';

const seedPlan = (plan: Plan) => ({
    plans: {
        plans: { [plan.id]: plan },
        activePlanId: plan.id,
    },
});

const twoIndependentTools = (): Plan =>
    PlanSchema.parse({
        id: 'p1',
        status: 'active',
        steps: [
            { id: 'A', kind: 'action', title: 'do A', intent: { kind: 'call_tool', toolName: 'toolA' } },
            { id: 'B', kind: 'action', title: 'do B', intent: { kind: 'call_tool', toolName: 'toolB' } },
        ],
    });

const pendingRecord = (
    tools: Record<string, unknown>,
    token: string
): Record<string, unknown> | undefined => {
    const rec = tools[token];
    return rec && typeof rec === 'object' ? (rec as Record<string, unknown>) : undefined;
};

describe('execute_step schema', () => {
    it('accepts { kind: execute_step, planId, stepId } and rejects extra fields', () => {
        expect(IntentSchema.safeParse({ kind: 'execute_step', planId: 'p1', stepId: 'A' }).success).toBe(true);
        expect(
            IntentSchema.safeParse({ kind: 'execute_step', planId: 'p1', stepId: 'A', extra: true }).success
        ).toBe(false);
    });

    it('accepts optional advanceCursor on PlanStepUpdatedPayload', () => {
        expect(
            PlanStepUpdatedPayloadSchema.safeParse({
                planId: 'p1',
                stepId: 'A',
                patch: { status: 'completed' },
                advanceCursor: true,
            }).success
        ).toBe(true);
    });
});

describe('resolveStoredPlanStep', () => {
    const mental = (plan: Plan): MentalState => ({ plans: { plans: { [plan.id]: plan } } }) as MentalState;

    it('returns PLAN_NOT_FOUND when the plan is missing', () => {
        const result = resolveStoredPlanStep(
            { kind: 'execute_step', planId: 'missing', stepId: 'A' },
            { plans: { plans: {} } } as MentalState
        );
        expect(result).toEqual(expect.objectContaining({ ok: false, errorCode: 'PLAN_NOT_FOUND' }));
    });

    it('returns PLAN_STEP_NOT_PENDING when the named step is not pending', () => {
        const plan = PlanSchema.parse({
            id: 'p1',
            status: 'active',
            steps: [{ id: 'A', kind: 'internal', title: 'a', status: 'completed', intent: { kind: 'wait' } }],
        });
        const result = resolveStoredPlanStep({ kind: 'execute_step', planId: 'p1', stepId: 'A' }, mental(plan));
        expect(result).toEqual(expect.objectContaining({ ok: false, errorCode: 'PLAN_STEP_NOT_PENDING' }));
    });
});

describe('execute_step default Execution + Learning', () => {
    it('dispatches named step A, stamps pending on the await_tool turn, and records the tool stub once via requestTool', async () => {
        const plan = twoIndependentTools();
        let envRef: EnvironmentState | undefined;
        const harness = createTestHarness({
            attention: (_m: MentalState, env: EnvironmentState) => {
                envRef = env;
                return { kind: 'all' };
            },
            policy: (m: MentalState) => {
                const stepA = m.plans?.plans?.p1?.steps.find((s) => s.id === 'A');
                if (stepA?.status === 'pending') {
                    return { kind: 'execute_step', planId: 'p1', stepId: 'A' } as Intent;
                }
                return { kind: 'wait' } as Intent;
            },
        });
        harness.seedMentalState(seedPlan(plan));
        harness.toolStub().register('toolA', { ok: true });
        harness.toolStub().register('toolB', { ok: true });

        await harness.runTurn();
        expect(harness.lastTrace().intent?.kind).toBe('execute_step');
        expect(harness.lastTrace().transition?.kind).toBe('await_tool');
        const token = harness.lastAwaitToken();
        const stamped = pendingRecord(envRef?.pending.tools ?? {}, token);
        expect(stamped).toEqual(
            expect.objectContaining({
                name: 'toolA',
                planId: 'p1',
                stepId: 'A',
                advanceCursor: false,
            })
        );
        expect(harness.toolStub().getCalls().map((c) => c.tool)).toEqual(['toolA']);
        expect(harness.toolStub().getCalls()).toHaveLength(1);

        harness.injectToolCompleted({ token, tool: 'toolA', result: { ok: true } });
        await harness.runTurn();

        const after = harness.currentM().plans?.plans?.p1;
        expect(after?.steps.find((s) => s.id === 'A')?.status).toBe('completed');
        expect(after?.steps.find((s) => s.id === 'B')?.status).toBe('pending');
        expect(after?.cursor).toBe(0);
        const ready = selectReadyPlanSteps(after!);
        expect(ready.map((s) => s.id)).toEqual(['B']);
    });

    it('completes the step via terminals after claimToolTerminalInSnapshot deletes pending', async () => {
        const plan = twoIndependentTools();
        let envRef: EnvironmentState | undefined;
        const harness = createTestHarness({
            attention: (_m: MentalState, env: EnvironmentState) => {
                envRef = env;
                return { kind: 'all' };
            },
            policy: (m: MentalState) => {
                const stepA = m.plans?.plans?.p1?.steps.find((s) => s.id === 'A');
                if (stepA?.status === 'pending') {
                    return { kind: 'execute_step', planId: 'p1', stepId: 'A' } as Intent;
                }
                return { kind: 'wait' } as Intent;
            },
        });
        harness.seedMentalState(seedPlan(plan));
        harness.toolStub().register('toolA', { ok: true });

        await harness.runTurn();
        const token = harness.lastAwaitToken();
        expect(envRef?.pending.tools[token]).toEqual(
            expect.objectContaining({ planId: 'p1', stepId: 'A' })
        );

        const claim = claimToolTerminalInSnapshot(
            {
                pending: envRef!.pending,
                inbox: { current: [], all: [] },
                meta: { turn: 0 },
            },
            {
                token,
                completedAt: '2026-08-17T00:00:00.000Z',
                result: { ok: true },
                taskId: 'test-session',
            }
        );
        expect(claim.won).toBe(true);
        const claimedPending = (claim.snapshot as { pending: EnvironmentState['pending'] }).pending;
        envRef!.pending.tools = claimedPending.tools;
        envRef!.pending.toolTerminals = claimedPending.toolTerminals;
        expect(envRef!.pending.tools[token]).toBeUndefined();
        expect(envRef!.pending.toolTerminals?.[token]).toEqual(
            expect.objectContaining({ planId: 'p1', stepId: 'A', advanceCursor: false })
        );

        harness.injectToolCompleted({ token, tool: 'toolA', result: { ok: true } });
        await harness.runTurn();
        expect(harness.currentM().plans?.plans?.p1?.steps.find((s) => s.id === 'A')?.status).toBe('completed');
    });

    it('missing stepId returns PLAN_STEP_NOT_FOUND and leaves M.plans unchanged', async () => {
        const plan = twoIndependentTools();
        const harness = createTestHarness({
            policy: () => ({ kind: 'execute_step', planId: 'p1', stepId: 'missing' } as Intent),
        });
        harness.seedMentalState(seedPlan(plan));
        await harness.runTurn();
        expect(harness.lastTrace().execResult?.error).toEqual(
            expect.objectContaining({ code: 'PLAN_STEP_NOT_FOUND' })
        );
        expect(harness.currentM().plans?.plans?.p1?.steps.map((s) => s.status)).toEqual(['pending', 'pending']);
    });

    it('PLAN_NOT_FOUND is returned when the plan is absent', async () => {
        const harness = createTestHarness({
            policy: () => ({ kind: 'execute_step', planId: 'missing', stepId: 'A' } as Intent),
        });
        await harness.runTurn();
        expect(harness.lastTrace().execResult?.error).toEqual(
            expect.objectContaining({ code: 'PLAN_NOT_FOUND' })
        );
    });

    it('PLAN_STEP_NOT_PENDING is returned for a completed step', async () => {
        const plan = PlanSchema.parse({
            id: 'p1',
            status: 'active',
            steps: [{ id: 'A', kind: 'internal', title: 'a', status: 'completed', intent: { kind: 'wait' } }],
        });
        const harness = createTestHarness({
            policy: () => ({ kind: 'execute_step', planId: 'p1', stepId: 'A' } as Intent),
        });
        harness.seedMentalState(seedPlan(plan));
        await harness.runTurn();
        expect(harness.lastTrace().execResult?.error).toEqual(
            expect.objectContaining({ code: 'PLAN_STEP_NOT_PENDING' })
        );
    });

    it('step without intent returns PLAN_STEP_NO_INTENT', async () => {
        const plan = PlanSchema.parse({
            id: 'p1',
            status: 'active',
            steps: [{ id: 'A', kind: 'internal', title: 'no intent' }],
        });
        const harness = createTestHarness({
            policy: () => ({ kind: 'execute_step', planId: 'p1', stepId: 'A' } as Intent),
        });
        harness.seedMentalState(seedPlan(plan));
        await harness.runTurn();
        expect(harness.lastTrace().execResult?.error).toEqual(
            expect.objectContaining({ code: 'PLAN_STEP_NO_INTENT' })
        );
    });

    it('blocked-but-named pending step still dispatches because Execution does not check dependsOn', async () => {
        const plan = PlanSchema.parse({
            id: 'p1',
            status: 'active',
            steps: [
                { id: 'A', kind: 'action', title: 'a', intent: { kind: 'call_tool', toolName: 'toolA' } },
                {
                    id: 'C',
                    kind: 'action',
                    title: 'c',
                    dependsOn: ['A'],
                    intent: { kind: 'call_tool', toolName: 'toolC' },
                },
            ],
        });
        const harness = createTestHarness({
            policy: () => ({ kind: 'execute_step', planId: 'p1', stepId: 'C' } as Intent),
        });
        harness.seedMentalState(seedPlan(plan));
        harness.toolStub().register('toolC', { ok: true });
        await harness.runTurn();
        expect(harness.toolStub().getCalls().map((c) => c.tool)).toEqual(['toolC']);
        expect(harness.lastTrace().transition?.kind).toBe('await_tool');
    });

    it('execute_next_step stamps advanceCursor true on the dispatch turn and Learning advances cursor after completion', async () => {
        const plan = PlanSchema.parse({
            id: 'p1',
            status: 'active',
            cursor: 0,
            steps: [
                { id: 'A', kind: 'action', title: 'a', intent: { kind: 'call_tool', toolName: 'toolA' } },
            ],
        });
        let envRef: EnvironmentState | undefined;
        const harness = createTestHarness({
            attention: (_m: MentalState, env: EnvironmentState) => {
                envRef = env;
                return { kind: 'all' };
            },
            policy: (m: MentalState) => {
                const stepA = m.plans?.plans?.p1?.steps.find((s) => s.id === 'A');
                if (stepA?.status === 'pending') {
                    return { kind: 'execute_next_step', planId: 'p1' } as Intent;
                }
                return { kind: 'wait' } as Intent;
            },
        });
        harness.seedMentalState(seedPlan(plan));
        harness.toolStub().register('toolA', { ok: true });
        await harness.runTurn();
        expect(harness.lastTrace().transition?.kind).toBe('await_tool');
        const token = harness.lastAwaitToken();
        expect(pendingRecord(envRef?.pending.tools ?? {}, token)).toEqual(
            expect.objectContaining({ planId: 'p1', stepId: 'A', advanceCursor: true })
        );
        harness.injectToolCompleted({ token, tool: 'toolA' });
        expect(envRef?.pending.tools[token]).toBeUndefined();
        expect(envRef?.pending.toolTerminals?.[token]).toEqual(
            expect.objectContaining({ planId: 'p1', stepId: 'A', advanceCursor: true })
        );
        await harness.runTurn();
        const after = harness.currentM().plans?.plans?.p1;
        expect(after?.steps[0]?.status).toBe('completed');
        expect(after?.cursor).toBe(1);
    });

    it('injectToolFailed claims pending onto toolTerminals then Learning fails the step', async () => {
        const plan = twoIndependentTools();
        let envRef: EnvironmentState | undefined;
        const harness = createTestHarness({
            attention: (_m: MentalState, env: EnvironmentState) => {
                envRef = env;
                return { kind: 'all' };
            },
            policy: (m: MentalState) => {
                const stepA = m.plans?.plans?.p1?.steps.find((s) => s.id === 'A');
                if (stepA?.status === 'pending') {
                    return { kind: 'execute_step', planId: 'p1', stepId: 'A' } as Intent;
                }
                return { kind: 'wait' } as Intent;
            },
        });
        harness.seedMentalState(seedPlan(plan));
        harness.toolStub().register('toolA', { ok: true });

        await harness.runTurn();
        const token = harness.lastAwaitToken();
        expect(envRef?.pending.tools[token]).toEqual(
            expect.objectContaining({ planId: 'p1', stepId: 'A' })
        );

        harness.injectToolFailed({ token, tool: 'toolA', error: 'boom' });
        expect(envRef?.pending.tools[token]).toBeUndefined();
        expect(envRef?.pending.toolTerminals?.[token]).toEqual(
            expect.objectContaining({
                kind: 'detached',
                reason: 'tool_failed',
                planId: 'p1',
                stepId: 'A',
                advanceCursor: false,
            })
        );

        await harness.runTurn();
        expect(harness.currentM().plans?.plans?.p1?.steps.find((s) => s.id === 'A')?.status).toBe('failed');
        expect(harness.currentM().plans?.plans?.p1?.steps.find((s) => s.id === 'B')?.status).toBe('pending');
    });

    it('Policy array of two execute_steps with stochastic false still executes one sample', async () => {
        const plan = twoIndependentTools();
        const harness = createTestHarness({
            policy: () => [
                { action: { kind: 'execute_step', planId: 'p1', stepId: 'A' } as Intent, prob: 0.9 },
                { action: { kind: 'execute_step', planId: 'p1', stepId: 'B' } as Intent, prob: 0.1 },
            ],
        });
        harness.seedMentalState({
            ...seedPlan(plan),
            policyParams: { stochastic: false },
        });
        harness.toolStub().register('toolA', { ok: true });
        harness.toolStub().register('toolB', { ok: true });
        await harness.runTurn();
        expect(harness.lastTrace().intent?.kind).toBe('execute_step');
        expect(harness.toolStub().getCalls().map((c) => c.tool)).toEqual(['toolA']);
        expect(harness.toolStub().getCalls()).toHaveLength(1);
    });

    it('continue path: wait step completes next turn via plan.step.updated with no pending token', async () => {
        const plan = PlanSchema.parse({
            id: 'p1',
            status: 'active',
            steps: [{ id: 'A', kind: 'internal', title: 'wait', intent: { kind: 'wait' } }],
        });
        const harness = createTestHarness({
            policy: (m: MentalState) => {
                const stepA = m.plans?.plans?.p1?.steps.find((s) => s.id === 'A');
                if (stepA?.status === 'pending') {
                    return { kind: 'execute_step', planId: 'p1', stepId: 'A' } as Intent;
                }
                return { kind: 'wait' } as Intent;
            },
        });
        harness.seedMentalState(seedPlan(plan));
        await harness.runTurn();
        expect(harness.lastTrace().transition?.kind).toBe('continue');
        expect(harness.lastTrace().transition?.token).toBeUndefined();
        const data = harness.lastTrace().execResult?.data;
        expect(data && typeof data === 'object' && 'planStepUpdated' in data).toBe(true);

        await harness.runTurn();
        expect(harness.currentM().plans?.plans?.p1?.steps[0]?.status).toBe('completed');
        expect(harness.currentM().plans?.plans?.p1?.cursor).toBe(0);
    });

    it('continue-error: stored answer_with_llm with no LLM marks the step failed', async () => {
        const plan = PlanSchema.parse({
            id: 'p1',
            status: 'active',
            steps: [{
                id: 'A',
                kind: 'internal',
                title: 'answer',
                intent: { kind: 'answer_with_llm', query: 'hello' },
            }],
        });
        const harness = createTestHarness({
            policy: (m: MentalState) => {
                const stepA = m.plans?.plans?.p1?.steps.find((s) => s.id === 'A');
                if (stepA?.status === 'pending') {
                    return { kind: 'execute_step', planId: 'p1', stepId: 'A' } as Intent;
                }
                return { kind: 'wait' } as Intent;
            },
        });
        harness.seedMentalState(seedPlan(plan));
        const llm = harness.llmStub() as { getHistoryMode?: unknown };
        delete llm.getHistoryMode;

        await harness.runTurn();
        expect(harness.lastTrace().execResult?.error).toEqual(
            expect.objectContaining({ code: 'llm_not_configured' })
        );
        const data = harness.lastTrace().execResult?.data;
        expect(data).toEqual(
            expect.objectContaining({
                planStepUpdated: expect.objectContaining({
                    planId: 'p1',
                    stepId: 'A',
                    patch: { status: 'failed' },
                }),
            })
        );

        await harness.runTurn();
        expect(harness.currentM().plans?.plans?.p1?.steps[0]?.status).toBe('failed');
    });
});
