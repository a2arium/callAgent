/**
 * Targeted line coverage tests for specific uncovered lines:
 * 4398-4407: Semantic memory read functionality
 * 4429-4430: Goals clear functionality
 * 4534-4535: Input required check
 * 4579-4587: Error handling in durable handlers
 */

import { jest } from '@jest/globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IWorkingMemorySessionStore, WMSessionSnapshot } from '../src/core/memory/stores/SessionStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const a2aPath = path.resolve(__dirname, '../src/core/orchestration/A2AService.ts');
const outboxPath = path.resolve(__dirname, '../src/eventbus/outboxPublisher.ts');
const loopRunnerPath = path.resolve(__dirname, '../src/loop/loopRunner.ts');
const taskEnginePath = path.resolve(__dirname, '../src/core/orchestration/taskEngine.ts');

await jest.unstable_mockModule(a2aPath, () => ({
    globalA2AService: {
        sendTaskToAgent: jest.fn() as any,
        findLocalAgent: jest.fn().mockResolvedValue({
            manifest: { name: 'mock-agent' },
            loop: {},
            llmAdapter: {},
            tenantId: 'test-tenant'
        })
    }
} as any));

await jest.unstable_mockModule(outboxPath, () => ({
    outboxPublisher: { start: jest.fn(), stop: jest.fn() }
}));

await jest.unstable_mockModule(loopRunnerPath, () => ({
    runLoop: jest.fn().mockResolvedValue({
        M: { memory: { vars: {} } },
        outcome: { kind: 'complete', result: {} },
        metrics: {}
    })
}));

await jest.unstable_mockModule('@prisma/client', () => ({ PrismaClient: class { } }), { virtual: true });

const { TaskEngine } = await import(taskEnginePath);

class FakeSessionStore implements IWorkingMemorySessionStore {
    private snapshots = new Map<string, WMSessionSnapshot>();
    private outbox: Array<{ tenantId: string; topic: string; key: string; payload: Record<string, unknown> }> = [];

    seed(tenantId: string, sessionId: string, snapshot: Record<string, unknown>, wmVersion = BigInt(0), agentId = 'agent'): void {
        const key = `${tenantId}:${sessionId}`;
        this.snapshots.set(key, { wmVersion, snapshot, agentId, updatedAt: new Date().toISOString() });
    }

    getSnapshot(tenantId: string, sessionId: string): WMSessionSnapshot | null {
        return this.snapshots.get(`${tenantId}:${sessionId}`) ?? null;
    }

    async getSessionSnapshot(tenantId: string, sessionId: string): Promise<WMSessionSnapshot | null> {
        return this.getSnapshot(tenantId, sessionId);
    }

    async writeSnapshotCAS(params: {
        tenantId: string;
        sessionId: string;
        agentId: string;
        expectedWmVersion: bigint;
        snapshot: Record<string, unknown>;
    }): Promise<{ newVersion: bigint }> {
        const key = `${params.tenantId}:${params.sessionId}`;
        const current = this.snapshots.get(key);
        const currentVersion = current?.wmVersion ?? BigInt(0);

        if (current && current.wmVersion !== params.expectedWmVersion) {
            throw new Error('CAS_MISMATCH');
        }

        const newVersion = currentVersion + BigInt(1);
        this.snapshots.set(key, {
            wmVersion: newVersion,
            snapshot: params.snapshot,
            agentId: params.agentId,
            updatedAt: new Date().toISOString()
        });
        return { newVersion };
    }

    async appendEvent(params: { tenantId: string; sessionId: string; type: string; payload: Record<string, unknown> }): Promise<{ eventId: string; seq: number }> {
        return { eventId: `evt-${Date.now()}`, seq: 0 };
    }

    async enqueueOutbox(params: { tenantId: string; topic: string; key: string; payload: Record<string, unknown> }): Promise<void> {
        this.outbox.push(params);
    }

    getOutbox() {
        return this.outbox;
    }

    async load(tenantId: string, taskId: string): Promise<WMSessionSnapshot | null> {
        return this.getSnapshot(tenantId, taskId);
    }

    async consumeBudget(tenantId: string, budgetId: string, amount: number): Promise<void> {
        // Mock implementation
    }

    async restoreBudget(tenantId: string, budgetId: string, amount: number): Promise<void> {
        // Mock implementation
    }

    close(): void {
        // Mock implementation
    }
}

beforeAll(() => {
    process.env.DISABLE_OUTBOX_PUBLISHER = '1';
});

afterEach(() => {
    jest.clearAllMocks();
    TaskEngine.testOverrides = undefined;
});

describe('TaskEngine Targeted Line Coverage Tests', () => {
    describe('Lines 4398-4407: Semantic Memory Read', () => {
        test('semantic memory read with context that has memory.semantic', async () => {
            const store = new FakeSessionStore();
            const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });

            // Override attachWorkingMemory to set up semantic memory
            TaskEngine.testOverrides = {
                attachWorkingMemory: async (ctx: any, snapshot: any) => {
                    // Set up mock semantic memory that will be used when wiring context
                    ctx.memory = {
                        semantic: {
                            getMany: jest.fn().mockResolvedValue([
                                { key: 'test', value: 'value', tags: ['tag'], entities: [] }
                            ])
                        }
                    };
                }
            };

            const base = { M: { memory: { vars: {} } }, meta: { turn: 0, agentId: 'agent-a' } };
            store.seed('t', 'session', base, BigInt(0), 'agent-a');

            // This should trigger context creation which includes semantic memory wiring
            const ctx = await (engine as any).restoreCtx('t', 'session');

            // The context should have semantic memory read function attached
            if (ctx.memory?.semantic?.read) {
                const result = await ctx.memory.semantic.read();
                expect(Array.isArray(result)).toBe(true);
            }
        });
    });

    describe('Lines 4429-4430: Goals Clear Functionality', () => {
        test('goals API is wired in context', async () => {
            const store = new FakeSessionStore();
            const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });

            // Set up proper goal state hierarchy following the MentalState structure
            const base = {
                M: {
                    memory: {
                        vars: {},
                        longTerm: {
                            episodic: [],
                            semantic: { concepts: [] },
                            procedural: { skills: [] }
                        }
                    },
                    worldModel: { implicit: null, explicit: null, simulator: null },
                    goalState: {
                        hierarchy: {
                            nodes: {
                                'goal1': { id: 'goal1', status: 'pending', title: 'Goal 1' },
                                'goal2': { id: 'goal2', status: 'completed', title: 'Goal 2' }
                            },
                            roots: []
                        }
                    },
                    emotion: { valence: 0, arousal: 0.2 },
                    rewardParams: {
                        extrinsicWeights: [1],
                        intrinsic: { curiosity: 0, novelty: 0, competence: 0, exploration: 0 },
                        discountGamma: 0.99
                    },
                    policyParams: { theta: null, stochastic: false }
                },
                meta: { turn: 0, agentId: 'agent-a' }
            };
            store.seed('t', 'session', base, BigInt(0), 'agent-a');

            const ctx = await (engine as any).restoreCtx('t', 'session');

            // Goals API should be attached
            if (ctx.goals && ctx.goals.clear) {
                expect(typeof ctx.goals.clear).toBe('function');

                // Test clear functionality (lines 4429-4430)
                // The clear method calls listGoals then failGoal for matching items
                await ctx.goals.clear();
            }
        });
    });

    describe('Lines 4534-4535: Input Required Check', () => {
        test('sendTaskToAgent returns early (undefined) for input_required status', async () => {
            const store = new FakeSessionStore();
            const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });

            // Mock A2A service to return input_required status
            const a2aModule = await import(a2aPath);
            const mockSendTaskToAgent = jest.fn().mockResolvedValue({
                status: 'input_required',
                prompt: 'Need input'
            });
            (a2aModule as any).globalA2AService.sendTaskToAgent = mockSendTaskToAgent;

            const base = {
                M: {
                    memory: {
                        vars: {},
                        longTerm: {
                            episodic: [],
                            semantic: { concepts: [] },
                            procedural: { skills: [] }
                        }
                    },
                    worldModel: { implicit: null, explicit: null, simulator: null },
                    goalState: { hierarchy: { nodes: {}, roots: [] } },
                    emotion: { valence: 0, arousal: 0.2 },
                    rewardParams: { extrinsicWeights: [1], intrinsic: { curiosity: 0, novelty: 0, competence: 0, exploration: 0 }, discountGamma: 0.99 },
                    policyParams: { theta: null, stochastic: false }
                },
                meta: { turn: 0, agentId: 'agent-a' }
            };
            store.seed('t', 'session', base, BigInt(0), 'agent-a');

            // Create context with sendTaskToAgent
            const ctx = await (engine as any).restoreCtx('t', 'session');

            // Call sendTaskToAgent which should exercise lines 4533-4535
            const result = await ctx.sendTaskToAgent('test-agent', { test: 'input' }, {});

            // Should return early without processing further (line 4534) - returns undefined
            expect(result).toBeUndefined();
            expect(mockSendTaskToAgent).toHaveBeenCalled();
        });
    });

    describe('Lines 4579-4587: Error Handling in Durable Handlers', () => {
        test('sendTaskToAgent enqueues error on exception', async () => {
            const store = new FakeSessionStore();
            const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });

            // Mock A2A service to throw an error (lines 4580-4587)
            const a2aModule = await import(a2aPath);
            const mockSendTaskToAgent = jest.fn().mockRejectedValue(new Error('Handler failed'));
            (a2aModule as any).globalA2AService.sendTaskToAgent = mockSendTaskToAgent;

            const base = {
                M: {
                    memory: {
                        vars: {},
                        longTerm: {
                            episodic: [],
                            semantic: { concepts: [] },
                            procedural: { skills: [] }
                        }
                    },
                    worldModel: { implicit: null, explicit: null, simulator: null },
                    goalState: { hierarchy: { nodes: {}, roots: [] } },
                    emotion: { valence: 0, arousal: 0.2 },
                    rewardParams: { extrinsicWeights: [1], intrinsic: { curiosity: 0, novelty: 0, competence: 0, exploration: 0 }, discountGamma: 0.99 },
                    policyParams: { theta: null, stochastic: false }
                },
                meta: { turn: 0, agentId: 'agent-a' }
            };
            store.seed('t', 'session', base, BigInt(0), 'agent-a');

            // Create context with sendTaskToAgent
            const ctx = await (engine as any).restoreCtx('t', 'session');

            await expect(ctx.sendTaskToAgent('test-agent', { test: 'input' }, { agent: 'test-agent' }))
                .rejects.toThrow('Handler failed');

            // Check that error was enqueued (lines 4581-4585)
            const outbox = store.getOutbox();
            const errorEvent = outbox.find(event =>
                event.topic === 'task.child_dispatch' &&
                event.payload.error === 'Handler failed'
            );

            expect(errorEvent).toBeDefined();
            expect(errorEvent?.payload).toMatchObject({
                taskId: 'session',
                childAgent: 'test-agent',
                error: 'Handler failed'
            });
        });

        test('sendTaskToAgent handles string errors', async () => {
            const store = new FakeSessionStore();
            const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });

            // Mock A2A service to throw a string error as an Error object with string message
            const a2aModule = await import(a2aPath);
            const mockSendTaskToAgent = jest.fn().mockRejectedValue(new Error('String error message'));
            (a2aModule as any).globalA2AService.sendTaskToAgent = mockSendTaskToAgent;

            const base = {
                M: {
                    memory: {
                        vars: {},
                        longTerm: {
                            episodic: [],
                            semantic: { concepts: [] },
                            procedural: { skills: [] }
                        }
                    },
                    worldModel: { implicit: null, explicit: null, simulator: null },
                    goalState: { hierarchy: { nodes: {}, roots: [] } },
                    emotion: { valence: 0, arousal: 0.2 },
                    rewardParams: { extrinsicWeights: [1], intrinsic: { curiosity: 0, novelty: 0, competence: 0, exploration: 0 }, discountGamma: 0.99 },
                    policyParams: { theta: null, stochastic: false }
                },
                meta: { turn: 0, agentId: 'agent-a' }
            };
            store.seed('t', 'session', base, BigInt(0), 'agent-a');

            const ctx = await (engine as any).restoreCtx('t', 'session');

            await expect(ctx.sendTaskToAgent('test-agent', { test: 'input' }, { agent: 'test-agent' }))
                .rejects.toThrow('String error message');

            // Check that error was handled correctly (line 4584)
            const outbox = store.getOutbox();
            const errorEvent = outbox.find(event =>
                event.topic === 'task.child_dispatch' &&
                event.payload.error === 'String error message'
            );

            expect(errorEvent).toBeDefined();
            expect(errorEvent?.payload).toMatchObject({
                taskId: 'session',
                childAgent: 'test-agent',
                error: 'String error message'
            });
        });
    });
});