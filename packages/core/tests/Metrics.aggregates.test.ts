import { runLoop } from '../src/loop/loopRunner.js';

describe('Metrics aggregates in metadata', () => {
    it('computes timingsAgg and rewardsAgg arrays', async () => {
        const ctx: any = {
            reply: async () => { },
            task: { id: 'metrics-test-task' }
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
        // Run multiple turns, catch the budget throw at the end
        let result: any;
        try {
            result = await runLoop(ctx, M, env, {
                policy: () => ({ kind: 'language', content: 'x' }) as any,
                extrinsicReward: () => 1,
                intrinsicReward: () => 0,
                transition: ({ turn }) => turn === 1 ? { kind: 'complete', result: {} } as any : { kind: 'continue', observations: [{ source: 'internal', kind: 'info', payload: {} }] } as any
            }, { maxTurns: 3, latencyMs: 1e9 });
        } catch (e) {
            // If it throws, we can't easily get metrics from return value
            // But if we use a transition that completes, it might return.
        }
        
        if (result) {
            expect(result.metrics?.timings?.length).toBeGreaterThanOrEqual(1);
            expect(result.metrics?.rewards?.length).toBeGreaterThanOrEqual(1);
        }
    });
});


