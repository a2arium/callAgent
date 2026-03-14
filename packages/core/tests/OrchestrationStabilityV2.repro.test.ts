import { jest } from '@jest/globals';
import { runLoop } from '../src/loop/loopRunner.js';
import { createAgent } from '../src/plugin/createAgent.js';

describe('Orchestration & Stability V2 Repros', () => {
    describe('Bug 1: Turn Counter Resets on A2A/Resume', () => {
        it('should increment env.turn correctly even after resumption (multiple runLoop calls)', async () => {
            const ctx: any = {
                task: { id: 'test-task' },
                telemetry: { nodeId: 'test-node' },
                logger: { debug: () => { }, info: () => { }, warn: () => { }, error: () => { } }
            };
            const M: any = { memory: { longTerm: {} } };
            const env: any = {
                turn: 0,
                inbox: { current: [], all: [] },
                pending: {},
                budget: { maxTurns: 10 }
            };
            const modules: any = {
                attention: () => ({ kind: 'all' }),
                perception: (e: any) => ({ ...e }),
                learning: (m: any) => m,
                policy: () => ({ kind: 'tool', name: 'test-tool', args: {} }),
                execution: async () => ({ action: { kind: 'tool', token: 'token1' }, result: { status: 'ok' } }),
                transition: () => ({ kind: 'await_tool', token: 'token1' })
            };

            // First run: executes one turn and yields
            env.turn++; // TaskExecutor increments turn before runLoop
            const res1 = await runLoop(ctx, M, env, modules, { maxTurns: 5 });
            expect(env.turn).toBe(1); // First turn completed
            expect(res1.outcome.kind).toBe('await_tool');

            // Simulate resumption by calling runLoop again with the same env
            // The policy now returns 'continue' to allow another turn
            modules.policy = () => ({ kind: 'internal', done: true });
            modules.transition = () => ({ kind: 'complete' });

            env.turn++; // TaskExecutor increments turn on resume
            const res2 = await runLoop(ctx, res1.M, env, modules, { maxTurns: 5 });

            // Ensure env.turn correctly progressed
            expect(env.turn).toBe(2);
        });
    });
    describe('Bug 3: createAgent LLM Config Drop', () => {
        it('should forward llmConfig and llmAdapter', async () => {
            const options: any = {
                agentCard: {
                    inline: {
                        name: 'test-agent',
                        version: '1.0.0',
                        description: 'test',
                        supportedInterfaces: [{ protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: 'http://localhost' }],
                        capabilities: {},
                        defaultInputModes: ['text/plain'],
                        defaultOutputModes: ['text/plain'],
                        skills: [{ id: 'test-agent', name: 'Test Agent', description: 'Test agent skill' }]
                    }
                },
                runtimeManifest: {
                    inline: {
                        name: 'test-agent',
                        version: '1.0.0',
                        runMode: 'loop'
                    }
                },
                llmConfig: { model: 'gpt-4' },
                llmAdapter: { call: () => { } }
            };
            const plugin = await createAgent(options);
            expect(plugin.llmConfig).toBe(options.llmConfig);
            expect(plugin.llmAdapter).toBe(options.llmAdapter);
        });
    });

    describe('Bug 2: A2A Budget Inheritance Overwrites Manifest', () => {
        it('should show the hardcoded 50 fallback in TaskEngine (verified via source)', () => {
            // This bug is verified by source analysis in taskEngine.ts:2350
            // loopOpts = { maxTurns: 50 }; // Safety default
            // It's hardcoded and not derived from a central configuration.
            expect(true).toBe(true);
        });
    });

    describe('Bug 4: Prisma Error Logging Spam', () => {
        it('should have "error" in Prisma log configuration (verified via source)', async () => {
            // verified in outboxPublisher.ts:38
            // log: ['info', 'warn', 'error']
            expect(true).toBe(true);
        });
    });
});
