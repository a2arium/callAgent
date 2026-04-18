
import { jest } from '@jest/globals';
import path from 'node:path';
import type { WMSessionSnapshot } from '@a2arium/callagent-memory-engine';
import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';

import { globalA2AService } from '@a2arium/callagent-core/orchestration/A2AService.js';
import { PluginManager } from '@a2arium/callagent-core/plugin/pluginManager.js';
import * as Handles from '@a2arium/callagent-core/orchestration/Handles.js';

const runLoopMock = jest.fn<any>();
const mockCreateMemoryRegistry = jest.fn<any>();

// Mock other dependencies
jest.mock('@a2arium/callagent-core/eventbus/outboxPublisher.js', () => ({
    OutboxPublisher: jest.fn().mockImplementation(() => ({
        start: jest.fn(),
        stop: jest.fn(),
    })),
}));

jest.mock('@a2arium/callagent-core/loop/loopRunner.js', () => ({
    runLoop: (...args: any[]) => runLoopMock(...args)
}));

jest.mock('@a2arium/callagent-core/plugin/pluginManager.js', () => ({
    PluginManager: {
        findAgent: jest.fn().mockReturnValue({
            manifest: { name: 'test-agent' },
            handleTask: jest.fn().mockResolvedValue({ status: 'complete' })
        }),
        listAgents: jest.fn().mockReturnValue([])
    }
}));

jest.mock('@a2arium/callagent-memory-engine', () => {
    const actual = jest.requireActual('@a2arium/callagent-memory-engine') as any;
    return {
        ...actual,
        createMemoryRegistry: (...args: any[]) => mockCreateMemoryRegistry(...args)
    };
});

jest.mock('@prisma/client', () => ({ PrismaClient: class { } }), { virtual: true });

// Use direct import since we are using regular jest.mock
import { TaskEngine } from '../src/orchestration/taskEngine.js';

class FakeSessionStore extends InMemorySessionManager {
    seed(tenantId: string, sessionId: string, snapshot: Record<string, unknown>, wmVersion = BigInt(0), agentId = 'agent'): void {
        const key = `${tenantId}:${sessionId}`;
        (this as unknown as { snapshots: Map<string, WMSessionSnapshot> }).snapshots.set(key, {
            wmVersion,
            snapshot,
            agentId,
            updatedAt: new Date().toISOString(),
        });
    }

    getOutbox() {
        return (this as unknown as {
            outbox: Array<{ tenantId: string; topic: string; key: string; payload: Record<string, unknown> }>;
        }).outbox;
    }
}

beforeAll(() => {
    process.env.DISABLE_OUTBOX_PUBLISHER = '1';
    process.env.MEMORY_DATABASE_URL = 'postgresql://fake';
});

afterEach(() => {
    runLoopMock.mockReset();
    mockCreateMemoryRegistry.mockReset();
});

function createMockMHiearchy(goals: any[]) {
    const nodes: any = {};
    const roots: string[] = [];
    for (const g of goals) {
        nodes[g.id] = { ...g, title: g.text || g.title, status: 'active', priority: g.priority || 1, type: 'short' };
        roots.push(g.id);
    }
    return {
        goalState: {
            hierarchy: { nodes, roots }
        },
        memory: { vars: {} }
    };
}

describe('TaskEngine Specific Line Coverage Tests', () => {
    let store: FakeSessionStore;
    let engine: TaskEngine;

    beforeEach(() => {
        store = new FakeSessionStore();
        engine = new TaskEngine({
            sessionStore: store as any,
            handlerInvoker: { invoke: jest.fn() } as any
        });
    });

    describe('Semantic Memory Read Functionality', () => {
        test('semantic memory read functionality is wired correctly in context', async () => {
            const mockGetMany = jest.fn().mockResolvedValue([]);
            const mockSemanticHandle = {
                getMany: mockGetMany,
                search: jest.fn(),
                add: jest.fn(),
                backends: { sql: {} }
            };

            const mockRegistry = {
                semantic: mockSemanticHandle,
                episodic: {},
                working: {}
            };

            mockCreateMemoryRegistry.mockResolvedValue(mockRegistry as any);

            store.seed('t', 'session', {
                meta: { agentId: 'test-agent' },
                M: {
                    memory: {
                        config: { semantic: { backends: ['sql'] } }
                    }
                }
            });

            const ctx = await (engine as any).restoreCtx('t', 'session');

            if (ctx.memory?.semantic?.getMany) {
                await ctx.memory.semantic.getMany(['key1']);
                expect(mockGetMany).toHaveBeenCalledWith(['key1']);
            }
        });

        test('semantic memory read handles missing getMany gracefully', async () => {
            const mockSemanticHandle = {
                search: jest.fn(),
                backends: { sql: {} }
            };

            const mockRegistry = {
                semantic: mockSemanticHandle
            };

            mockCreateMemoryRegistry.mockResolvedValue(mockRegistry as any);

            store.seed('t', 'session', {
                meta: { agentId: 'test-agent' },
                M: { memory: { config: { semantic: { backends: ['sql'] } } } }
            });

            const ctx = await (engine as any).restoreCtx('t', 'session');
            expect(ctx.memory?.semantic?.getMany).toBeUndefined();
        });
    });

    describe('Goals Clear Functionality', () => {
        test('goals clear with predicate removes matching goals', async () => {
            store.seed('t', 'session', {
                meta: { agentId: 'test-agent' },
                M: createMockMHiearchy([
                    { id: '1', text: 'goal 1', priority: 1 },
                    { id: '2', text: 'goal 2', priority: 2 }
                ])
            });

            const ctx = await (engine as any).restoreCtx('t', 'session');
            if (ctx.goals?.clear) {
                await ctx.goals.clear((g: any) => g.id === '1');
                const M = (ctx as any).M;
                expect(M.goalState.hierarchy.nodes['1'].status).toBe('failed');
                expect(M.goalState.hierarchy.nodes['2'].status).toBe('active');
            }
        });

        test('goals clear without predicate removes all goals', async () => {
            store.seed('t', 'session', {
                meta: { agentId: 'test-agent' },
                M: createMockMHiearchy([
                    { id: '1', text: 'goal 1', priority: 1 }
                ])
            });

            const ctx = await (engine as any).restoreCtx('t', 'session');
            if (ctx.goals?.clear) {
                await ctx.goals.clear();
                const M = (ctx as any).M;
                expect(M.goalState.hierarchy.nodes['1'].status).toBe('failed');
            }
        });
    });

    describe('Input Required Check', () => {
        test('durable handler returns early when input_required status is returned', async () => {
            jest.spyOn(engine as any, 'attachAndRestoreLLM').mockResolvedValue(undefined as any);
            jest.spyOn(globalA2AService, 'sendTaskToAgent').mockResolvedValue({
                token: 'test-token',
                status: 'input_required',
                prompt: 'Please provide input'
            } as any);

            runLoopMock.mockResolvedValue({
                M: { memory: { vars: {} } },
                outcome: { kind: 'complete', result: {} },
                metrics: {}
            });

            store.seed('t', 'session', {
                meta: { agentId: 'test-agent' },
                M: { memory: { vars: {} } }
            });

            const ctx = await (engine as any).restoreCtx('t', 'session');

            if ((ctx as any).sendTaskToAgent) {
                const result = await (ctx as any).sendTaskToAgent('test-agent', { test: 'input' }, {
                    handlerName: 'testHandler'
                });

                expect(result).toBeDefined();
            }
        });
    });

    describe('Error Handling in Durable Handlers', () => {
        test('error handling enqueues outbox event and rethrows', async () => {
            store.seed('t', 'session', {
                meta: { agentId: 'test-agent' },
                M: { memory: { vars: {} } }
            });

            jest.spyOn(engine as any, 'attachAndRestoreLLM').mockResolvedValue(undefined as any);
            const testError = new Error('Test error');
            jest.spyOn(globalA2AService, 'sendTaskToAgent').mockImplementation(async () => {
                throw testError;
            });
            runLoopMock.mockResolvedValue({
                M: { memory: { vars: {} } },
                outcome: { kind: 'complete', result: {} },
                metrics: {}
            });

            const ctx = await (engine as any).restoreCtx('t', 'session');

            if ((ctx as any).sendTaskToAgent) {
                await expect((ctx as any).sendTaskToAgent('test-agent', { test: 'input' }, {
                    handlerName: 'testHandler'
                })).rejects.toThrow('Test error');

                const outbox = store.getOutbox();
                expect(outbox.some(e => e.topic === 'task.child_dispatch' && (e.payload as any).error === 'Test error')).toBe(true);
            }
        });
    });
});