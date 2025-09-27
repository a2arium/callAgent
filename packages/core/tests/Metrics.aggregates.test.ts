import { runLoop } from '../src/loop/loopRunner.js';

describe('Metrics aggregates in metadata', () => {
    it('computes timingsAgg and rewardsAgg arrays', async () => {
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
        // Run two turns to produce arrays > 1
        const result = await runLoop(ctx, M, env, {
            policy: () => ({ kind: 'language', content: 'x' }) as any,
            extrinsicReward: () => 1,
            intrinsicReward: () => 0
        }, { maxTurns: 2, latencyMs: 1e9 });
        expect(result.metrics?.timings?.length).toBeGreaterThanOrEqual(1);
        expect(result.metrics?.rewards?.length).toBeGreaterThanOrEqual(1);
    });
});


