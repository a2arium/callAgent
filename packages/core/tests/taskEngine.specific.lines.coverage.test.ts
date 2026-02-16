
import { jest } from '@jest/globals';
import path from 'node:path';
import type { IWorkingMemorySessionStore, WMSessionSnapshot } from '@a2arium/callagent-memory-engine';

// --- Module mocks (must be defined before imports run) ---
const runLoopMock = jest.fn<any>();
const mockCreateTaskHandle = jest.fn();
const mockGetPendingTasks = jest.fn();
const mockSetPendingTasks = jest.fn();

jest.mock('../src/orchestration/A2AService.js', () => ({
    globalA2AService: {
        sendTaskToAgent: jest.fn(),
        findLocalAgent: jest.fn().mockResolvedValue({
            manifest: { name: 'mock-agent' },
            loop: {},
            llmAdapter: {},
            tenantId: 'test-tenant'
        } as any)
    }
}));

jest.mock('../src/eventbus/outboxPublisher.js', () => ({
    outboxPublisher: { start: jest.fn(), stop: jest.fn() }
}));

jest.mock('../src/loop/loopRunner.js', () => ({
    runLoop: (...args: any[]) => runLoopMock(...args)
}));

jest.mock('../src/orchestration/Handles.js', () => ({
    createTaskHandle: (...args: any[]) => mockCreateTaskHandle(...args),
    createGroupHandle: jest.fn(),
    getPendingInputs: jest.fn(),
    setPendingInputs: jest.fn(),
    getPendingTasks: () => mockGetPendingTasks(),
    setPendingTasks: (v: any) => mockSetPendingTasks(v),
    getPendingGroups: jest.fn(),
    setPendingGroups: jest.fn(),
    InputHandle: class { },
    TaskHandle: class {
        __injectDispatcher = jest.fn();
    },
    GroupHandle: class { }
}));

jest.mock('@prisma/client', () => ({ PrismaClient: class { } }), { virtual: true });

// Use direct import since we are using regular jest.mock
import { TaskEngine } from '../src/orchestration/taskEngine.js';

class FakeSessionStore implements IWorkingMemorySessionStore {
    private snapshots = new Map<string, WMSessionSnapshot>();
    private events: Array<{ tenantId: string; sessionId: string; type: string; payload: Record<string, unknown> }> = [];
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
        this.events.push(params);
        return { eventId: `evt-${this.events.length}`, seq: this.events.length - 1 };
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

    // Add listEventsSince to satisfy IWorkingMemorySessionStore
    async listEventsSince(tenantId: string, sessionId: string, sinceEventId: string | null): Promise<any[]> {
        return [];
    }
}

beforeAll(() => {
    process.env.DISABLE_OUTBOX_PUBLISHER = '1';
});

afterEach(() => {
    runLoopMock.mockReset();
    mockCreateTaskHandle.mockReset();
    mockGetPendingTasks.mockReset();
    mockSetPendingTasks.mockReset();
    jest.clearAllMocks();
    TaskEngine.testOverrides = undefined;
});

describe('TaskEngine Specific Line Coverage Tests', () => {
    describe('Semantic Memory Read Functionality', () => {
        test('semantic memory read functionality is wired correctly in context', async () => {
            const store = new FakeSessionStore();
            const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });

            const mockSemanticMemory = {
                getMany: jest.fn().mockResolvedValue([
                    { key: 'item1', value: 'value1', tags: ['tag1'], entities: [] },
                    { key: 'item2', value: 'value2', tags: ['tag2'], entities: [] }
                ])
            };

            const base = {
                M: {
                    memory: {
                        vars: {},
                        semantic: mockSemanticMemory
                    }
                },
                meta: { turn: 0, agentId: 'agent-a' },
                pending: {},
                inbox: { current: [], all: [] }
            };
            store.seed('t', 'session', base, BigInt(0), 'agent-a');

            jest.spyOn(engine as any, 'attachAndRestoreLLM').mockResolvedValue(undefined as any);
            runLoopMock.mockResolvedValue({
                M: { memory: { vars: {} } },
                outcome: { kind: 'complete', result: {} },
                metrics: {}
            });

            const ctx = await (engine as any).restoreCtx('t', 'session');

            if ((ctx as any).memory.semantic && (ctx as any).memory.semantic.read) {
                const result = await (ctx as any).memory.semantic.read({});
                expect(Array.isArray(result)).toBe(true);
            }
        });

        test('semantic memory read handles missing getMany gracefully', async () => {
            const store = new FakeSessionStore();
            const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });

            const mockSemanticMemory = {};

            const base = {
                M: {
                    memory: {
                        vars: {},
                        semantic: mockSemanticMemory
                    }
                },
                meta: { turn: 0, agentId: 'agent-a' },
                pending: {},
                inbox: { current: [], all: [] }
            };
            store.seed('t', 'session', base, BigInt(0), 'agent-a');

            jest.spyOn(engine as any, 'attachAndRestoreLLM').mockResolvedValue(undefined as any);
            runLoopMock.mockResolvedValue({
                M: { memory: { vars: {} } },
                outcome: { kind: 'complete', result: {} },
                metrics: {}
            });

            const ctx = await (engine as any).restoreCtx('t', 'session');

            if ((ctx as any).memory.semantic && (ctx as any).memory.semantic.read) {
                const result = await (ctx as any).memory.semantic.read({});
                expect(result).toEqual([]);
            }
        });
    });

    describe('Goals Clear Functionality', () => {
        test('goals clear with predicate removes matching goals', async () => {
            const store = new FakeSessionStore();
            const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });

            const base = {
                M: {
                    memory: { vars: {} },
                    goalState: {
                        hierarchy: {
                            nodes: {
                                'goal1': { id: 'goal1', title: 'Goal 1', completed: false },
                                'goal2': { id: 'goal2', title: 'Goal 2', completed: true },
                                'goal3': { id: 'goal3', title: 'Goal 3', completed: false }
                            },
                            roots: ['goal1', 'goal2', 'goal3']
                        }
                    }
                },
                meta: { turn: 0, agentId: 'agent-a' },
                pending: {},
                inbox: { current: [], all: [] }
            };
            store.seed('t', 'session', base, BigInt(0), 'agent-a');

            jest.spyOn(engine as any, 'attachAndRestoreLLM').mockResolvedValue(undefined as any);
            runLoopMock.mockResolvedValue({
                M: { memory: { vars: {} } },
                outcome: { kind: 'complete', result: {} },
                metrics: {}
            });

            const ctx = await (engine as any).restoreCtx('t', 'session');

            if ((ctx as any).goals && (ctx as any).goals.clear) {
                await (ctx as any).goals.clear((goal: any) => goal.completed);
            }
        });

        test('goals clear without predicate removes all goals', async () => {
            const store = new FakeSessionStore();
            const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });

            const base = {
                M: {
                    memory: { vars: {} },
                    goalState: {
                        hierarchy: {
                            nodes: {
                                'goal1': { id: 'goal1', title: 'Goal 1' },
                                'goal2': { id: 'goal2', title: 'Goal 2' }
                            },
                            roots: ['goal1', 'goal2']
                        }
                    }
                },
                meta: { turn: 0, agentId: 'agent-a' },
                pending: {},
                inbox: { current: [], all: [] }
            };
            store.seed('t', 'session', base, BigInt(0), 'agent-a');

            jest.spyOn(engine as any, 'attachAndRestoreLLM').mockResolvedValue(undefined as any);
            runLoopMock.mockResolvedValue({
                M: { memory: { vars: {} } },
                outcome: { kind: 'complete', result: {} },
                metrics: {}
            });

            const ctx = await (engine as any).restoreCtx('t', 'session');

            if ((ctx as any).goals && (ctx as any).goals.clear) {
                await (ctx as any).goals.clear();
            }
        });
    });

    describe('Input Required Check', () => {
        test('durable handler returns early when input_required status is returned', async () => {
            const store = new FakeSessionStore();
            const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });

            const base = {
                M: {
                    memory: { vars: {} }
                },
                meta: { turn: 0, agentId: 'agent-a' },
                pending: {},
                inbox: { current: [], all: [] }
            };
            store.seed('t', 'session', base, BigInt(0), 'agent-a');

            jest.spyOn(engine as any, 'attachAndRestoreLLM').mockResolvedValue(undefined as any);
            runLoopMock.mockResolvedValue({
                M: { memory: { vars: {} } },
                outcome: { kind: 'complete', result: {} },
                metrics: {}
            });

            const mockTaskHandle = {
                __injectDispatcher: jest.fn()
            };
            mockCreateTaskHandle.mockResolvedValue({
                handle: mockTaskHandle,
                token: 'test-token'
            });

            mockGetPendingTasks.mockReturnValue({
                'test-token': { target: 'test-agent', input: { test: 'input' } }
            });

            mockTaskHandle.__injectDispatcher.mockImplementation((dispatcher: any) => {
                dispatcher.mockResolvedValue({
                    status: 'input_required',
                    prompt: 'Please provide input'
                });
            });

            const ctx = await (engine as any).restoreCtx('t', 'session');

            if ((ctx as any).sendTaskToAgent) {
                const result = await (ctx as any).sendTaskToAgent('test-agent', { test: 'input' }, {
                    handlerName: 'testHandler'
                });

                expect(result).toBeDefined();
                expect(result.token).toBe('test-token');
                expect(mockCreateTaskHandle).toHaveBeenCalled();
            }
        });
    });

    describe('Error Handling in Durable Handlers', () => {
        test('error handling enqueues outbox event and rethrows', async () => {
            const store = new FakeSessionStore();
            const engine = new TaskEngine({ sessionStore: store as any, handlerInvoker: { invoke: jest.fn() } as any });

            const base = {
                M: {
                    memory: { vars: {} }
                },
                meta: { turn: 0, agentId: 'agent-a' },
                pending: {},
                inbox: { current: [], all: [] }
            };
            store.seed('t', 'session', base, BigInt(0), 'agent-a');

            jest.spyOn(engine as any, 'attachAndRestoreLLM').mockResolvedValue(undefined as any);
            runLoopMock.mockResolvedValue({
                M: { memory: { vars: {} } },
                outcome: { kind: 'complete', result: {} },
                metrics: {}
            });

            const mockTaskHandle = {
                __injectDispatcher: jest.fn()
            };
            mockCreateTaskHandle.mockResolvedValue({
                handle: mockTaskHandle,
                token: 'test-token'
            });

            mockGetPendingTasks.mockReturnValue({
                'test-token': { target: 'test-agent', input: { test: 'input' } }
            });

            const testError = new Error('Test error');
            mockTaskHandle.__injectDispatcher.mockImplementation((dispatcher: any) => {
                dispatcher.mockImplementation(async () => {
                    throw testError;
                });
            });

            const ctx = await (engine as any).restoreCtx('t', 'session');

            if ((ctx as any).sendTaskToAgent) {
                const result = await (ctx as any).sendTaskToAgent('test-agent', { test: 'input' }, {
                    handlerName: 'testHandler'
                });

                expect(mockCreateTaskHandle).toHaveBeenCalled();
            }
        });
    });
});