import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { TaskEngine } from '../src/orchestration/taskEngine.js';

const now = new Date('2026-06-23T12:00:00.000Z');

describe('TaskEngine operator agent run list', () => {
    const previousReadMode = process.env.CALLAGENT_OPERATOR_PROJECTION_READ;
    const previousWriteMode = process.env.CALLAGENT_OPERATOR_PROJECTION_WRITE;

    afterEach(() => {
        if (previousReadMode === undefined) {
            delete process.env.CALLAGENT_OPERATOR_PROJECTION_READ;
        } else {
            process.env.CALLAGENT_OPERATOR_PROJECTION_READ = previousReadMode;
        }
        if (previousWriteMode === undefined) {
            delete process.env.CALLAGENT_OPERATOR_PROJECTION_WRITE;
        } else {
            process.env.CALLAGENT_OPERATOR_PROJECTION_WRITE = previousWriteMode;
        }
    });

    it('hides child agent rows by default and counts children from driver run parent links', async () => {
        const rootRun = {
            id: 'run-root',
            provider: 'hatchet',
            providerRunId: 'provider-root',
            tenantId: 'default',
            taskId: 'root-task',
            rootTaskId: 'root-task',
            parentTaskId: null,
            agentId: 'root-agent',
            operation: 'agent.run',
            status: 'running',
            createdAt: now,
            updatedAt: now,
        };
        const childRun = {
            id: 'run-child',
            provider: 'hatchet',
            providerRunId: 'provider-child',
            tenantId: 'default',
            taskId: 'child-task',
            rootTaskId: 'root-task',
            parentTaskId: 'root-task',
            parentAgentId: 'root-agent',
            agentId: 'child-agent',
            operation: 'agent.run',
            status: 'completed',
            createdAt: now,
            updatedAt: now,
        };
        const runs = [rootRun, childRun];
        const prisma = {
            driverRun: {
                findMany: jest.fn(async (args: { where?: Record<string, unknown> }) => {
                    if (Array.isArray(args.where?.OR)) {
                        return runs;
                    }
                    return runs;
                }),
            },
            wMEvent: {
                findMany: jest.fn(async () => []),
            },
        };

        const engine = new TaskEngine({});
        (engine as unknown as { sessionManager: { store: { prisma?: typeof prisma } } }).sessionManager.store.prisma = prisma;

        const rootsOnly = await engine.listAgentRuns({ tenantId: 'default', scope: 'roots', limit: 20 });
        expect(rootsOnly.items).toHaveLength(1);
        expect(rootsOnly.items[0]).toEqual(expect.objectContaining({
            taskId: 'root-task',
            rootTaskId: 'root-task',
            agentId: 'root-agent',
            children: 1,
        }));

        const allRuns = await engine.listAgentRuns({ tenantId: 'default', scope: 'all', limit: 20 });
        expect(allRuns.items.map((item) => item.taskId)).toEqual(['root-task', 'child-task']);
    });

    it('hides child rows linked only by working-memory child events', async () => {
        const rootRun = {
            id: 'run-root',
            provider: 'hatchet',
            providerRunId: 'provider-root',
            tenantId: 'default',
            taskId: 'root-task',
            rootTaskId: 'root-task',
            parentTaskId: null,
            agentId: 'root-agent',
            operation: 'agent.run',
            status: 'completed',
            createdAt: now,
            updatedAt: now,
        };
        const childRun = {
            id: 'run-child',
            provider: 'hatchet',
            providerRunId: 'provider-child',
            tenantId: 'default',
            taskId: 'a2a_root-task_child-agent_123',
            rootTaskId: 'a2a_root-task_child-agent_123',
            parentTaskId: null,
            agentId: 'child-agent',
            operation: 'agent.run',
            status: 'completed',
            createdAt: now,
            updatedAt: now,
        };
        const runs = [rootRun, childRun];
        const childEvents = [
            {
                eventId: 'event-1',
                sessionId: 'root-task',
                seq: 1,
                type: 'task.child_started',
                payload: {
                    childTaskId: 'a2a_root-task_child-agent_123',
                    agentId: 'child-agent',
                },
                createdAt: now,
            },
        ];
        const prisma = {
            driverRun: {
                findMany: jest.fn(async (args: { where?: Record<string, unknown> }) => {
                    if (Array.isArray(args.where?.OR)) {
                        return runs;
                    }
                    return runs;
                }),
            },
            wMEvent: {
                findMany: jest.fn(async (args: { where?: { sessionId?: { in?: string[] }; type?: { in?: string[] } } }) => {
                    const sessions = args.where?.sessionId?.in;
                    return sessions ? childEvents.filter((event) => sessions.includes(event.sessionId)) : childEvents;
                }),
            },
        };

        const engine = new TaskEngine({});
        (engine as unknown as { sessionManager: { store: { prisma?: typeof prisma } } }).sessionManager.store.prisma = prisma;

        const rootsOnly = await engine.listAgentRuns({ tenantId: 'default', scope: 'roots', limit: 20 });
        expect(rootsOnly.items.map((item) => item.taskId)).toEqual(['root-task']);
        expect(rootsOnly.items[0]).toEqual(expect.objectContaining({ children: 1 }));

        const allRuns = await engine.listAgentRuns({ tenantId: 'default', scope: 'all', limit: 20 });
        expect(allRuns.items.map((item) => item.taskId)).toEqual(['root-task', 'a2a_root-task_child-agent_123']);
    });

    it('shows a resumed task as running when a newer turn segment is active after root AbortError', async () => {
        const failedRootRun = {
            id: 'run-root',
            provider: 'hatchet',
            providerRunId: 'provider-root',
            tenantId: 'default',
            taskId: 'root-task',
            rootTaskId: 'root-task',
            parentTaskId: null,
            agentId: 'root-agent',
            operation: 'agent.run',
            status: 'failed',
            boundaryKind: 'fail',
            error: { name: 'AbortError', message: 'Operation cancelled by AbortSignal' },
            createdAt: now,
            updatedAt: new Date('2026-06-23T12:00:10.000Z'),
        };
        const awaitingSegment = {
            id: 'turn-1',
            provider: 'hatchet',
            providerRunId: 'provider-turn-1',
            tenantId: 'default',
            taskId: 'root-task',
            rootTaskId: 'root-task',
            parentTaskId: null,
            agentId: 'root-agent',
            operation: 'turn.segment',
            status: 'completed',
            boundaryKind: 'await_child',
            turnSeq: 1,
            createdAt: new Date('2026-06-23T12:00:20.000Z'),
            updatedAt: new Date('2026-06-23T12:00:21.000Z'),
        };
        const runningSegment = {
            id: 'turn-2',
            provider: 'hatchet',
            providerRunId: 'provider-turn-2',
            tenantId: 'default',
            taskId: 'root-task',
            rootTaskId: 'root-task',
            parentTaskId: null,
            agentId: 'root-agent',
            operation: 'turn.segment',
            status: 'running',
            boundaryKind: null,
            turnSeq: 2,
            createdAt: new Date('2026-06-23T12:00:30.000Z'),
            updatedAt: new Date('2026-06-23T12:00:30.000Z'),
        };
        const runs = [failedRootRun, awaitingSegment, runningSegment];
        const prisma = {
            driverRun: {
                findMany: jest.fn(async (args: { where?: Record<string, unknown> }) => {
                    if (Array.isArray(args.where?.OR)) {
                        return runs;
                    }
                    return [failedRootRun];
                }),
            },
            wMEvent: {
                findMany: jest.fn(async () => [
                    {
                        eventId: 'event-1',
                        sessionId: 'root-task',
                        seq: 1,
                        type: 'task.started',
                        payload: { taskId: 'root-task' },
                        createdAt: now,
                    },
                ]),
            },
        };

        const engine = new TaskEngine({});
        (engine as unknown as { sessionManager: { store: { prisma?: typeof prisma } } }).sessionManager.store.prisma = prisma;

        const page = await engine.listAgentRuns({ tenantId: 'default', scope: 'roots', limit: 20 });
        expect(page.items[0]).toEqual(expect.objectContaining({
            taskId: 'root-task',
            status: 'running',
        }));
        expect(page.items[0]?.finishedAt).toBeUndefined();
    });

    it('can list runs from semantic projection records when semantic read mode is enabled', async () => {
        process.env.CALLAGENT_OPERATOR_PROJECTION_READ = 'semantic';
        const agentRunRows = [
            {
                id: 'semantic-root-row',
                tenantId: 'default',
                taskId: 'root-task',
                rootTaskId: 'root-task',
                agentId: 'root-agent',
                scope: 'root',
                status: 'completed',
                childCount: 0,
                turnCount: 0,
                llmCallCount: 0,
                memoryOpCount: 0,
                knownCostUsd: '0.125000',
                startedAt: now,
                terminalAt: new Date('2026-06-23T12:01:00.000Z'),
                durationMs: 60_000,
                terminalCode: null,
                terminalMessage: null,
                outputState: 'available',
                traceId: 'trace-1',
                providerRunId: 'provider-root',
                updatedAt: new Date('2026-06-23T12:01:00.000Z'),
            },
        ];
        const prisma = {
            driverRun: {
                findMany: jest.fn(async () => {
                    throw new Error('bridge path should not be used');
                }),
            },
            agentRun: {
                findMany: jest.fn(async () => agentRunRows),
            },
            agentRunEdge: {
                findMany: jest.fn(async () => [
                    { id: 'edge-1', parentTaskId: 'root-task', childTaskId: 'child-1' },
                    { id: 'edge-2', parentTaskId: 'root-task', childTaskId: 'child-2' },
                ]),
            },
            turnRun: {
                findMany: jest.fn(async () => [
                    { id: 'turn-1', taskId: 'root-task', llmCallCount: 1, memoryOpCount: 2 },
                    { id: 'turn-2', taskId: 'root-task', llmCallCount: 0, memoryOpCount: 1 },
                    { id: 'turn-3', taskId: 'root-task', llmCallCount: 0, memoryOpCount: 1 },
                ]),
            },
            runEffect: {},
        };

        const engine = new TaskEngine({});
        (engine as unknown as { sessionManager: { store: { prisma?: typeof prisma } } }).sessionManager.store.prisma = prisma;

        const page = await engine.listAgentRuns({ tenantId: 'default', scope: 'roots', limit: 20 });
        expect(page.projection).toEqual({ source: 'semantic', partial: false });
        expect(page.items).toEqual([
            expect.objectContaining({
                taskId: 'root-task',
                rootTaskId: 'root-task',
                agentId: 'root-agent',
                status: 'completed',
                children: 2,
                turns: 3,
                llmCalls: 1,
                memoryOps: 4,
                costUsd: 0.125,
            }),
        ]);
    });

    it('can build a graph from semantic projection records when semantic read mode is enabled', async () => {
        process.env.CALLAGENT_OPERATOR_PROJECTION_READ = 'semantic';
        const runRows = [
            {
                id: 'root-row',
                tenantId: 'default',
                taskId: 'root-task',
                rootTaskId: 'root-task',
                agentId: 'root-agent',
                scope: 'root',
                status: 'running',
                childCount: 1,
                turnCount: 1,
                llmCallCount: 0,
                memoryOpCount: 0,
                knownCostUsd: null,
                startedAt: now,
                terminalAt: null,
                durationMs: null,
                terminalCode: null,
                terminalMessage: null,
                outputState: 'not_captured',
                traceId: null,
                providerRunId: null,
                updatedAt: now,
            },
            {
                id: 'child-row',
                tenantId: 'default',
                taskId: 'child-task',
                rootTaskId: 'root-task',
                agentId: 'child-agent',
                scope: 'child',
                parentTaskId: 'root-task',
                status: 'completed',
                childCount: 0,
                turnCount: 0,
                llmCallCount: 0,
                memoryOpCount: 0,
                knownCostUsd: null,
                startedAt: now,
                terminalAt: new Date('2026-06-23T12:01:00.000Z'),
                durationMs: 60_000,
                terminalCode: null,
                terminalMessage: null,
                outputState: 'available',
                traceId: null,
                providerRunId: null,
                updatedAt: new Date('2026-06-23T12:01:00.000Z'),
            },
        ];
        const edgeRows = [
            {
                id: 'edge-row',
                tenantId: 'default',
                rootTaskId: 'root-task',
                parentTaskId: 'root-task',
                childTaskId: 'child-task',
                token: 'child-token',
                edgeKind: 'delegates_to',
                status: 'completed',
                createdAt: now,
                resolvedAt: new Date('2026-06-23T12:01:00.000Z'),
            },
        ];
        const turnRows = [
            {
                id: 'turn-row',
                tenantId: 'default',
                taskId: 'root-task',
                rootTaskId: 'root-task',
                agentId: 'root-agent',
                turnSeq: 1,
                status: 'completed',
                startedAt: now,
                completedAt: new Date('2026-06-23T12:00:05.000Z'),
                durationMs: 5_000,
                boundaryKind: 'await_child',
                outputProduced: false,
                llmCallCount: 0,
                memoryOpCount: 0,
            },
        ];
        const prisma = {
            driverRun: {
                findMany: jest.fn(async () => {
                    throw new Error('bridge path should not be used');
                }),
            },
            agentRun: {
                findMany: jest.fn(async () => runRows),
            },
            agentRunEdge: {
                findMany: jest.fn(async () => edgeRows),
            },
            turnRun: {
                findMany: jest.fn(async () => turnRows),
            },
            runEffect: {
                findMany: jest.fn(async () => []),
            },
        };

        const engine = new TaskEngine({});
        (engine as unknown as { sessionManager: { store: { prisma?: typeof prisma } } }).sessionManager.store.prisma = prisma;

        const graph = await engine.buildAgentRunGraph({ tenantId: 'default', taskId: 'root-task' });
        expect(graph.projection).toEqual({ source: 'semantic', partial: false });
        expect(graph.nodes.map((node) => node.taskId)).toEqual(['root-task', 'child-task']);
        expect(graph.edges).toEqual([
            expect.objectContaining({
                parentTaskId: 'root-task',
                childTaskId: 'child-task',
                status: 'completed',
            }),
        ]);
        expect(graph.turns).toEqual([
            expect.objectContaining({
                taskId: 'root-task',
                turnSeq: 1,
                boundaryKind: 'await_child',
            }),
        ]);
    });

    it('projects durable task events when events are appended through the session manager', async () => {
        process.env.CALLAGENT_OPERATOR_PROJECTION_WRITE = 'on';
        const agentRunUpsert = jest.fn(async () => ({}));
        const prisma = {
            agentRun: {
                findMany: jest.fn(async () => []),
                upsert: agentRunUpsert,
            },
            agentRunEdge: {
                upsert: jest.fn(async () => ({})),
            },
            turnRun: {
                upsert: jest.fn(async () => ({})),
            },
            runEffect: {
                upsert: jest.fn(async () => ({})),
            },
        };
        const store = {
            prisma,
            appendEvent: jest.fn(async () => ({ eventId: 'event-1', seq: 1 })),
        };
        const sessionManager = new SessionManager(store as never);

        await sessionManager.appendEvent('default', 'root-task', 'task.started', {
            taskId: 'root-task',
            agentId: 'root-agent',
            traceparent: 'trace-1',
        });

        expect(agentRunUpsert).toHaveBeenCalledWith(expect.objectContaining({
            where: { tenantId_taskId: { tenantId: 'default', taskId: 'root-task' } },
            create: expect.objectContaining({
                tenantId: 'default',
                taskId: 'root-task',
                rootTaskId: 'root-task',
                agentId: 'root-agent',
                status: 'running',
                scope: 'root',
            }),
        }));
    });

    it('keeps child scope when a child task emits its own task.started event', async () => {
        process.env.CALLAGENT_OPERATOR_PROJECTION_WRITE = 'on';
        const agentRunUpsert = jest.fn(async () => ({}));
        const prisma = {
            agentRun: {
                findMany: jest.fn(async () => [{ taskId: 'child-task', rootTaskId: 'root-task' }]),
                upsert: agentRunUpsert,
            },
            agentRunEdge: {
                upsert: jest.fn(async () => ({})),
            },
            turnRun: {
                upsert: jest.fn(async () => ({})),
            },
            runEffect: {
                upsert: jest.fn(async () => ({})),
            },
        };
        const store = {
            prisma,
            appendEvent: jest.fn(async () => ({ eventId: 'event-1', seq: 1 })),
        };
        const sessionManager = new SessionManager(store as never);

        await sessionManager.appendEvent('default', 'child-task', 'task.started', {
            taskId: 'child-task',
            agentId: 'child-agent',
        });

        expect(agentRunUpsert).toHaveBeenCalledWith(expect.objectContaining({
            where: { tenantId_taskId: { tenantId: 'default', taskId: 'child-task' } },
            update: expect.objectContaining({
                rootTaskId: 'root-task',
                scope: 'child',
                agentId: 'child-agent',
            }),
        }));
    });

    it('falls back to bridge graph when semantic graph rows are incomplete', async () => {
        process.env.CALLAGENT_OPERATOR_PROJECTION_READ = 'semantic';
        process.env.CALLAGENT_OPERATOR_PROJECTION_WRITE = 'off';
        const semanticRunRows = [
            {
                id: 'root-row',
                tenantId: 'default',
                taskId: 'root-task',
                rootTaskId: 'root-task',
                agentId: 'root-agent',
                scope: 'root',
                status: 'running',
                childCount: 1,
                turnCount: 0,
                llmCallCount: 0,
                memoryOpCount: 0,
                knownCostUsd: null,
                startedAt: now,
                terminalAt: null,
                durationMs: null,
                terminalCode: null,
                terminalMessage: null,
                outputState: 'not_captured',
                traceId: null,
                providerRunId: null,
                updatedAt: now,
            },
        ];
        const driverRows = [
            {
                id: 'run-root',
                provider: 'hatchet',
                tenantId: 'default',
                taskId: 'root-task',
                rootTaskId: 'root-task',
                parentTaskId: null,
                agentId: 'root-agent',
                operation: 'agent.run',
                status: 'running',
                createdAt: now,
                updatedAt: now,
            },
        ];
        const prisma = {
            driverRun: {
                findMany: jest.fn(async () => driverRows),
            },
            agentRun: {
                findMany: jest.fn(async () => semanticRunRows),
            },
            agentRunEdge: {
                findMany: jest.fn(async () => []),
            },
            turnRun: {
                findMany: jest.fn(async () => []),
            },
            runEffect: {
                findMany: jest.fn(async () => []),
            },
        };
        const engine = new TaskEngine({});
        (engine as unknown as { sessionManager: { store: { prisma?: typeof prisma }; listEventsSince: unknown } }).sessionManager.store.prisma = prisma;

        const graph = await engine.buildAgentRunGraph({ tenantId: 'default', taskId: 'root-task' });

        expect(graph.projection).toEqual({ source: 'bridge', partial: false });
        expect(graph.root.taskId).toBe('root-task');
    });

    it('caps large graphs by preserving the root and reporting collapsed branches', async () => {
        process.env.CALLAGENT_OPERATOR_PROJECTION_WRITE = 'off';
        const engine = new TaskEngine({});
        const sessionManager = (engine as unknown as {
            sessionManager: SessionManager;
        }).sessionManager;
        await sessionManager.appendEvent('default', 'root-task', 'task.started', {
            taskId: 'root-task',
            agentId: 'root-agent',
        });
        for (let index = 0; index < 260; index += 1) {
            await sessionManager.appendEvent('default', 'root-task', 'task.child_started', {
                token: `token-${index}`,
                agentId: 'child-agent',
                childTaskId: `child-${index}`,
            });
        }

        const graph = await engine.buildAgentRunGraph({ tenantId: 'default', taskId: 'root-task' });

        expect(graph.root.taskId).toBe('root-task');
        expect(graph.nodes).toHaveLength(250);
        expect(graph.caps).toEqual(expect.objectContaining({
            nodeLimit: 250,
            truncated: true,
        }));
        expect(graph.collapsedBranches).toEqual([
            expect.objectContaining({
                parentTaskId: 'root-task',
                hiddenChildCount: 11,
                reason: 'node_limit',
            }),
        ]);
    });
});
