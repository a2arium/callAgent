import { describe, expect, it } from '@jest/globals';
import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { buildAgentRunGraph, type DriverRunView } from '../src/operator/runGraph.js';

describe('buildAgentRunGraph', () => {
    it('projects a user-facing agent graph from driver runs and working-memory events', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        await sessionManager.saveSnapshot({
            tenantId: 'tenant-1',
            sessionId: 'task-1',
            agentId: 'root-agent',
            expectedWmVersion: BigInt(0),
            snapshot: { meta: { agentId: 'root-agent' } },
        });
        await sessionManager.appendEvent('tenant-1', 'task-1', 'task.started', {
            taskId: 'task-1',
            text: 'hello',
        });
        await sessionManager.appendEvent('tenant-1', 'task-1', 'task.child_started', {
            token: 'child-1',
            childTaskId: 'task-2',
            childAgentId: 'researcher-agent',
        });
        await sessionManager.appendEvent('tenant-1', 'task-1', 'task.child_completed', {
            token: 'child-1',
            childTaskId: 'task-2',
            childAgentId: 'researcher-agent',
            resultPreview: { ok: true },
        });
        await sessionManager.appendEvent('tenant-1', 'task-1', 'turn.completed', {
            taskId: 'task-1',
            agentId: 'root-agent',
            turnSeq: 7,
            turnId: 'turn-trace-turn-id',
            stageBefore: 'thinking',
            stageAfter: 'done',
            intent: { kind: 'answer', summary: 'respond' },
            usage: { llmCalls: 1, totalCost: 0.01 },
            llmCalls: [{ model: 'gpt-test', inputTokens: 10, outputTokens: 20, cost: 0.01 }],
            traceId: 'trace-1',
            spanId: 'span-1',
            level: 'summary',
        });
        await sessionManager.appendEvent('tenant-1', 'task-1', 'memory.write', {
            taskId: 'task-1',
            agentId: 'root-agent',
            turnSeq: 7,
            op: 'write',
            keys: ['customer:123'],
            keyCount: 1,
            backend: 'semantic',
            traceId: 'trace-1',
            spanId: 'span-1',
        });
        await sessionManager.appendEvent('tenant-1', 'task-1', 'task.completed', {
            result: { text: 'done' },
        });
        const driverRuns: DriverRunView[] = [
            {
                provider: 'hatchet',
                providerRunId: 'run-root',
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'root-agent',
                traceId: 'trace-1',
                operation: 'agent.run',
                status: 'completed',
            },
            {
                provider: 'hatchet',
                providerRunId: 'run-turn',
                providerTaskRunId: 'turn-1',
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'root-agent',
                traceId: 'trace-1',
                spanId: 'span-1',
                rootTaskId: 'task-1',
                turnSeq: 7,
                boundaryKind: 'complete',
                turnTraceId: 'turn-trace-1',
                operation: 'turn.segment',
                status: 'completed',
            },
            {
                provider: 'hatchet',
                providerRunId: 'run-effect',
                tenantId: 'tenant-1',
                taskId: 'task-1',
                agentId: 'root-agent',
                operation: 'effect.outbox.dispatch',
                status: 'completed',
            },
        ];

        const graph = await buildAgentRunGraph({
            tenantId: 'tenant-1',
            taskId: 'task-1',
            sessionManager,
            driverRuns,
        });

        expect(graph.root).toEqual(expect.objectContaining({
            rootTaskId: 'task-1',
            taskId: 'task-1',
            agentId: 'root-agent',
            status: 'completed',
            traceId: 'trace-1',
        }));
        expect(graph.edges).toEqual([
            expect.objectContaining({
                rootTaskId: 'task-1',
                parentTaskId: 'task-1',
                childTaskId: 'task-2',
                childAgentId: 'researcher-agent',
                token: 'child-1',
                edgeToken: 'child-1',
                edgeKind: 'delegates_to',
                status: 'completed',
            }),
        ]);
        expect(graph.turns).toEqual([
            expect.objectContaining({
                id: 'turn-1',
                rootTaskId: 'task-1',
                operation: 'turn.segment',
                turnSeq: 7,
                boundaryKind: 'complete',
                turnTraceRef: { traceId: 'trace-1', spanId: 'span-1', turnTraceId: 'turn-trace-1' },
                cognition: expect.objectContaining({
                    turnId: 'turn-trace-turn-id',
                    stageBefore: 'thinking',
                    stageAfter: 'done',
                    usage: { llmCalls: 1, totalCost: 0.01 },
                }),
                llmCalls: [expect.objectContaining({ model: 'gpt-test' })],
                memoryOps: [expect.objectContaining({ op: 'write', keys: ['customer:123'] })],
            }),
        ]);
        expect(graph.memoryOps).toEqual([
            expect.objectContaining({
                op: 'write',
                keys: ['customer:123'],
                turnSeq: 7,
                backend: 'semantic',
            }),
        ]);
        expect(graph.effects).toEqual([
            expect.objectContaining({
                rootTaskId: 'task-1',
                operation: 'effect.outbox.dispatch',
                hiddenByDefault: true,
            }),
        ]);
        expect(graph.events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                source: 'wm_event',
                type: 'task.child_completed',
                visibility: 'operator',
                group: expect.objectContaining({
                    taskId: 'task-1',
                    agentId: 'researcher-agent',
                    token: 'child-1',
                }),
            }),
        ]));
    });

    it('marks the root completed from a terminal segment when the parent driver row is stale', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        await sessionManager.saveSnapshot({
            tenantId: 'tenant-1',
            sessionId: 'task-stale-parent',
            agentId: 'root-agent',
            expectedWmVersion: BigInt(0),
            snapshot: { meta: { agentId: 'root-agent' } },
        });
        await sessionManager.appendEvent('tenant-1', 'task-stale-parent', 'task.started', {
            taskId: 'task-stale-parent',
        });

        const graph = await buildAgentRunGraph({
            tenantId: 'tenant-1',
            taskId: 'task-stale-parent',
            sessionManager,
            driverRuns: [
                {
                    providerRunId: 'parent-run',
                    tenantId: 'tenant-1',
                    taskId: 'task-stale-parent',
                    agentId: 'root-agent',
                    rootTaskId: 'task-stale-parent',
                    operation: 'agent.run',
                    status: 'queued',
                },
                {
                    providerRunId: 'turn-run',
                    tenantId: 'tenant-1',
                    taskId: 'task-stale-parent',
                    agentId: 'root-agent',
                    rootTaskId: 'task-stale-parent',
                    operation: 'turn.segment',
                    status: 'completed',
                    updatedAt: '2026-06-19T07:05:07.319Z',
                    turnSeq: 1,
                    boundaryKind: 'complete',
                },
            ],
        });

        expect(graph.root.status).toBe('completed');
        expect(graph.root.finishedAt).toBe('2026-06-19T07:05:07.319Z');
    });

    it('treats complete transitions with ok false as failed semantic outcomes', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        await sessionManager.saveSnapshot({
            tenantId: 'tenant-1',
            sessionId: 'task-semantic-fail',
            agentId: 'root-agent',
            expectedWmVersion: BigInt(0),
            snapshot: { meta: { agentId: 'root-agent' } },
        });
        await sessionManager.appendEvent('tenant-1', 'task-semantic-fail', 'task.started', {
            taskId: 'task-semantic-fail',
        });
        await sessionManager.appendEvent('tenant-1', 'task-semantic-fail', 'turn.completed', {
            taskId: 'task-semantic-fail',
            agentId: 'root-agent',
            turnSeq: 1,
            transition: {
                kind: 'complete',
                result: {
                    ok: false,
                    error: {
                        code: 'NO_URL',
                        message: 'No URL provided',
                    },
                },
            },
        });

        const graph = await buildAgentRunGraph({
            tenantId: 'tenant-1',
            taskId: 'task-semantic-fail',
            sessionManager,
            driverRuns: [
                {
                    providerRunId: 'parent-run',
                    tenantId: 'tenant-1',
                    taskId: 'task-semantic-fail',
                    agentId: 'root-agent',
                    rootTaskId: 'task-semantic-fail',
                    operation: 'agent.run',
                    status: 'queued',
                },
                {
                    providerRunId: 'turn-run',
                    tenantId: 'tenant-1',
                    taskId: 'task-semantic-fail',
                    agentId: 'root-agent',
                    rootTaskId: 'task-semantic-fail',
                    operation: 'turn.segment',
                    status: 'completed',
                    turnSeq: 1,
                    boundaryKind: 'complete',
                },
            ],
        });

        expect(graph.root.status).toBe('failed');
        expect(graph.turns[0]?.status).toBe('failed');
    });
});
