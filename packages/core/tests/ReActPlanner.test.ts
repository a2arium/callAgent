import { jest } from '@jest/globals';
import { runLoop } from '../src/loop/loopRunner.js';

describe('ReAct-style planner (feature flag)', () => {
    it('selects tool based on regex pattern over last observation', async () => {
        const toolInvoke = jest.fn<any>().mockResolvedValue('ok');
        const ctx: any = {
            reply: async () => { },
            task: { id: 'react-planner-test-task' },
            tools: { invoke: toolInvoke }
        };
        const M: any = {
            memory: { sensory: { lastObservation: 'Search for cats near Boston' }, vars: {}, longTerm: { episodic: [], semantic: { concepts: [] }, procedural: { skills: [] } } },
            worldModel: {},
            goalState: { hierarchy: { nodes: {}, roots: [] } },
            emotion: { valence: 0, arousal: 0.2 },
            rewardParams: { extrinsicWeights: [1], intrinsic: { curiosity: 0, novelty: 0, competence: 0, exploration: 0 }, discountGamma: 0.99 },
            policyParams: { theta: null, stochastic: false, reactPlanner: { enabled: true, patterns: [{ regex: 'search for (.+)', tool: 'search', argKey: 'q' }] } }
        };
        const env: any = { time: new Date().toISOString(), input: 'Search for cats near Boston', pending: { inputs: {}, children: {}, tools: {}, groups: {} } };
        const modules = {
            perception: (e: any) => ({
                time: e.time,
                input: e.input,
                pending: e.pending,
                inbox: []
            })
        };
        try {
            await runLoop(ctx, M, env, modules, { maxTurns: 1 });
        } catch (e) {
            // Expected: InvariantError for local turn limit
        }
        expect(toolInvoke).toHaveBeenCalledWith('search', { q: 'cats near Boston', context: undefined });
    });
});


