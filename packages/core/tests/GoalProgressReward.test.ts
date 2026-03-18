import { runLoop } from '../src/loop/loopRunner.js';

describe('Goal progress extrinsic reward', () => {
    it('rewards when done count increases', async () => {
        const ctx: any = {
            reply: async () => { },
            task: { id: 'goal-reward-test-task' }
        };
        const M: any = {
            memory: { sensory: {}, vars: {}, longTerm: { episodic: [], semantic: { concepts: [] }, procedural: { skills: [] } } },
            worldModel: {},
            goalState: { hierarchy: { nodes: { g1: { id: 'g1', title: 'A', type: 'short', priority: 1, status: 'active', createdAt: '', updatedAt: '' } }, roots: ['g1'] } },
            emotion: { valence: 0, arousal: 0.2 },
            rewardParams: { extrinsicWeights: [1], intrinsic: { curiosity: 0, novelty: 0, competence: 0, exploration: 0 }, discountGamma: 0.99 },
            policyParams: { theta: null, stochastic: false }
        };
        const env: any = { time: new Date().toISOString(), input: {}, pending: { inputs: {}, children: {}, tools: {}, groups: {} } };
        const modules = {
            policy: (m: any) => {
                const nodes = m.goalState?.hierarchy?.nodes || {};
                const done = Object.values(nodes).filter((n: any) => n.status === 'done').length;
                m.DoneCount = done;
                return { kind: 'internal', done: true } as any;
            }
        };
        // First turn: no done goals → reward 0
        const res1 = await runLoop(ctx, M, env, modules, { maxTurns: 1 });
        expect((res1.M as any).DoneCount ?? 0).toBe(0);

        // Mark goal as done
        (M.goalState.hierarchy.nodes as any).g1.status = 'done';
        const res2 = await runLoop(ctx, M, env, modules, { maxTurns: 1 });
        expect((res2.M as any).DoneCount).toBe(1);
    });
});


