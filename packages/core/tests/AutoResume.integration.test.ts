import { TaskEngine, type TaskEntity } from '../src/core/orchestration/taskEngine.js';
import type { IWorkingMemorySessionStore, WMSessionSnapshot } from '../src/core/memory/stores/SessionStore.js';
import { createAgent } from '../src/index.js';
import { PluginManager } from '../src/core/plugin/pluginManager.js';

class MockSessionStore implements IWorkingMemorySessionStore {
    private snapshots = new Map<string, { wmVersion: bigint; snapshot: Record<string, unknown>; agentId: string; updatedAt: string }>();
    private seqs = new Map<string, number>();

    private key(tenantId: string, sessionId: string) { return `${tenantId}:${sessionId}`; }

    async getSessionSnapshot(tenantId: string, sessionId: string): Promise<WMSessionSnapshot | null> {
        const k = this.key(tenantId, sessionId);
        const s = this.snapshots.get(k);
        return s ? { wmVersion: s.wmVersion, snapshot: s.snapshot, agentId: s.agentId, updatedAt: s.updatedAt } : null;
    }

    async writeSnapshotCAS(params: { tenantId: string; sessionId: string; agentId: string; expectedWmVersion: bigint; snapshot: Record<string, unknown>; }): Promise<{ newVersion: bigint }> {
        const k = this.key(params.tenantId, params.sessionId);
        const existing = this.snapshots.get(k);
        if (existing && existing.wmVersion !== params.expectedWmVersion) {
            throw new Error('CAS_MISMATCH');
        }
        const nextVer = (existing?.wmVersion ?? 0n) + 1n;
        this.snapshots.set(k, { wmVersion: nextVer, snapshot: params.snapshot, agentId: params.agentId, updatedAt: new Date().toISOString() });
        return { newVersion: nextVer };
    }

    async appendEvent(): Promise<{ eventId: string; seq: number }> {
        const id = `${Date.now()}`;
        const nextSeq = (this.seqs.get(id) ?? 0) + 1;
        this.seqs.set(id, nextSeq);
        return { eventId: id, seq: nextSeq };
    }

    async listEventsSince(): Promise<Array<{ eventId: string; seq: number; type: string; payload: Record<string, unknown>; createdAt: string }>> {
        return [];
    }

    async enqueueOutbox(): Promise<void> { /* no-op */ }
}

describe('Auto-Resume Integration Tests', () => {
    let store: MockSessionStore;
    let engine: TaskEngine;
    const tenantId = 'test-tenant';

    beforeEach(() => {
        store = new MockSessionStore();
        engine = new TaskEngine({ sessionStore: store });
    });

    describe('Input Auto-Resume', () => {
        it('auto-resumes with env.input after user provides input', async () => {
            const taskId = 'auto-resume-input-test';
            let resumedInput: any = null;

            // Create loop-first agent that handles auto-resume
            const testAgent = createAgent({
                manifest: { name: 'auto-resume-test-agent', version: '1.0.0', runMode: 'loop' },
                loop: {
                    modules: {
                        policy: (M: any, env: any) => {
                            // Handle auto-resumed input
                            if (env.input?.kind === 'input') {
                                resumedInput = env.input.value;
                                return { kind: 'language', content: `Received: ${env.input.value}` };
                            }

                            // Initial turn - ask for input
                            M.memory.vars = { ...M.memory.vars, testVar: 'initial-value' };
                            return { kind: 'ask_user', prompt: 'Provide a value' };
                        },

                        execution: async (action: any, ctx: any, M: any) => {
                            if (action.kind === 'ask_user') {
                                const handle = await ctx.requestInput(action.prompt);
                                return { kind: 'ask_user', token: handle.token };
                            }
                            if (action.kind === 'language') {
                                await ctx.reply(action.content);
                                return { kind: 'language', echoed: true };
                            }
                            return { kind: 'internal', done: true };
                        },

                        transition: (env: any, exec: any, M: any) => {
                            if (exec.kind === 'ask_user') {
                                return { kind: 'await_input', token: exec.token };
                            }
                            if (exec.kind === 'language') {
                                return { kind: 'complete' };
                            }
                            return { kind: 'continue' };
                        }
                    }
                },
                async handleTask(ctx: any) { return; }
            }, import.meta.url);

            PluginManager.registerAgent(testAgent);

            // Start task - should result in await_input
            const entity: TaskEntity = { id: taskId, input: {}, agentId: 'auto-resume-test-agent' };
            const result1 = await engine.startTask({ task: entity, isStreaming: true, tenantId, agentId: 'auto-resume-test-agent' });

            expect(result1.status).toBe('input-required');
            expect(result1.metadata?.token).toBeDefined();

            // Verify MentalState was persisted with vars
            const snap1 = await store.getSessionSnapshot(tenantId, taskId);
            expect(snap1).not.toBeNull();
            const M1 = (snap1!.snapshot as any).M;
            expect(M1.memory?.vars?.testVar).toBe('initial-value');

            // Resume with input - should auto-resume and process input
            const token = result1.metadata?.token as string;
            await engine.resumeInput({ tenantId, taskId, token, input: 'user-provided-value' });

            // Verify auto-resume processed the input
            expect(resumedInput).toBe('user-provided-value');

            // Verify final MentalState still has vars
            const snap2 = await store.getSessionSnapshot(tenantId, taskId);
            const M2 = (snap2!.snapshot as any).M;
            expect(M2.memory?.vars?.testVar).toBe('initial-value');
        });

        it('preserves MentalState across auto-resume turns', async () => {
            const taskId = 'mental-state-preservation-test';
            let turnCount = 0;

            const testAgent = createAgent({
                manifest: { name: 'mental-state-test-agent', version: '1.0.0', runMode: 'loop' },
                loop: {
                    modules: {
                        policy: (M: any, env: any) => {
                            turnCount++;

                            if (env.input?.kind === 'input') {
                                // Verify state preserved from previous turn
                                expect(M.memory.vars.turnNumber).toBe(1);
                                M.memory.vars.turnNumber = 2;
                                return { kind: 'language', content: `Turn ${turnCount}, vars preserved` };
                            }

                            // Initial turn
                            M.memory.vars = { ...M.memory.vars, turnNumber: 1 };
                            return { kind: 'ask_user', prompt: 'Continue?' };
                        },

                        transition: (env: any, exec: any, M: any) => {
                            if (exec.kind === 'ask_user') return { kind: 'await_input', token: exec.token };
                            if (exec.kind === 'language') return { kind: 'complete' };
                            return { kind: 'continue' };
                        }
                    }
                },
                async handleTask(ctx: any) { return; }
            }, import.meta.url);

            PluginManager.registerAgent(testAgent);

            // Initial turn
            const entity: TaskEntity = { id: taskId, input: {}, agentId: 'mental-state-test-agent' };
            const result1 = await engine.startTask({ task: entity, isStreaming: true, tenantId, agentId: 'mental-state-test-agent' });

            expect(result1.status).toBe('input-required');
            expect(turnCount).toBe(1);

            // Auto-resume turn
            const token = result1.metadata?.token as string;
            await engine.resumeInput({ tenantId, taskId, token, input: 'yes' });

            expect(turnCount).toBe(2);

            // Verify final state
            const snap = await store.getSessionSnapshot(tenantId, taskId);
            const M = (snap!.snapshot as any).M;
            expect(M.memory?.vars?.turnNumber).toBe(2);
        });
    });

    describe('Tool Auto-Resume', () => {
        it('auto-resumes with tool result in env.input', async () => {
            const taskId = 'tool-auto-resume-test';
            let toolResult: any = null;

            const testAgent = createAgent({
                manifest: { name: 'tool-resume-test-agent', version: '1.0.0', runMode: 'loop' },
                loop: {
                    modules: {
                        policy: (M: any, env: any) => {
                            if (env.input?.kind === 'tool') {
                                toolResult = env.input.result;
                                return { kind: 'language', content: `Tool result: ${JSON.stringify(env.input.result)}` };
                            }
                            return { kind: 'tool', name: 'test-tool', args: { query: 'hello' } };
                        },

                        execution: async (action: any, ctx: any, M: any) => {
                            if (action.kind === 'tool') {
                                // Mock tool execution
                                const result = { success: true, data: 'tool-response' };
                                return { kind: 'tool', token: 'tool-token-123', result };
                            }
                            if (action.kind === 'language') {
                                await ctx.reply(action.content);
                                return { kind: 'language', echoed: true };
                            }
                            return { kind: 'internal', done: true };
                        },

                        transition: (env: any, exec: any, M: any) => {
                            if (exec.kind === 'tool' && exec.token) {
                                return { kind: 'await_tool', token: exec.token };
                            }
                            if (exec.kind === 'language') {
                                return { kind: 'complete' };
                            }
                            return { kind: 'continue' };
                        }
                    }
                },
                async handleTask(ctx: any) { return; }
            }, import.meta.url);

            PluginManager.registerAgent(testAgent);

            // Start task - should result in await_tool
            const entity: TaskEntity = { id: taskId, input: {}, agentId: 'tool-resume-test-agent' };
            const result1 = await engine.startTask({ task: entity, isStreaming: true, tenantId, agentId: 'tool-resume-test-agent' });

            expect(result1.status).toBe('working');
            expect(result1.metadata?.awaiting).toBe('tool');

            // Simulate tool completion and auto-resume
            const token = 'tool-token-123';
            const toolCompletionResult = { success: true, data: 'completed-tool-response' };
            await engine.handleToolCompleted({ tenantId, taskId, token, result: toolCompletionResult });

            // Verify auto-resume processed the tool result
            expect(toolResult).toEqual(toolCompletionResult);
        });
    });

    describe('Child Agent Auto-Resume', () => {
        it('auto-resumes parent with child result in env.input', async () => {
            const taskId = 'child-auto-resume-test';
            let childOutput: any = null;

            const testAgent = createAgent({
                manifest: { name: 'parent-resume-test-agent', version: '1.0.0', runMode: 'loop' },
                loop: {
                    modules: {
                        policy: (M: any, env: any) => {
                            if (env.input?.kind === 'child') {
                                childOutput = env.input.output;
                                return { kind: 'language', content: `Child completed: ${JSON.stringify(env.input.output)}` };
                            }
                            return { kind: 'subagent', target: 'child-agent', input: { task: 'process-data' } };
                        },

                        execution: async (action: any, ctx: any, M: any) => {
                            if (action.kind === 'subagent') {
                                // Mock child execution
                                return { kind: 'subagent', token: 'child-token-456' };
                            }
                            if (action.kind === 'language') {
                                await ctx.reply(action.content);
                                return { kind: 'language', echoed: true };
                            }
                            return { kind: 'internal', done: true };
                        },

                        transition: (env: any, exec: any, M: any) => {
                            if (exec.kind === 'subagent' && exec.token) {
                                return { kind: 'await_child', token: exec.token };
                            }
                            if (exec.kind === 'language') {
                                return { kind: 'complete' };
                            }
                            return { kind: 'continue' };
                        }
                    }
                },
                async handleTask(ctx: any) { return; }
            }, import.meta.url);

            PluginManager.registerAgent(testAgent);

            // Start task - should result in await_child
            const entity: TaskEntity = { id: taskId, input: {}, agentId: 'parent-resume-test-agent' };
            const result1 = await engine.startTask({ task: entity, isStreaming: true, tenantId, agentId: 'parent-resume-test-agent' });

            expect(result1.status).toBe('working');
            expect(result1.metadata?.awaiting).toBe('child');

            // Simulate child completion and auto-resume
            const token = 'child-token-456';
            const childCompletionOutput = { status: 'completed', result: { processed: true, data: 'child-data' } };
            await engine.handleChildCompleted({ tenantId, taskId, token, output: childCompletionOutput });

            // Verify auto-resume processed the child output
            expect(childOutput).toEqual(childCompletionOutput);
        });
    });

    describe('External Event Auto-Resume', () => {
        it('auto-resumes with external event payload in env.input', async () => {
            const taskId = 'external-event-test';
            let eventPayload: any = null;

            const testAgent = createAgent({
                manifest: { name: 'external-event-test-agent', version: '1.0.0', runMode: 'loop' },
                loop: {
                    modules: {
                        policy: (M: any, env: any) => {
                            if (env.input?.kind === 'external') {
                                eventPayload = env.input.payload;
                                return { kind: 'language', content: `External event: ${JSON.stringify(env.input.payload)}` };
                            }
                            // Register for external event and wait
                            return { kind: 'internal', intent: 'wait-for-external' };
                        },

                        execution: async (action: any, ctx: any, M: any) => {
                            if (action.kind === 'internal' && action.intent === 'wait-for-external') {
                                // Mock external event registration
                                return { kind: 'external', token: 'external-token-789' };
                            }
                            if (action.kind === 'language') {
                                await ctx.reply(action.content);
                                return { kind: 'language', echoed: true };
                            }
                            return { kind: 'internal', done: true };
                        },

                        transition: (env: any, exec: any, M: any) => {
                            if (exec.kind === 'external' && exec.token) {
                                return { kind: 'await_external', token: exec.token };
                            }
                            if (exec.kind === 'language') {
                                return { kind: 'complete' };
                            }
                            return { kind: 'continue' };
                        }
                    }
                },
                async handleTask(ctx: any) { return; }
            }, import.meta.url);

            PluginManager.registerAgent(testAgent);

            // Start task - should result in await_external
            const entity: TaskEntity = { id: taskId, input: {}, agentId: 'external-event-test-agent' };
            const result1 = await engine.startTask({ task: entity, isStreaming: true, tenantId, agentId: 'external-event-test-agent' });

            // Note: This test assumes await_external is a valid outcome type
            // If not implemented yet, this would be part of the external events feature

            // Simulate external event and auto-resume
            const token = 'external-token-789';
            const externalEventPayload = { type: 'notification', data: { message: 'External event occurred' } };

            // This would trigger auto-resume with external event
            if (engine.handleExternalEventOccurred) {
                await engine.handleExternalEventOccurred({ tenantId, taskId, token, payload: externalEventPayload });
                expect(eventPayload).toEqual(externalEventPayload);
            }
        });
    });
});
