import { PlanSchema, PlanStateSchema } from '../src/types/plan.js';

describe('Planning Model Schemas', () => {
    it('should validate a valid plan', () => {
        const validPlan = {
            id: 'plan_1',
            steps: [
                {
                    id: 'step_1',
                    kind: 'internal',
                    description: 'Do something',
                    status: 'pending'
                }
            ],
            cursor: 0,
            status: 'proposed',
            revision: 0
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
                    description: 'Do something',
                    status: 'pending'
                }
            ],
            cursor: 2, // Out of bounds
            status: 'proposed',
            revision: 0
        };
        const result = PlanSchema.safeParse(invalidPlan);
        expect(result.success).toBe(false);
    });

    it('should validate PlanState', () => {
        const state = {
            plans: {
                'plan_1': {
                    id: 'plan_1',
                    steps: [],
                    cursor: 0,
                    status: 'proposed',
                    revision: 0
                }
            },
            activePlanId: 'plan_1'
        };
        const result = PlanStateSchema.safeParse(state);
        expect(result.success).toBe(true);
    });
});
