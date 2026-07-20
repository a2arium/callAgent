import { describe, expect, it } from '@jest/globals';
import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { buildAgentRunGraph, type AgentRunSourceEvent, type DriverRunView } from '../src/operator/runGraph.js';

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
            {
                provider: 'hatchet',
                providerRunId: 'run-child',
                tenantId: 'tenant-1',
                taskId: 'task-2',
                rootTaskId: 'task-1',
                parentTaskId: 'task-1',
                agentId: 'researcher-agent',
                operation: 'agent.run',
                status: 'completed',
                error: { name: 'AbortError', message: 'Operation cancelled by AbortSignal' },
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
        expect(graph.nodes.find((node) => node.taskId === 'task-2')).toEqual(expect.not.objectContaining({
            error: expect.anything(),
        }));
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

    it('preserves child task ownership for tool events in the operator graph', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        await sessionManager.saveSnapshot({
            tenantId: 'tenant-1',
            sessionId: 'root-task',
            agentId: 'root-agent',
            expectedWmVersion: BigInt(0),
            snapshot: { meta: { agentId: 'root-agent' } },
        });
        await sessionManager.appendEvent('tenant-1', 'root-task', 'task.started', {
            taskId: 'root-task',
            agentId: 'root-agent',
        });
        await sessionManager.appendEvent('tenant-1', 'root-task', 'task.child_started', {
            token: 'child-token',
            childTaskId: 'child-task',
            childAgentId: 'browser-agent',
        });
        await sessionManager.appendEvent('tenant-1', 'root-task', 'task.child_completed', {
            token: 'child-token',
            childTaskId: 'child-task',
            childAgentId: 'browser-agent',
            resultPreview: { ok: true },
        });
        await sessionManager.appendEvent('tenant-1', 'child-task', 'task.tool_requested', {
            token: 'tool-token',
            toolName: 'mcp:browser-use.run',
            argsPreview: { url: 'https://example.test/detail' },
        });
        await sessionManager.appendEvent('tenant-1', 'child-task', 'task.tool_completed', {
            token: 'tool-token',
            toolName: 'mcp:browser-use.run',
            resultPreview: { ok: true, extractedData: { phone: ['+1-408-555-1901'] } },
        });

        const rootEvents = await sessionManager.listEventsSince({
            tenantId: 'tenant-1',
            sessionId: 'root-task',
            sinceSeq: -1,
        });
        const childEvents = await sessionManager.listEventsSince({
            tenantId: 'tenant-1',
            sessionId: 'child-task',
            sinceSeq: -1,
        });

        const graph = await buildAgentRunGraph({
            tenantId: 'tenant-1',
            taskId: 'root-task',
            sessionManager,
            events: [
                ...rootEvents.map((event) => ({ ...event, sessionId: 'root-task' })),
                ...childEvents.map((event) => ({ ...event, sessionId: 'child-task' })),
            ],
            driverRuns: [
                {
                    provider: 'hatchet',
                    providerRunId: 'run-root',
                    tenantId: 'tenant-1',
                    taskId: 'root-task',
                    rootTaskId: 'root-task',
                    agentId: 'root-agent',
                    operation: 'agent.run',
                    status: 'running',
                },
                {
                    provider: 'hatchet',
                    providerRunId: 'run-child',
                    tenantId: 'tenant-1',
                    taskId: 'child-task',
                    rootTaskId: 'root-task',
                    parentTaskId: 'root-task',
                    agentId: 'browser-agent',
                    operation: 'agent.run',
                    status: 'completed',
                },
            ],
        });

        expect(graph.events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'task.tool_requested',
                taskId: 'child-task',
                visibility: 'operator',
                group: expect.objectContaining({
                    taskId: 'child-task',
                    agentId: 'browser-agent',
                    token: 'tool-token',
                }),
            }),
            expect.objectContaining({
                type: 'task.tool_completed',
                taskId: 'child-task',
                visibility: 'operator',
                group: expect.objectContaining({
                    taskId: 'child-task',
                    agentId: 'browser-agent',
                    token: 'tool-token',
                }),
            }),
        ]));
    });

    it('projects driver run errors onto failed turns and root nodes', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        await sessionManager.saveSnapshot({
            tenantId: 'tenant-1',
            sessionId: 'task-error',
            agentId: 'root-agent',
            expectedWmVersion: BigInt(0),
            snapshot: { meta: { agentId: 'root-agent' } },
        });
        const error = {
            name: 'Error',
            message: 'LIMIT_WM_SNAPSHOT_TOO_LARGE',
            stack: 'Error: LIMIT_WM_SNAPSHOT_TOO_LARGE',
        };

        const graph = await buildAgentRunGraph({
            tenantId: 'tenant-1',
            taskId: 'task-error',
            sessionManager,
            driverRuns: [
                {
                    provider: 'hatchet',
                    providerRunId: 'run-root',
                    tenantId: 'tenant-1',
                    taskId: 'task-error',
                    rootTaskId: 'task-error',
                    agentId: 'root-agent',
                    operation: 'agent.run',
                    status: 'failed',
                    boundaryKind: 'fail',
                    error,
                },
                {
                    provider: 'hatchet',
                    providerRunId: 'run-turn',
                    tenantId: 'tenant-1',
                    taskId: 'task-error',
                    rootTaskId: 'task-error',
                    agentId: 'root-agent',
                    operation: 'turn.segment',
                    status: 'failed',
                    boundaryKind: 'fail',
                    turnSeq: 2,
                    error,
                },
            ],
        });

        expect(graph.root).toEqual(expect.objectContaining({
            status: 'failed',
            error,
        }));
        expect(graph.turns[0]).toEqual(expect.objectContaining({
            status: 'failed',
            boundaryKind: 'fail',
            error,
        }));
        expect(graph.debug.driverRuns[1]?.error).toEqual(error);
    });

    it('projects observability incidents as visible failed effects', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        await sessionManager.saveSnapshot({
            tenantId: 'tenant-1',
            sessionId: 'task-incident',
            agentId: 'root-agent',
            expectedWmVersion: BigInt(0),
            snapshot: { meta: { agentId: 'root-agent' } },
        });
        await sessionManager.appendIncidentEvent({
            tenantId: 'tenant-1',
            sessionId: 'task-incident',
            taskId: 'task-incident',
            operation: 'observability.provider_enqueue_failed',
            message: 'Hatchet enqueue failed.',
            errorCode: 'Error',
            eventType: 'agent.run',
        });

        const graph = await buildAgentRunGraph({
            tenantId: 'tenant-1',
            taskId: 'task-incident',
            sessionManager,
            driverRuns: [],
        });

        expect(graph.effects).toEqual(expect.arrayContaining([
            expect.objectContaining({
                rootTaskId: 'task-incident',
                taskId: 'task-incident',
                operation: 'observability.provider_enqueue_failed',
                status: 'failed',
                hiddenByDefault: false,
                error: expect.objectContaining({
                    code: 'Error',
                    message: 'Hatchet enqueue failed.',
                    eventType: 'agent.run',
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

    it('marks the root running when a resumed turn is active after a stale root AbortError', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        await sessionManager.saveSnapshot({
            tenantId: 'tenant-1',
            sessionId: 'task-resumed',
            agentId: 'root-agent',
            expectedWmVersion: BigInt(0),
            snapshot: { meta: { agentId: 'root-agent' } },
        });
        await sessionManager.appendEvent('tenant-1', 'task-resumed', 'task.started', {
            taskId: 'task-resumed',
        });

        const graph = await buildAgentRunGraph({
            tenantId: 'tenant-1',
            taskId: 'task-resumed',
            sessionManager,
            driverRuns: [
                {
                    providerRunId: 'parent-run',
                    tenantId: 'tenant-1',
                    taskId: 'task-resumed',
                    agentId: 'root-agent',
                    rootTaskId: 'task-resumed',
                    operation: 'agent.run',
                    status: 'failed',
                    boundaryKind: 'fail',
                    error: { name: 'AbortError', message: 'Operation cancelled by AbortSignal' },
                    updatedAt: '2026-06-23T12:00:10.000Z',
                },
                {
                    providerRunId: 'turn-await',
                    tenantId: 'tenant-1',
                    taskId: 'task-resumed',
                    agentId: 'root-agent',
                    rootTaskId: 'task-resumed',
                    operation: 'turn.segment',
                    status: 'completed',
                    turnSeq: 1,
                    boundaryKind: 'await_child',
                    updatedAt: '2026-06-23T12:00:20.000Z',
                },
                {
                    providerRunId: 'turn-running',
                    tenantId: 'tenant-1',
                    taskId: 'task-resumed',
                    agentId: 'root-agent',
                    rootTaskId: 'task-resumed',
                    operation: 'turn.segment',
                    status: 'running',
                    turnSeq: 2,
                    updatedAt: '2026-06-23T12:00:30.000Z',
                },
            ],
        });

        expect(graph.root.status).toBe('running');
        expect(graph.root.error).toBeUndefined();
        expect(graph.root.finishedAt).toBeUndefined();
    });

    it('projects canceled driver runs as terminal canceled graph state', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        await sessionManager.saveSnapshot({
            tenantId: 'tenant-1',
            sessionId: 'task-canceled',
            agentId: 'root-agent',
            expectedWmVersion: BigInt(0),
            snapshot: {
                meta: {
                    agentId: 'root-agent',
                    cancellation: {
                        requested: true,
                        reason: 'operator stop',
                        requestedAt: '2026-06-23T11:59:00.000Z',
                    },
                },
            },
        });

        const graph = await buildAgentRunGraph({
            tenantId: 'tenant-1',
            taskId: 'task-canceled',
            sessionManager,
            driverRuns: [
                {
                    providerRunId: 'parent-run',
                    tenantId: 'tenant-1',
                    taskId: 'task-canceled',
                    agentId: 'root-agent',
                    rootTaskId: 'task-canceled',
                    operation: 'agent.run',
                    status: 'canceled',
                    updatedAt: '2026-06-23T12:00:10.000Z',
                },
            ],
        });

        expect(graph.root.status).toBe('canceled');
        expect(graph.root.finishedAt).toBe('2026-06-23T12:00:10.000Z');
        expect(graph.root.cancellation).toEqual({
            requested: true,
            reason: 'operator stop',
            requestedAt: '2026-06-23T11:59:00.000Z',
        });
    });

    it('keeps an operator-canceled root terminal even when the latest completed turn was waiting', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        await sessionManager.saveSnapshot({
            tenantId: 'tenant-1',
            sessionId: 'task-canceled-awaiting',
            agentId: 'root-agent',
            expectedWmVersion: BigInt(0),
            snapshot: {
                meta: {
                    agentId: 'root-agent',
                    cancellation: {
                        requested: true,
                        reason: 'operator stop',
                        requestedAt: '2026-06-23T11:59:00.000Z',
                    },
                },
            },
        });
        await sessionManager.appendEvent('tenant-1', 'task-canceled-awaiting', 'turn.completed', {
            taskId: 'task-canceled-awaiting',
            agentId: 'root-agent',
            turnSeq: 1,
            transition: { kind: 'await_input', token: 'input-token' },
        });

        const graph = await buildAgentRunGraph({
            tenantId: 'tenant-1',
            taskId: 'task-canceled-awaiting',
            sessionManager,
            driverRuns: [
                {
                    providerRunId: 'parent-run',
                    tenantId: 'tenant-1',
                    taskId: 'task-canceled-awaiting',
                    agentId: 'root-agent',
                    rootTaskId: 'task-canceled-awaiting',
                    operation: 'agent.run',
                    status: 'canceled',
                    boundaryKind: 'canceled',
                    updatedAt: '2026-06-23T12:00:10.000Z',
                },
                {
                    providerRunId: 'turn-await',
                    tenantId: 'tenant-1',
                    taskId: 'task-canceled-awaiting',
                    agentId: 'root-agent',
                    rootTaskId: 'task-canceled-awaiting',
                    operation: 'turn.segment',
                    status: 'completed',
                    boundaryKind: 'await_input',
                    turnSeq: 1,
                    updatedAt: '2026-06-23T12:00:00.000Z',
                },
            ],
        });

        expect(graph.root.status).toBe('canceled');
        expect(graph.root.finishedAt).toBe('2026-06-23T12:00:10.000Z');
        expect(graph.root.cancellation?.reason).toBe('operator stop');
    });

    it('keeps an operator-canceled root terminal even if an already-running segment completes later', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        await sessionManager.saveSnapshot({
            tenantId: 'tenant-1',
            sessionId: 'task-canceled-late-complete',
            agentId: 'child-agent',
            expectedWmVersion: BigInt(0),
            snapshot: {
                meta: {
                    agentId: 'child-agent',
                    cancellation: {
                        requested: true,
                        reason: 'operator child stop',
                        requestedAt: '2026-06-24T04:30:02.000Z',
                    },
                },
            },
        });

        const graph = await buildAgentRunGraph({
            tenantId: 'tenant-1',
            taskId: 'task-canceled-late-complete',
            sessionManager,
            driverRuns: [
                {
                    providerRunId: 'agent-run',
                    tenantId: 'tenant-1',
                    taskId: 'task-canceled-late-complete',
                    agentId: 'child-agent',
                    rootTaskId: 'task-canceled-late-complete',
                    operation: 'agent.run',
                    status: 'canceled',
                    boundaryKind: 'canceled',
                    updatedAt: '2026-06-24T04:30:03.000Z',
                },
                {
                    providerRunId: 'turn-run',
                    tenantId: 'tenant-1',
                    taskId: 'task-canceled-late-complete',
                    agentId: 'child-agent',
                    rootTaskId: 'task-canceled-late-complete',
                    operation: 'turn.segment',
                    status: 'completed',
                    boundaryKind: 'complete',
                    turnSeq: 1,
                    updatedAt: '2026-06-24T04:30:24.000Z',
                },
            ],
        });

        expect(graph.root.status).toBe('canceled');
        expect(graph.root.finishedAt).toBe('2026-06-24T04:30:03.000Z');
        expect(graph.root.cancellation?.reason).toBe('operator child stop');
    });

    it('finalizes stale running turns when a later turn exists for the same task', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        await sessionManager.saveSnapshot({
            tenantId: 'tenant-1',
            sessionId: 'task-stale-turn',
            agentId: 'root-agent',
            expectedWmVersion: BigInt(0),
            snapshot: { meta: { agentId: 'root-agent' } },
        });
        await sessionManager.appendEvent('tenant-1', 'task-stale-turn', 'task.started', {
            taskId: 'task-stale-turn',
        });
        await sessionManager.appendEvent('tenant-1', 'task-stale-turn', 'turn.completed', {
            taskId: 'task-stale-turn',
            agentId: 'root-agent',
            turnSeq: 4,
            transition: { kind: 'complete', result: { ok: true } },
        });

        const graph = await buildAgentRunGraph({
            tenantId: 'tenant-1',
            taskId: 'task-stale-turn',
            sessionManager,
            driverRuns: [
                {
                    providerRunId: 'turn-run-stale',
                    tenantId: 'tenant-1',
                    taskId: 'task-stale-turn',
                    agentId: 'root-agent',
                    rootTaskId: 'task-stale-turn',
                    operation: 'turn.segment',
                    status: 'running',
                    turnSeq: 3,
                },
            ],
        });

        expect(graph.turns).toEqual([
            expect.objectContaining({ turnSeq: 3, status: 'completed' }),
            expect.objectContaining({ turnSeq: 4, status: 'completed' }),
        ]);
    });

    it('projects turn.started as a running event-only turn until completion is captured', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        await sessionManager.saveSnapshot({
            tenantId: 'tenant-1',
            sessionId: 'task-live-turn',
            agentId: 'root-agent',
            expectedWmVersion: BigInt(0),
            snapshot: { meta: { agentId: 'root-agent' } },
        });
        await sessionManager.appendEvent('tenant-1', 'task-live-turn', 'task.started', {
            taskId: 'task-live-turn',
        });
        await sessionManager.appendEvent('tenant-1', 'task-live-turn', 'turn.completed', {
            taskId: 'task-live-turn',
            agentId: 'root-agent',
            turnSeq: 3,
            transition: { kind: 'await_child', token: 'child-token' },
        });
        await sessionManager.appendEvent('tenant-1', 'task-live-turn', 'turn.started', {
            taskId: 'task-live-turn',
            agentId: 'root-agent',
            turnSeq: 4,
            turnId: 'turn-4-id',
            traceId: 'trace-1',
            spanId: 'span-4',
        });

        const graph = await buildAgentRunGraph({
            tenantId: 'tenant-1',
            taskId: 'task-live-turn',
            sessionManager,
            driverRuns: [
                {
                    providerRunId: 'root-run',
                    tenantId: 'tenant-1',
                    taskId: 'task-live-turn',
                    agentId: 'root-agent',
                    rootTaskId: 'task-live-turn',
                    operation: 'agent.run',
                    status: 'completed',
                },
                {
                    providerRunId: 'turn-run-3',
                    tenantId: 'tenant-1',
                    taskId: 'task-live-turn',
                    agentId: 'root-agent',
                    rootTaskId: 'task-live-turn',
                    operation: 'turn.segment',
                    status: 'completed',
                    boundaryKind: 'await_child',
                    turnSeq: 3,
                },
            ],
        });

        expect(graph.turns).toEqual([
            expect.objectContaining({ turnSeq: 3, status: 'completed' }),
            expect.objectContaining({
                id: 'turn-4-id',
                turnSeq: 4,
                status: 'running',
                turnTraceRef: { traceId: 'trace-1', spanId: 'span-4' },
            }),
        ]);
    });

    it('does not duplicate a turn.started event after matching turn.completed is captured', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        await sessionManager.saveSnapshot({
            tenantId: 'tenant-1',
            sessionId: 'task-completed-turn',
            agentId: 'root-agent',
            expectedWmVersion: BigInt(0),
            snapshot: { meta: { agentId: 'root-agent' } },
        });
        await sessionManager.appendEvent('tenant-1', 'task-completed-turn', 'turn.started', {
            taskId: 'task-completed-turn',
            agentId: 'root-agent',
            turnSeq: 4,
            turnId: 'turn-4-start',
        });
        await sessionManager.appendEvent('tenant-1', 'task-completed-turn', 'turn.completed', {
            taskId: 'task-completed-turn',
            agentId: 'root-agent',
            turnSeq: 4,
            turnId: 'turn-4-complete',
            transition: { kind: 'complete', result: { ok: true } },
        });

        const graph = await buildAgentRunGraph({
            tenantId: 'tenant-1',
            taskId: 'task-completed-turn',
            sessionManager,
            driverRuns: [],
        });

        expect(graph.turns).toHaveLength(1);
        expect(graph.turns[0]).toEqual(expect.objectContaining({
            id: 'turn-4-complete',
            turnSeq: 4,
            status: 'completed',
        }));
    });

    it('keeps complete transitions with ok false lifecycle-completed', async () => {
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

        expect(graph.root.status).toBe('completed');
        expect(graph.turns[0]?.status).toBe('completed');
    });

    it('does not let an old await_child turn mask a failed root driver run', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        await sessionManager.saveSnapshot({
            tenantId: 'tenant-1',
            sessionId: 'task-timeout',
            agentId: 'root-agent',
            expectedWmVersion: BigInt(0),
            snapshot: { meta: { agentId: 'root-agent' } },
        });
        await sessionManager.appendEvent('tenant-1', 'task-timeout', 'task.started', {
            taskId: 'task-timeout',
        });
        await sessionManager.appendEvent('tenant-1', 'task-timeout', 'turn.completed', {
            taskId: 'task-timeout',
            agentId: 'root-agent',
            turnSeq: 1,
            transition: {
                kind: 'await_child',
                token: 'child-token',
            },
        });

        const graph = await buildAgentRunGraph({
            tenantId: 'tenant-1',
            taskId: 'task-timeout',
            sessionManager,
            driverRuns: [
                {
                    providerRunId: 'parent-run',
                    tenantId: 'tenant-1',
                    taskId: 'task-timeout',
                    agentId: 'root-agent',
                    rootTaskId: 'task-timeout',
                    operation: 'agent.run',
                    status: 'failed',
                    boundaryKind: 'fail',
                },
                {
                    providerRunId: 'turn-run',
                    tenantId: 'tenant-1',
                    taskId: 'task-timeout',
                    agentId: 'root-agent',
                    rootTaskId: 'task-timeout',
                    operation: 'turn.segment',
                    status: 'completed',
                    turnSeq: 1,
                    boundaryKind: 'await_child',
                },
            ],
        });

        expect(graph.root.status).toBe('failed');
        expect(graph.turns[0]?.status).toBe('completed');
    });

    it('projects await_child as waiting and includes recursively loaded child session turns', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        await sessionManager.saveSnapshot({
            tenantId: 'tenant-1',
            sessionId: 'cian',
            agentId: 'discover-listing-selectors',
            expectedWmVersion: BigInt(0),
            snapshot: { meta: { agentId: 'discover-listing-selectors' } },
        });
        const events: AgentRunSourceEvent[] = [
            {
                eventId: 'root-started',
                sessionId: 'cian',
                seq: 1,
                type: 'task.started',
                payload: { taskId: 'cian' },
                createdAt: '2026-06-19T20:51:02.000Z',
            },
            {
                eventId: 'child-started',
                sessionId: 'cian',
                seq: 2,
                type: 'task.child_started',
                payload: {
                    taskId: 'cian',
                    token: 'child-token',
                    childTaskId: 'a2a_cian_fetch-page-route_1781902264052_5ullho51i',
                    childAgentId: 'fetch-page-router',
                },
                createdAt: '2026-06-19T20:51:03.000Z',
            },
            {
                eventId: 'root-turn-1',
                sessionId: 'cian',
                seq: 3,
                type: 'turn.completed',
                payload: {
                    taskId: 'cian',
                    agentId: 'discover-listing-selectors',
                    turnSeq: 1,
                    stageBefore: 'idle',
                    stageAfter: 'idle',
                    transition: { kind: 'await_child', token: 'child-token' },
                },
                createdAt: '2026-06-19T20:51:04.000Z',
            },
            {
                eventId: 'child-task-started',
                sessionId: 'a2a_cian_fetch-page-route_1781902264052_5ullho51i',
                seq: 1,
                type: 'task.started',
                payload: {
                    taskId: 'a2a_cian_fetch-page-route_1781902264052_5ullho51i',
                    inputPreview: { url: 'https://example.test/listing.html' },
                },
                createdAt: '2026-06-19T20:51:05.000Z',
            },
            {
                eventId: 'child-turn-1',
                sessionId: 'a2a_cian_fetch-page-route_1781902264052_5ullho51i',
                seq: 2,
                type: 'turn.completed',
                payload: {
                    taskId: 'a2a_cian_fetch-page-route_1781902264052_5ullho51i',
                    agentId: 'fetch-page-router',
                    turnSeq: 1,
                    stageBefore: 'idle',
                    stageAfter: 'idle',
                    transition: { kind: 'complete', result: { ok: true } },
                },
                createdAt: '2026-06-19T20:51:06.000Z',
            },
            {
                eventId: 'child-task-completed',
                sessionId: 'a2a_cian_fetch-page-route_1781902264052_5ullho51i',
                seq: 3,
                type: 'task.completed',
                payload: {
                    taskId: 'a2a_cian_fetch-page-route_1781902264052_5ullho51i',
                    resultPreview: { ok: true },
                },
                createdAt: '2026-06-19T20:51:07.000Z',
            },
            {
                eventId: 'child-completed',
                sessionId: 'cian',
                seq: 4,
                type: 'task.child_completed',
                payload: {
                    taskId: 'cian',
                    token: 'child-token',
                    childTaskId: 'a2a_cian_fetch-page-route_1781902264052_5ullho51i',
                    childAgentId: 'fetch-page-router',
                    resultPreview: { ok: true },
                },
                createdAt: '2026-06-19T20:51:08.000Z',
            },
        ];

        const graph = await buildAgentRunGraph({
            tenantId: 'tenant-1',
            taskId: 'cian',
            sessionManager,
            events,
            driverRuns: [
                {
                    providerRunId: 'root-run',
                    tenantId: 'tenant-1',
                    taskId: 'cian',
                    agentId: 'discover-listing-selectors',
                    rootTaskId: 'cian',
                    operation: 'agent.run',
                    status: 'failed',
                },
                {
                    providerRunId: 'root-turn-run',
                    tenantId: 'tenant-1',
                    taskId: 'cian',
                    agentId: 'discover-listing-selectors',
                    rootTaskId: 'cian',
                    operation: 'turn.segment',
                    status: 'failed',
                    boundaryKind: 'fail',
                    turnSeq: 1,
                },
            ],
        });

        expect(graph.root.status).toBe('failed');
        expect(graph.nodes).toEqual(expect.arrayContaining([
            expect.objectContaining({
                taskId: 'a2a_cian_fetch-page-route_1781902264052_5ullho51i',
                agentId: 'fetch-page-router',
                status: 'completed',
                inputPreview: { url: 'https://example.test/listing.html' },
            }),
        ]));
        expect(graph.turns).toEqual(expect.arrayContaining([
            expect.objectContaining({
                taskId: 'cian',
                turnSeq: 1,
                status: 'failed',
                cognition: expect.objectContaining({
                    transition: { kind: 'await_child', token: 'child-token' },
                }),
            }),
            expect.objectContaining({
                taskId: 'a2a_cian_fetch-page-route_1781902264052_5ullho51i',
                turnSeq: 1,
                status: 'completed',
                cognition: expect.objectContaining({
                    transition: { kind: 'complete', result: { ok: true } },
                }),
            }),
        ]));
    });

    it('uses descendant driver runs to resolve child node and edge status when child completion events are missing', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        await sessionManager.saveSnapshot({
            tenantId: 'tenant-1',
            sessionId: 'root-task',
            agentId: 'root-agent',
            expectedWmVersion: BigInt(0),
            snapshot: { meta: { agentId: 'root-agent' } },
        });
        const events: AgentRunSourceEvent[] = [
            {
                eventId: 'root-started',
                sessionId: 'root-task',
                seq: 1,
                type: 'task.started',
                payload: { taskId: 'root-task' },
                createdAt: '2026-06-20T17:41:54.000Z',
            },
            {
                eventId: 'child-started',
                sessionId: 'root-task',
                seq: 2,
                type: 'task.child_started',
                payload: {
                    taskId: 'root-task',
                    token: 'child-token',
                    childTaskId: 'child-task',
                    childAgentId: 'child-agent',
                },
                createdAt: '2026-06-20T17:41:55.000Z',
            },
            {
                eventId: 'root-turn-1',
                sessionId: 'root-task',
                seq: 3,
                type: 'turn.completed',
                payload: {
                    taskId: 'root-task',
                    agentId: 'root-agent',
                    turnSeq: 1,
                    transition: { kind: 'await_child', token: 'child-token' },
                },
                createdAt: '2026-06-20T17:41:56.000Z',
            },
        ];

        const graph = await buildAgentRunGraph({
            tenantId: 'tenant-1',
            taskId: 'root-task',
            sessionManager,
            events,
            driverRuns: [
                {
                    providerRunId: 'root-run',
                    tenantId: 'tenant-1',
                    taskId: 'root-task',
                    agentId: 'root-agent',
                    rootTaskId: 'root-task',
                    operation: 'agent.run',
                    status: 'completed',
                    boundaryKind: 'complete',
                },
                {
                    providerRunId: 'root-turn-1',
                    tenantId: 'tenant-1',
                    taskId: 'root-task',
                    agentId: 'root-agent',
                    rootTaskId: 'root-task',
                    operation: 'turn.segment',
                    status: 'completed',
                    boundaryKind: 'await_child',
                    turnSeq: 1,
                    updatedAt: '2026-06-20T17:41:56.000Z',
                },
                {
                    providerRunId: 'child-run',
                    tenantId: 'tenant-1',
                    taskId: 'child-task',
                    agentId: 'child-agent',
                    rootTaskId: 'child-task',
                    token: 'child-token',
                    operation: 'agent.run',
                    status: 'completed',
                    boundaryKind: 'complete',
                    updatedAt: '2026-06-20T17:42:10.000Z',
                },
                {
                    providerRunId: 'child-turn-1',
                    tenantId: 'tenant-1',
                    taskId: 'child-task',
                    agentId: 'child-agent',
                    rootTaskId: 'child-task',
                    operation: 'turn.segment',
                    status: 'completed',
                    boundaryKind: 'complete',
                    turnSeq: 1,
                    updatedAt: '2026-06-20T17:42:09.000Z',
                },
            ],
        });

        expect(graph.nodes).toEqual(expect.arrayContaining([
            expect.objectContaining({
                taskId: 'child-task',
                agentId: 'child-agent',
                status: 'completed',
                finishedAt: '2026-06-20T17:42:10.000Z',
            }),
        ]));
        expect(graph.edges).toEqual(expect.arrayContaining([
            expect.objectContaining({
                childTaskId: 'child-task',
                status: 'completed',
                finishedAt: '2026-06-20T17:42:10.000Z',
            }),
        ]));
        expect(graph.turns).toEqual(expect.arrayContaining([
            expect.objectContaining({
                taskId: 'root-task',
                turnSeq: 1,
                boundaryKind: 'await_child',
                status: 'completed',
            }),
        ]));
    });

    it('projects child failure event errors onto child edges and synthetic child nodes', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        await sessionManager.saveSnapshot({
            tenantId: 'tenant-1',
            sessionId: 'root-task',
            agentId: 'root-agent',
            expectedWmVersion: BigInt(0),
            snapshot: { meta: { agentId: 'root-agent' } },
        });
        const error = { code: 'ALL_MODES_FAILED', message: 'No HTML returned' };
        const events: AgentRunSourceEvent[] = [
            {
                eventId: 'root-started',
                sessionId: 'root-task',
                seq: 1,
                type: 'task.started',
                payload: { taskId: 'root-task' },
                createdAt: '2026-06-20T17:41:54.000Z',
            },
            {
                eventId: 'child-started',
                sessionId: 'root-task',
                seq: 2,
                type: 'task.child_started',
                payload: {
                    taskId: 'root-task',
                    token: 'child-token',
                    childTaskId: 'child-task',
                    childAgentId: 'child-agent',
                },
                createdAt: '2026-06-20T17:41:55.000Z',
            },
            {
                eventId: 'child-failed',
                sessionId: 'root-task',
                seq: 3,
                type: 'task.child_failed',
                payload: {
                    taskId: 'root-task',
                    token: 'child-token',
                    childTaskId: 'child-task',
                    childAgentId: 'child-agent',
                    error,
                },
                createdAt: '2026-06-20T17:42:10.000Z',
            },
        ];

        const graph = await buildAgentRunGraph({
            tenantId: 'tenant-1',
            taskId: 'root-task',
            sessionManager,
            events,
            driverRuns: [
                {
                    providerRunId: 'root-run',
                    tenantId: 'tenant-1',
                    taskId: 'root-task',
                    agentId: 'root-agent',
                    rootTaskId: 'root-task',
                    operation: 'agent.run',
                    status: 'failed',
                    boundaryKind: 'fail',
                },
            ],
        });

        expect(graph.edges).toEqual(expect.arrayContaining([
            expect.objectContaining({
                childTaskId: 'child-task',
                status: 'failed',
                error,
                finishedAt: '2026-06-20T17:42:10.000Z',
            }),
        ]));
        expect(graph.nodes).toEqual(expect.arrayContaining([
            expect.objectContaining({
                taskId: 'child-task',
                agentId: 'child-agent',
                status: 'failed',
                error,
                finishedAt: '2026-06-20T17:42:10.000Z',
            }),
        ]));
    });

    it('marks durable cache-hit child nodes as cache even when Hatchet created an agent run', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        await sessionManager.saveSnapshot({
            tenantId: 'tenant-1',
            sessionId: 'root-task',
            agentId: 'root-agent',
            expectedWmVersion: BigInt(0),
            snapshot: { meta: { agentId: 'root-agent' } },
        });
        const events: AgentRunSourceEvent[] = [
            {
                eventId: 'child-started',
                sessionId: 'root-task',
                seq: 1,
                type: 'task.child_started',
                payload: {
                    token: 'child-token',
                    childTaskId: 'child-task',
                    childAgentId: 'fetch-page-router',
                    inputPreview: { url: 'https://example.test/listing.html' },
                },
                createdAt: '2026-06-27T20:45:57.000Z',
            },
            {
                eventId: 'child-completed',
                sessionId: 'root-task',
                seq: 2,
                type: 'task.child_completed',
                payload: {
                    token: 'child-token',
                    childTaskId: 'child-task',
                    childAgentId: 'fetch-page-router',
                    resultPreview: { ok: true },
                    executionMetadata: { origin: 'cache' },
                },
                createdAt: '2026-06-27T20:45:58.000Z',
            },
        ];

        const graph = await buildAgentRunGraph({
            tenantId: 'tenant-1',
            taskId: 'root-task',
            sessionManager,
            events,
            driverRuns: [
                {
                    providerRunId: 'root-run',
                    tenantId: 'tenant-1',
                    taskId: 'root-task',
                    agentId: 'root-agent',
                    rootTaskId: 'root-task',
                    operation: 'agent.run',
                    status: 'completed',
                    boundaryKind: 'complete',
                },
                {
                    providerRunId: 'child-agent-run',
                    tenantId: 'tenant-1',
                    taskId: 'child-task',
                    agentId: 'fetch-page-router',
                    rootTaskId: 'child-task',
                    token: 'child-token',
                    operation: 'agent.run',
                    status: 'completed',
                    boundaryKind: 'complete',
                },
            ],
        });

        expect(graph.edges).toEqual(expect.arrayContaining([
            expect.objectContaining({
                childTaskId: 'child-task',
                executionOrigin: 'cache',
            }),
        ]));
        expect(graph.nodes).toEqual(expect.arrayContaining([
            expect.objectContaining({
                taskId: 'child-task',
                providerRunId: 'child-agent-run',
                executionOrigin: 'cache',
                inputPreview: { url: 'https://example.test/listing.html' },
            }),
        ]));
    });
});
