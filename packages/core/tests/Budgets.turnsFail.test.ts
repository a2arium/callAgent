import { runLoop } from '../src/loop/loopRunner.js';

describe('Budgets - turns fail', () => {
    it('returns fail when maxTurns is exceeded without terminal outcome', async () => {
        const ctx: any = {
            reply: async () => { },
            task: { id: 'test-task-id' }
        };
        const M: any = {
            memory: { sensory: {}, vars: {}, longTerm: { episodic: [], semantic: { concepts: [] }, procedural: { skills: [] } } },
            worldModel: { implicit: null, explicit: null, simulator: null },
            goalState: { hierarchy: { nodes: {}, roots: [] } },
            emotion: { valence: 0, arousal: 0.2 },
            rewardParams: { extrinsicWeights: [1], intrinsic: { curiosity: 0, novelty: 0, competence: 0, exploration: 0 }, discountGamma: 0.99 },
            policyParams: { theta: null, stochastic: false }
        };
        const env: any = { time: new Date().toISOString(), input: {}, pending: { inputs: {}, children: {}, tools: {}, groups: {} } };
        const { InvariantError } = await import('../src/utils/errors.js');
        await expect(runLoop(ctx, M, env, {
            policy: () => ({ kind: 'internal', intent: 'noop' } as any)
        }, { maxTurns: 1 })).rejects.toMatchObject({
            invariant: { 
                code: 'BUDGET_TURNS_EXCEEDED',
                detail: { type: 'budget_exceeded', budget: 'turns' }
            }
        });
    });
});


