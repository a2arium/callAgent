import { runLoop } from '../src/loop/loopRunner.js';
import type { EnvironmentState } from '../src/loop/types.js';

describe('Example agent overrides (docs parity)', () => {
    it('transition override attaches custom await_tool token', async () => {
        const ctx: any = { reply: async () => { } };
        const M: any = {
            memory: { sensory: {}, vars: {}, longTerm: { episodic: [], semantic: { concepts: [] }, procedural: { skills: [] } } },
            worldModel: { implicit: null, explicit: null, simulator: null },
            goalState: { hierarchy: { nodes: {}, roots: [] } },
            emotion: { valence: 0, arousal: 0.2 },
            rewardParams: { extrinsicWeights: [1], intrinsic: { curiosity: 0, novelty: 0, competence: 0, exploration: 0 }, discountGamma: 0.99 },
            policyParams: { theta: null, stochastic: false }
        };
        (ctx as any).agentId = 'docs-mini';
        const env: EnvironmentState = {
            time: new Date().toISOString(),
            input: {},
            pending: { inputs: {}, children: {}, tools: {}, groups: {} },
            inbox: { current: [], all: [] }
        } as any;
        const { outcome } = await runLoop(ctx, M, env, {
            policy: () => ({ kind: 'tool', name: 'dummy', args: {} }),
            execution: async (a, c, m) => {
                if ((a as any).kind === 'tool') {
                    return {
                        action: { kind: 'tool', token: 'tool-xyz' },
                        result: { status: 'ok', ts: Date.now(), toolId: (a as any).name, correlationId: 'tool-xyz' }
                    } as any;
                }
                // Default execution for non-tool actions
                return {
                    action: a as any,
                    result: { status: 'ok', ts: Date.now() }
                } as any;
            },
            transition: (_env, exec) => {
                const action = exec?.action || exec;
                if (action?.kind === 'tool' && action.token) {
                    return { kind: 'await_tool', token: action.token, category: 'io' } as any;
                }
                return { kind: 'continue', observations: [] } as any;
            }
        });
        expect(outcome.kind).toBe('await_tool');
        expect((outcome as any).token).toBe('tool-xyz');
        // Ensure our custom field is preserved in the outcome for logs/metrics
        expect((outcome as any).category).toBe('io');
    });
});


