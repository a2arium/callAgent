import { runLoop } from '../src/loop/loopRunner.js';

describe('Goal progress extrinsic reward', () => {
    it('rewards when done count increases', async () => {
        const ctx: any = { reply: async () => { } };
        const M: any = {
            memory: { sensory: {}, vars: {}, longTerm: { episodic: [], semantic: { concepts: [] }, procedural: { skills: [] } } },
            worldModel: {},
            goalState: { hierarchy: { nodes: { g1: { id: 'g1', title: 'A', type: 'short', priority: 1, status: 'active', createdAt: '', updatedAt: '' } }, roots: ['g1'] } },
            emotion: { valence: 0, arousal: 0.2 },
            rewardParams: { extrinsicWeights: [1], intrinsic: { curiosity: 0, novelty: 0, competence: 0, exploration: 0 }, discountGamma: 0.99 },
            policyParams: { theta: null, stochastic: false }
        };
        const env: any = { time: new Date().toISOString(), input: {}, pending: { inputs: {}, children: {}, tools: {}, groups: {} } };
        // First turn: no done goals → reward 0
        const r1 = await runLoop(ctx, M, env, { policy: () => ({ kind: 'language', content: 'x' }) }, { maxTurns: 1 });
        expect((r1.metrics?.rewards?.[0] ?? 0)).toBe(0);
        // Mark goal as done
        (M.goalState.hierarchy.nodes as any).g1.status = 'done';
        const r2 = await runLoop(ctx, M, env, { policy: () => ({ kind: 'language', content: 'y' }) }, { maxTurns: 1 });
        expect((r2.metrics?.rewards?.[0] ?? 0)).toBe(1);
    });
});


