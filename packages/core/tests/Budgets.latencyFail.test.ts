import { runLoop } from '../src/loop/loopRunner.js';

describe('Budgets - latency fail', () => {
    it('returns fail when latency budget exceeded', async () => {
        const ctx: any = { reply: async () => { } };
        const M: any = {
            memory: { sensory: {}, vars: {}, longTerm: { episodic: [], semantic: { concepts: [] }, procedural: { skills: [] } } },
            worldModel: { implicit: null, explicit: null, simulator: null },
            goalState: { hierarchy: { nodes: {}, roots: [] } },
            emotion: { valence: 0, arousal: 0.2 },
            rewardParams: { extrinsicWeights: [1], intrinsic: { curiosity: 0, novelty: 0, competence: 0, exploration: 0 }, discountGamma: 0.99 },
            policyParams: { theta: null, stochastic: false }
        };
        const env: any = { time: new Date().toISOString(), input: {}, pending: { inputs: {}, children: {}, tools: {}, groups: {} } };
        const { outcome } = await runLoop(ctx, M, env, {
            policy: () => ({ kind: 'language', content: 'ok' })
        }, { maxTurns: 1, latencyMs: -1 });
        expect(outcome.kind).toBe('fail');
        expect((outcome as any).reason).toBe('budget_latency_exceeded');
    });
});


