import { runOfflineReplay } from '../src/loop/offline.js';

describe('Offline replay', () => {
    it('applies optimizer patch to policy/reward params', async () => {
        const M: any = {
            memory: { sensory: {}, shortTerm: { vars: {} }, longTerm: { episodic: [{ t: 1, obs: { x: 1 }, act: { k: 'a' }, rew: 0.5 }], semantic: { concepts: [] }, procedural: { skills: [] } } },
            worldModel: {},
            goalState: { hierarchy: { nodes: {}, roots: [] } },
            emotion: { valence: 0, arousal: 0.2 },
            rewardParams: { extrinsicWeights: [1], intrinsic: { curiosity: 0, novelty: 0, competence: 0, exploration: 0 }, discountGamma: 0.99 },
            policyParams: { theta: null, stochastic: true }
        };
        const optimizer = {
            onEpisode: (events: any[]) => ({ policyParamsPatch: { temperature: 0.8 }, rewardParamsPatch: { discountGamma: 0.95 } })
        };
        const { M: M2, applied, eventCount } = await runOfflineReplay(M, optimizer);
        expect(eventCount).toBe(1);
        expect(applied.policyParamsPatch?.temperature).toBe(0.8);
        expect(applied.rewardParamsPatch?.discountGamma).toBe(0.95);
        expect(M2.policyParams.temperature).toBe(0.8);
        expect(M2.rewardParams.discountGamma).toBe(0.95);
    });
});


