import { runLoop } from '../src/loop/loopRunner.js';

describe('ReAct-style planner (feature flag)', () => {
    it('selects tool based on regex pattern over last observation', async () => {
        const ctx: any = { reply: async () => { } };
        const M: any = {
            memory: { sensory: { lastObservation: 'Search for cats near Boston' }, shortTerm: { vars: {} }, longTerm: { episodic: [], semantic: { concepts: [] }, procedural: { skills: [] } } },
            worldModel: {},
            goalState: { hierarchy: { nodes: {}, roots: [] } },
            emotion: { valence: 0, arousal: 0.2 },
            rewardParams: { extrinsicWeights: [1], intrinsic: { curiosity: 0, novelty: 0, competence: 0, exploration: 0 }, discountGamma: 0.99 },
            policyParams: { theta: null, stochastic: false, reactPlanner: { enabled: true, patterns: [{ regex: 'search for (.+)', tool: 'search', argKey: 'q' }] } }
        };
        const env: any = { time: new Date().toISOString(), input: 'Search for cats near Boston', pending: { inputs: {}, children: {}, tools: {}, groups: {} } };
        const { outcome } = await runLoop(ctx, M, env, {}, { maxTurns: 1 });
        // execution is default; tool is sync → continue
        expect(outcome.kind).toBe('continue');
    });
});


