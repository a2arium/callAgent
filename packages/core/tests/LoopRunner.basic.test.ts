import { createMinimalTestContext } from '../test-utils.js';
import { runLoop } from '../src/loop/loopRunner.js';
import type { EnvironmentState } from '../src/loop/types.js';


describe('LoopRunner basic', () => {
    it('maps ask_user to await_input', async () => {
        const ctx: any = createMinimalTestContext('test-tenant', 'test-agent');
        ctx.requestInput = async (prompt: string) => ({ token: 'tok-123', prompt });
        const M: any = {
            memory: { sensory: {}, vars: {}, longTerm: { episodic: [], semantic: { concepts: [] }, procedural: { skills: [] } } },
            worldModel: { implicit: null, explicit: null, simulator: null },
            goalState: { hierarchy: { nodes: {}, roots: [] } },
            emotion: { valence: 0, arousal: 0.2 },
            rewardParams: { extrinsicWeights: [1], intrinsic: { curiosity: 0, novelty: 0, competence: 0, exploration: 0 }, discountGamma: 0.99 },
            policyParams: { theta: null, stochastic: false }
        };
        const env: EnvironmentState = {
            time: new Date().toISOString(),
            input: { x: 1 },
            pending: { inputs: {}, children: {}, tools: {}, groups: {} },
            inbox: { current: [], all: [] }
        } as any;
        const { outcome } = await runLoop(ctx, M, env, {
            policy: () => ({ kind: 'ask_user', prompt: 'enter value' })
        }, { maxTurns: 1 });
        expect(outcome.kind).toBe('await_input');
        expect((outcome as any).token).toBe('tok-123');
        expect(env.inbox.current).toEqual([]);
        expect(env.inbox.all).toEqual([]);
    });

    it('runs language path and continues', async () => {
        const ctx: any = createMinimalTestContext('test-tenant', 'test-agent');
        let replied = false;
        ctx.reply = async () => { replied = true; };
        const M: any = {
            memory: { sensory: {}, vars: {}, longTerm: { episodic: [], semantic: { concepts: [] }, procedural: { skills: [] } } },
            worldModel: { implicit: null, explicit: null, simulator: null },
            goalState: { hierarchy: { nodes: {}, roots: [] } },
            emotion: { valence: 0, arousal: 0.2 },
            rewardParams: { extrinsicWeights: [1], intrinsic: { curiosity: 0, novelty: 0, competence: 0, exploration: 0 }, discountGamma: 0.99 },
            policyParams: { theta: null, stochastic: false }
        };
        const env: EnvironmentState = {
            time: new Date().toISOString(),
            input: { x: 1 },
            pending: { inputs: {}, children: {}, tools: {}, groups: {} },
            inbox: { current: [], all: [] }
        } as any;
        const { outcome } = await runLoop(ctx, M, env, {
            policy: () => ({ kind: 'language', content: 'hi' })
        }, { maxTurns: 1 });
        expect(outcome.kind).toBe('continue');
        expect(replied).toBe(true);
        expect(env.inbox.all.length).toBeGreaterThanOrEqual(1);
        expect(env.inbox.current.length).toBeGreaterThanOrEqual(1);
        expect(env.inbox.current[0].source).toBe('env');
    });

    it('maps subagent to await_child when token returned', async () => {
        const ctx: any = createMinimalTestContext('test-tenant', 'test-agent');
        ctx.sendTaskToAgent = async () => ({ childToken: 'child-1' });
        const M: any = {
            memory: { sensory: {}, vars: {}, longTerm: { episodic: [], semantic: { concepts: [] }, procedural: { skills: [] } } },
            worldModel: { implicit: null, explicit: null, simulator: null },
            goalState: { hierarchy: { nodes: {}, roots: [] } },
            emotion: { valence: 0, arousal: 0.2 },
            rewardParams: { extrinsicWeights: [1], intrinsic: { curiosity: 0, novelty: 0, competence: 0, exploration: 0 }, discountGamma: 0.99 },
            policyParams: { theta: null, stochastic: false }
        };
        const env: EnvironmentState = {
            time: new Date().toISOString(),
            input: { x: 1 },
            pending: { inputs: {}, children: {}, tools: {}, groups: {} },
            inbox: { current: [], all: [] }
        } as any;
        const { outcome } = await runLoop(ctx, M, env, {
            policy: () => ({ kind: 'subagent', target: 'child', input: { y: 1 }, awaitCompletion: true })
        }, { maxTurns: 1 });
        expect(outcome.kind).toBe('await_child');
        expect((outcome as any).token).toBe('child-1');
        expect(env.inbox.current).toEqual([]);
    });

    it('maps tool to continue by default (sync tool)', async () => {
        const ctx: any = createMinimalTestContext('test-tenant', 'test-agent');
        ctx.tools = { invoke: async () => ({ ok: true }) };
        const M: any = {
            memory: { sensory: {}, vars: {}, longTerm: { episodic: [], semantic: { concepts: [] }, procedural: { skills: [] } } },
            worldModel: { implicit: null, explicit: null, simulator: null },
            goalState: { hierarchy: { nodes: {}, roots: [] } },
            emotion: { valence: 0, arousal: 0.2 },
            rewardParams: { extrinsicWeights: [1], intrinsic: { curiosity: 0, novelty: 0, competence: 0, exploration: 0 }, discountGamma: 0.99 },
            policyParams: { theta: null, stochastic: false }
        };
        const env: EnvironmentState = {
            time: new Date().toISOString(),
            input: { x: 1 },
            pending: { inputs: {}, children: {}, tools: {}, groups: {} },
            inbox: { current: [], all: [] }
        } as any;
        const { outcome } = await runLoop(ctx, M, env, {
            policy: () => ({ kind: 'tool', name: 'syncTool', args: {} })
        }, { maxTurns: 1 });
        expect(outcome.kind).toBe('continue');
        expect(env.inbox.all.length).toBeGreaterThanOrEqual(1);
        expect(env.inbox.current.length).toBeGreaterThanOrEqual(1);
        expect(env.inbox.current[0].source).toBe('tool');
    });

    it('passes manifest config through env.config to modules', async () => {
        const ctx: any = createMinimalTestContext('test-tenant', 'test-agent');
        const M: any = {
            memory: { sensory: {}, vars: {}, longTerm: { episodic: [], semantic: { concepts: [] }, procedural: { skills: [] } } },
            worldModel: { implicit: null, explicit: null, simulator: null },
            goalState: { hierarchy: { nodes: {}, roots: [] } },
            emotion: { valence: 0, arousal: 0.2 },
            rewardParams: { extrinsicWeights: [1], intrinsic: { curiosity: 0, novelty: 0, competence: 0, exploration: 0 }, discountGamma: 0.99 },
            policyParams: { theta: null, stochastic: false }
        };
        
        // Create environment with manifest config
        const manifestConfig = { enableValidation: true, validationCoverageThreshold: 95 };
        const env: EnvironmentState = {
            time: new Date().toISOString(),
            input: { x: 1 },
            pending: { inputs: {}, children: {}, tools: {}, groups: {} },
            inbox: { current: [], all: [] },
            config: manifestConfig
        } as any;

        // Track that perception receives the config
        let receivedConfig: Record<string, unknown> | undefined;
        const { outcome } = await runLoop(ctx, M, env, {
            perception: (env) => {
                receivedConfig = env.config as Record<string, unknown>;
                return [];
            },
            policy: () => ({ kind: 'complete', result: { success: true } })
        }, { maxTurns: 1 });

        expect(outcome.kind).toBe('complete');
        expect(receivedConfig).toBeDefined();
        expect(receivedConfig?.enableValidation).toBe(true);
        expect(receivedConfig?.validationCoverageThreshold).toBe(95);
    });
});
