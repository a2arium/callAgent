import { runLoop } from '../src/loop/loopRunner.js';

describe('Rewards hooks', () => {
    it('aggregates rewards in metrics and exposes in metadata', async () => {
        const ctx: any = { reply: async () => { } };
        const M: any = {
            memory: { sensory: {}, shortTerm: { vars: {} }, longTerm: { episodic: [], semantic: { concepts: [] }, procedural: { skills: [] } } },
            worldModel: { implicit: null, explicit: null, simulator: null },
            goalState: { hierarchy: { nodes: {}, roots: [] } },
            emotion: { valence: 0, arousal: 0.2 },
            rewardParams: { extrinsicWeights: [1], intrinsic: { curiosity: 0, novelty: 0, competence: 0, exploration: 0 }, discountGamma: 0.99 },
            policyParams: { theta: null, stochastic: false }
        };
        const env: any = { time: new Date().toISOString(), input: {}, pending: { inputs: {}, children: {}, tools: {}, groups: {} } };
        const { metrics } = await runLoop(ctx, M, env, {
            policy: () => ({ kind: 'language', content: 'x' }) as any,
            extrinsicReward: (_M, _a, _exec, _out) => 0.5,
            intrinsicReward: (_M, _obs) => 0.25
        }, { maxTurns: 1 });
        expect(metrics?.rewards?.length).toBe(1);
        expect(metrics?.rewards?.[0]).toBeCloseTo(0.75, 5);
    });
});


