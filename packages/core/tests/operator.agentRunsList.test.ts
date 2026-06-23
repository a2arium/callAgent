import { describe, expect, it, jest } from '@jest/globals';
import { TaskEngine } from '../src/orchestration/taskEngine.js';

const now = new Date('2026-06-23T12:00:00.000Z');

describe('TaskEngine operator agent run list', () => {
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
});
