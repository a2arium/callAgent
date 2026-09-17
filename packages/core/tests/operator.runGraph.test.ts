import { describe, expect, it } from '@jest/globals';
import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import {
    buildAgentRunGraph,
    buildTaskCoordinationView,
    groupTurnAttempts,
    applyTaskTurnAuthority,
    type AgentRunSourceEvent,
    type DriverRunView,
} from '../src/operator/runGraph.js';

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
                id: 'turn:task-1:7',
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
                id: 'turn:task-live-turn:4',
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
            id: 'turn:task-completed-turn:4',
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

    it('groups queued attempts under their logical turn and preserves canceled error severity', async () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        await sessionManager.saveSnapshot({
            tenantId: 'tenant-1',
            sessionId: 'task-attempts',
            agentId: 'root-agent',
            expectedWmVersion: BigInt(0),
            snapshot: { meta: { agentId: 'root-agent', cancellation: { requested: true, reason: 'operator stop' } } },
        });
        const error = { name: 'Error', message: 'RUNTIME_TIMER_REPOSITORY_MISSING' };
        const graph = await buildAgentRunGraph({
            tenantId: 'tenant-1',
            taskId: 'task-attempts',
            sessionManager,
            driverRuns: [
                {
                    providerRunId: 'root-run', tenantId: 'tenant-1', taskId: 'task-attempts',
                    rootTaskId: 'task-attempts', agentId: 'root-agent', operation: 'agent.run',
                    status: 'canceled', error, updatedAt: '2026-07-22T10:01:00.000Z',
                },
                {
                    providerRunId: 'turn-1', tenantId: 'tenant-1', taskId: 'task-attempts',
                    rootTaskId: 'task-attempts', operation: 'turn.segment', status: 'completed',
                    turnSeq: 1, attemptSeq: 1, turnDisposition: 'executed', boundaryKind: 'await_child',
                    createdAt: '2026-07-22T10:00:00.000Z', updatedAt: '2026-07-22T10:00:01.000Z',
                },
                {
                    providerRunId: 'turn-2-owner', tenantId: 'tenant-1', taskId: 'task-attempts',
                    rootTaskId: 'task-attempts', operation: 'turn.segment', status: 'running',
                    turnSeq: 2, attemptSeq: 2, turnDisposition: 'executed', claimId: 'claim-2',
                    createdAt: '2026-07-22T10:00:02.000Z', updatedAt: '2026-07-22T10:00:03.000Z',
                },
                {
                    providerRunId: 'turn-2-queued-1', tenantId: 'tenant-1', taskId: 'task-attempts',
                    rootTaskId: 'task-attempts', operation: 'turn.segment', status: 'completed',
                    turnSeq: 2, attemptSeq: 3, turnDisposition: 'queued', boundaryKind: 'await_child',
                    createdAt: '2026-07-22T10:00:10.000Z', updatedAt: '2026-07-22T10:00:11.000Z',
                },
                {
                    providerRunId: 'turn-2-queued-legacy', tenantId: 'tenant-1', taskId: 'task-attempts',
                    rootTaskId: 'task-attempts', operation: 'turn.segment', status: 'completed',
                    attemptSeq: 4, turnDisposition: 'queued', boundaryKind: 'await_child',
                    createdAt: '2026-07-22T10:00:20.000Z', updatedAt: '2026-07-22T10:00:21.000Z',
                },
            ],
        });

        expect(graph.schemaVersion).toBe(3);
        expect(graph.turns).toHaveLength(2);
        expect(graph.unassignedAttempts).toHaveLength(0);
        expect(graph.root).toEqual(expect.objectContaining({ status: 'canceled', severity: 'error', error }));
        expect(graph.turns[1]).toEqual(expect.objectContaining({ turnSeq: 2, status: 'canceled', severity: 'error', error }));
        expect(graph.turns[1]?.attempts).toHaveLength(3);
        expect(graph.turns[1]?.attempts.map((attempt) => attempt.disposition)).toEqual(['executed', 'queued', 'queued']);
    });

    it('projects an explicitly detached zero-turn child as canceled', async () => {
        const sessionManager = new SessionManager(new InMemorySessionManager());
        await sessionManager.saveSnapshot({
            tenantId: 'tenant-1', sessionId: 'root-task', agentId: 'root-agent', expectedWmVersion: 0n,
            snapshot: { meta: { agentId: 'root-agent' } },
        });
        await sessionManager.appendEvent('tenant-1', 'root-task', 'task.child_started', {
            token: 'child-token', childTaskId: 'child-task', childAgentId: 'fetch-html',
        });
        await sessionManager.appendEvent('tenant-1', 'root-task', 'task.child_completed', {
            token: 'child-token', childTaskId: 'child-task', childAgentId: 'fetch-html',
        });
        await sessionManager.appendEvent('tenant-1', 'child-task', 'task.detached', {
            taskId: 'child-task', reason: 'child_timeout', detachedAt: '2026-07-22T10:00:00.000Z',
        });

        const graph = await buildAgentRunGraph({
            tenantId: 'tenant-1', taskId: 'root-task', sessionManager,
            events: [
                {
                    eventId: 'edge-start', sessionId: 'root-task', seq: 1,
                    type: 'task.child_started', createdAt: '2026-07-22T09:59:00.000Z',
                    payload: { token: 'child-token', childTaskId: 'child-task', childAgentId: 'fetch-html' },
                },
                {
                    eventId: 'edge-complete', sessionId: 'root-task', seq: 2,
                    type: 'task.child_completed', createdAt: '2026-07-22T09:59:01.000Z',
                    payload: { token: 'child-token', childTaskId: 'child-task', childAgentId: 'fetch-html' },
                },
                {
                    eventId: 'child-detached', sessionId: 'child-task', seq: 1,
                    type: 'task.detached', createdAt: '2026-07-22T10:00:00.000Z',
                    payload: { taskId: 'child-task', reason: 'child_timeout' },
                },
            ],
            driverRuns: [{
                providerRunId: 'child-provider-run', tenantId: 'tenant-1', taskId: 'child-task',
                rootTaskId: 'root-task', parentTaskId: 'root-task', agentId: 'fetch-html',
                operation: 'agent.run', status: 'completed',
            }],
        });

        expect(graph.nodes.find((node) => node.taskId === 'child-task')).toEqual(expect.objectContaining({
            status: 'canceled',
        }));
    });

    it('does not call a provider-only zero-turn child completed without terminal evidence', async () => {
        const sessionManager = new SessionManager(new InMemorySessionManager());
        await sessionManager.saveSnapshot({
            tenantId: 'tenant-1', sessionId: 'root-task', agentId: 'root-agent', expectedWmVersion: 0n,
            snapshot: { meta: { agentId: 'root-agent' } },
        });
        const events: AgentRunSourceEvent[] = [
            {
                eventId: 'edge-start', sessionId: 'root-task', seq: 1,
                type: 'task.child_started', createdAt: '2026-07-22T09:59:00.000Z',
                payload: { token: 'child-token', childTaskId: 'child-task', childAgentId: 'fetch-html' },
            },
        ];
        const graph = await buildAgentRunGraph({
            tenantId: 'tenant-1', taskId: 'root-task', sessionManager, events,
            driverRuns: [{
                providerRunId: 'child-provider-run', tenantId: 'tenant-1', taskId: 'child-task',
                rootTaskId: 'root-task', parentTaskId: 'root-task', agentId: 'fetch-html',
                operation: 'agent.run', status: 'completed',
            }],
        });

        expect(graph.nodes.find((node) => node.taskId === 'child-task')).toEqual(expect.objectContaining({
            status: 'unknown',
        }));
    });

    it('groups cognition events by logicalTurnSeq before provider attempt sequence', async () => {
        const sessionManager = new SessionManager(new InMemorySessionManager());
        await sessionManager.saveSnapshot({
            tenantId: 'tenant-1', sessionId: 'root-task', agentId: 'root-agent', expectedWmVersion: 0n,
            snapshot: { meta: { agentId: 'root-agent' } },
        });
        await sessionManager.appendEvent('tenant-1', 'root-task', 'turn.started', {
            taskId: 'root-task', turnSeq: 8, logicalTurnSeq: 2,
        });
        await sessionManager.appendEvent('tenant-1', 'root-task', 'turn.completed', {
            taskId: 'root-task', turnSeq: 8, logicalTurnSeq: 2,
            transition: { kind: 'await_child', token: 'child-token' },
        });

        const graph = await buildAgentRunGraph({
            tenantId: 'tenant-1', taskId: 'root-task', sessionManager, driverRuns: [],
        });

        expect(graph.turns).toEqual([
            expect.objectContaining({ turnSeq: 2 }),
        ]);
        expect(graph.turns[0]?.cognitiveTurns).toEqual([
            expect.objectContaining({ cognitionTurnSeq: 8, segmentSeq: 2, disposition: 'committed' }),
        ]);
    });

    it('preserves every cognitive turn inside one durable segment', async () => {
        const sessionManager = new SessionManager(new InMemorySessionManager());
        await sessionManager.saveSnapshot({
            tenantId: 'tenant-1', sessionId: 'root-task', agentId: 'root-agent', expectedWmVersion: 0n,
            snapshot: { meta: { agentId: 'root-agent' } },
        });
        for (let turn = 1; turn <= 37; turn += 1) {
            await sessionManager.appendEvent('tenant-1', 'root-task', 'turn.completed', {
                taskId: 'root-task', agentId: 'root-agent', turnSeq: turn, cognitionTurnSeq: turn,
                logicalTurnSeq: 1, segmentSeq: 1, claimId: 'claim-1', attemptKey: 'segment-1',
                turnId: `cognition-${turn}`,
                transition: { kind: turn === 37 ? 'complete' : 'continue' },
                timings: { totalMs: turn === 37 ? 8 : 5_000, learningMs: turn === 37 ? 5 : 20 },
                usage: { llmCalls: turn === 37 ? 0 : 1 },
                llmCalls: turn === 37 ? [] : [{ model: 'test' }],
            });
        }

        const graph = await buildAgentRunGraph({
            tenantId: 'tenant-1', taskId: 'root-task', sessionManager, driverRuns: [],
        });

        expect(graph.turns).toHaveLength(1);
        expect(graph.turns[0]?.cognitiveTurns).toHaveLength(37);
        expect(graph.turns[0]?.cognitiveTurns?.[35]).toEqual(expect.objectContaining({
            cognitionTurnSeq: 36,
            cognition: expect.objectContaining({ timings: expect.objectContaining({ totalMs: 5_000 }) }),
        }));
        expect(graph.turns[0]?.cognitiveTurns?.[36]).toEqual(expect.objectContaining({
            cognitionTurnSeq: 37,
            cognition: expect.objectContaining({ timings: expect.objectContaining({ totalMs: 8 }) }),
        }));
    });

    it('shows observed cognitive turns before segment arbitration', async () => {
        const sessionManager = new SessionManager(new InMemorySessionManager());
        await sessionManager.saveSnapshot({
            tenantId: 'tenant-1', sessionId: 'root-task', agentId: 'root-agent', expectedWmVersion: 0n,
            snapshot: { meta: { agentId: 'root-agent' } },
        });
        await sessionManager.appendEvent('tenant-1', 'root-task', 'turn.observed', {
            taskId: 'root-task', turnId: 'cognition-1', turnSeq: 1, cognitionTurnSeq: 1,
            logicalTurnSeq: 1, segmentSeq: 1, claimId: 'claim-1', attemptKey: 'segment-1',
            timings: { totalMs: 125 }, transition: { kind: 'continue' },
        });

        const graph = await buildAgentRunGraph({
            tenantId: 'tenant-1', taskId: 'root-task', sessionManager, driverRuns: [],
        });

        expect(graph.turns[0]?.cognitiveTurns).toEqual([
            expect.objectContaining({ cognitionTurnSeq: 1, disposition: 'observed' }),
        ]);
    });

    it('uses the durable claim as the identity for event-only cognition turns', async () => {
        const sessionManager = new SessionManager(new InMemorySessionManager());
        await sessionManager.saveSnapshot({
            tenantId: 'tenant-1', sessionId: 'root-task', agentId: 'root-agent', expectedWmVersion: 0n,
            snapshot: { meta: { agentId: 'root-agent' } },
        });
        await sessionManager.appendEvent('tenant-1', 'root-task', 'turn.started', {
            taskId: 'root-task', agentId: 'root-agent', turnSeq: 2, logicalTurnSeq: 2,
            claimId: 'claim-2', fence: '8', claimedGeneration: '2', attemptKey: 'segment-key',
        });
        await sessionManager.appendEvent('tenant-1', 'root-task', 'turn.completed', {
            taskId: 'root-task', agentId: 'root-agent', turnSeq: 2, logicalTurnSeq: 2,
            claimId: 'claim-2', fence: '8', claimedGeneration: '2', attemptKey: 'segment-key',
            transition: { kind: 'complete', result: { ok: true } },
        });

        const graph = await buildAgentRunGraph({
            tenantId: 'tenant-1', taskId: 'root-task', sessionManager, driverRuns: [],
        });

        expect(graph.turns[0]?.attempts).toHaveLength(1);
        expect(graph.turns[0]?.attempts[0]).toEqual(expect.objectContaining({
            attemptKey: 'claim:claim-2', claimId: 'claim-2', disposition: 'executed',
        }));
    });

    it('coalesces claim and provider evidence without merging distinct claims', () => {
        const projection = groupTurnAttempts([
            {
                id: 'claim-row', rootTaskId: 'root-task', taskId: 'root-task', agentId: 'agent-1',
                status: 'running', operation: 'turn.segment', turnSeq: 2,
                attemptKey: 'claim:claim-2', claimId: 'claim-2', disposition: 'executed',
            },
            {
                id: 'provider-row', rootTaskId: 'root-task', taskId: 'root-task', agentId: 'agent-1',
                status: 'completed', operation: 'turn.segment', turnSeq: 2,
                attemptKey: 'hatchet:run:task', claimId: 'claim-2', disposition: 'executed',
                providerRunId: 'run-1', boundaryKind: 'await_child',
            },
            {
                id: 'retry-row', rootTaskId: 'root-task', taskId: 'root-task', agentId: 'agent-1',
                status: 'queued', operation: 'turn.segment', turnSeq: 2,
                attemptKey: 'claim:claim-3', claimId: 'claim-3', disposition: 'queued',
            },
        ]);

        expect(projection.turns).toHaveLength(1);
        expect(projection.turns[0]?.attempts).toHaveLength(2);
        expect(projection.turns[0]?.attempts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                attemptKey: 'claim:claim-2', status: 'completed', providerRunId: 'run-1',
            }),
            expect.objectContaining({ attemptKey: 'claim:claim-3', status: 'queued' }),
        ]));
    });

    it('lets the highest-fence active claim own a recovered logical turn', () => {
        const grouped = groupTurnAttempts([
            {
                id: 'old', rootTaskId: 'task-1', taskId: 'task-1', status: 'waiting',
                operation: 'turn.segment', turnSeq: 2, attemptKey: 'claim:old', claimId: 'old',
                turnFence: '2', claimedGeneration: '2', disposition: 'executed', boundaryKind: 'paused',
            },
            {
                id: 'new', rootTaskId: 'task-1', taskId: 'task-1', status: 'running',
                operation: 'turn.segment', turnSeq: 2, attemptKey: 'claim:new', claimId: 'new',
                turnFence: '3', claimedGeneration: '2', disposition: 'executed',
            },
        ]).turns;
        const projected = applyTaskTurnAuthority(grouped, {
            taskId: 'task-1', state: 'owned', health: 'healthy', observedAt: '2026-09-05T12:00:00.000Z',
            requestedGeneration: '2', completedGeneration: '1', issues: [],
            active: {
                claimId: 'new', fence: '3', ownerId: 'worker-new', turnSeq: 2, claimedGeneration: '2',
                phase: 'executing', acquiredAt: '2026-09-05T11:59:00.000Z', heartbeatAt: '2026-09-05T12:00:00.000Z',
                expiresAt: '2026-09-05T12:02:00.000Z', leaseState: 'live',
            },
        });

        expect(projected).toHaveLength(1);
        expect(projected[0]).toMatchObject({ status: 'running', claimId: 'new', turnFence: '3' });
        expect(projected[0]?.attempts).toEqual(expect.arrayContaining([
            expect.objectContaining({ claimId: 'old', disposition: 'superseded' }),
            expect.objectContaining({ claimId: 'new', status: 'running' }),
        ]));
    });

    it('projects a staged recovery separately from attempts', () => {
        const turn = groupTurnAttempts([{
            id: 'old', rootTaskId: 'task-1', taskId: 'task-1', status: 'completed',
            operation: 'turn.segment', turnSeq: 2, attemptKey: 'claim:old', claimId: 'old',
            turnFence: '2', claimedGeneration: '2', disposition: 'superseded',
        }]).turns;
        const sourceClaim = {
            claimId: 'old', fence: '2', ownerId: 'worker-old', requestKey: 'task-1:turn-request:2',
            claimedGeneration: '2', turnSeq: 2, phase: 'executing' as const, runtimeSurface: 'hatchet' as const,
            acquiredAt: '2026-09-05T11:00:00.000Z', heartbeatAt: '2026-09-05T11:01:00.000Z', expiresAt: '2026-09-05T11:02:00.000Z',
        };
        const projected = applyTaskTurnAuthority(turn, {
            taskId: 'task-1', state: 'recovering', health: 'attention', observedAt: '2026-09-05T12:00:00.000Z',
            requestedGeneration: '2', completedGeneration: '1', issues: ['runnable_without_owner'],
            dispatchIntent: { generation: '2', state: 'pending', recoveryReason: 'lease_expired', createdAt: '2026-09-05T11:02:00.000Z' },
        }, [{
            reason: 'lease_expired', deliveryKey: 'task-1:turn-request:2', generation: '2', turnSeq: 2,
            stagedAt: '2026-09-05T11:02:00.000Z', sourceClaim,
        }]);

        expect(projected[0]).toMatchObject({
            status: 'recovering',
            attempts: [{ claimId: 'old' }],
            recoveries: [{ reason: 'lease_expired', state: 'staged', sourceFence: '2' }],
        });
    });
});

describe('buildTaskCoordinationView lease recovery', () => {
    const expiredClaim = {
        claimId: 'claim-old', fence: '4', ownerId: 'worker-old', requestKey: 'task-1:start',
        claimedGeneration: '2', turnSeq: 7, phase: 'executing', runtimeSurface: 'hatchet',
        acquiredAt: '2026-09-04T09:00:00.000Z', heartbeatAt: '2026-09-04T09:00:00.000Z',
        expiresAt: '2026-09-04T09:02:00.000Z',
    } as const;

    it('shows an expired active owner as recovering before the scanner stages dispatch', () => {
        const view = buildTaskCoordinationView('task-1', { meta: {
            taskLifecycle: { taskId: 'task-1', rootTaskId: 'task-1', ancestorTaskIds: [], state: 'active' },
            turnCoordinator: {
                schemaVersion: 1, runtimeSurface: 'hatchet', nextFence: '4', nextTurnSeq: 7,
                requestedGeneration: '2', completedGeneration: '1', active: expiredClaim,
            },
        } }, Date.parse('2026-09-04T09:03:00.000Z'));
        expect(view).toMatchObject({ state: 'recovering', health: 'stuck', issues: ['claim_expired'] });
    });

    it('labels the durable recovery dispatch without creating a new logical turn', () => {
        const view = buildTaskCoordinationView('task-1', { meta: {
            taskLifecycle: { taskId: 'task-1', rootTaskId: 'task-1', ancestorTaskIds: [], state: 'active' },
            turnCoordinator: {
                schemaVersion: 1, runtimeSurface: 'hatchet', nextFence: '4', nextTurnSeq: 7,
                requestedGeneration: '2', completedGeneration: '1',
                dispatchIntent: {
                    generation: '2', turnSeq: 7, deliveryKey: 'task-1:turn-request:2',
                    runtimeSurface: 'hatchet', createdAt: '2026-09-04T09:03:00.000Z',
                    recovery: { reason: 'lease_expired', sourceClaim: expiredClaim },
                },
            },
        } }, Date.parse('2026-09-04T09:03:01.000Z'));
        expect(view).toMatchObject({
            state: 'recovering', health: 'attention',
            dispatchIntent: { generation: '2', recoveryReason: 'lease_expired' },
        });
    });
});
