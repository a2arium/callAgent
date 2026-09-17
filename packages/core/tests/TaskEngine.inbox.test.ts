import { jest } from '@jest/globals';
import { TaskEngine } from '../src/orchestration/taskEngine.js';
import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { getPendingTasks, setPendingTasks } from '../src/orchestration/Handles.js';
import { normalizeObservationInbox } from '../src/loop/types.js';

describe('TaskEngine inbox coordination', () => {
    const tenantId = 'tenant-test';
    const parentTaskId = 'parent-task';
    let currentEngine: TaskEngine | undefined;

    const buildEngine = () => {
        process.env.DISABLE_OUTBOX_PUBLISHER = 'true';
        const store = new InMemorySessionManager();
        const engine = new TaskEngine({ sessionStore: store });
        currentEngine = engine;
        // Access sessionManager for assertions; it's a private field at type level only
        const sessionManager = (engine as any).sessionManager as import('../src/orchestration/SessionManager.js').SessionManager;
        return { engine, sessionManager };
    };

    afterEach(async () => {
        await currentEngine?.waitForBackgroundTasks?.({ timeoutMs: 5000 });
        currentEngine = undefined;
        delete process.env.DISABLE_OUTBOX_PUBLISHER;
    });

    it('stages child completion observation once even when invoked repeatedly', async () => {
        const { engine, sessionManager } = buildEngine();
        const initialSnap = setPendingTasks({
            meta: { turnCoordinator: {
                schemaVersion: 1, nextFence: '0', nextTurnSeq: 0,
                requestedGeneration: '0', completedGeneration: '0',
            } },
        }, { child123: { childTaskId: 'child-task' } });
        await sessionManager.saveSnapshot({
            tenantId,
            sessionId: parentTaskId,
            agentId: 'agent',
            expectedWmVersion: BigInt(0),
            snapshot: initialSnap
        });

        const resultPayload = { status: { state: 'completed' }, data: { ok: true } };
        await engine.stageChildCompletionObservation({ tenantId, parentTaskId, childToken: 'child123', childTaskId: 'child-task', result: resultPayload });
        // Invoke again to ensure addObservationToInbox dedupes correctly
        await engine.stageChildCompletionObservation({ tenantId, parentTaskId, childToken: 'child123', childTaskId: 'child-task', result: resultPayload });

        const snap = await sessionManager.load(tenantId, parentTaskId);
        const inbox = normalizeObservationInbox((snap?.snapshot as any)?.inbox);
        const allChildCompletions = inbox.all.filter(obs => obs.kind === 'child.completed');
        const currentChildCompletions = inbox.current.filter(obs => obs.kind === 'child.completed');

        expect(allChildCompletions).toHaveLength(1);
        expect(currentChildCompletions).toHaveLength(1);
        expect(allChildCompletions[0].payload).toMatchObject({ token: 'child123', childTaskId: 'child-task' });
    });

    it('notifies the parent from the durable terminal when the local task status is stale', async () => {
        const { engine, sessionManager } = buildEngine();
        const childTaskId = 'child-durable-terminal';
        await sessionManager.saveSnapshot({
            tenantId,
            sessionId: childTaskId,
            agentId: 'child-agent',
            expectedWmVersion: BigInt(0),
            snapshot: {
                meta: {
                    a2aParent: {
                        parentTenantId: tenantId,
                        parentTaskId,
                        parentChildToken: 'child-token',
                    },
                    taskTerminal: {
                        taskId: childTaskId,
                        state: 'completed',
                        claimedAt: '2026-07-19T12:00:00.000Z',
                        deliveryKey: `${childTaskId}:terminal:completed`,
                        status: {
                            state: 'completed',
                            timestamp: '2026-07-19T12:00:00.000Z',
                            metadata: { result: { ok: true } },
                        },
                    },
                },
            },
        });
        const notify = jest.spyOn(engine, 'handleChildCompleted').mockResolvedValue(undefined);

        await (engine as any).notifyPersistedA2AParentIfTerminal({ tenantId, taskId: childTaskId });

        expect(notify).toHaveBeenCalledWith(expect.objectContaining({
            tenantId,
            parentTaskId,
            childToken: 'child-token',
            childTaskId,
            childAgentId: 'child-agent',
            result: expect.objectContaining({
                status: expect.objectContaining({ state: 'completed' }),
            }),
        }));
    });

    it('removes pending child mapping and stages observation when parent is not awaiting the child', async () => {
        const { engine, sessionManager } = buildEngine();
        const baseWithPending = setPendingTasks(
            { meta: {
                turn: 0, awaiting: { kind: 'await_child', token: 'different-child' },
                turnCoordinator: {
                    schemaVersion: 1, nextFence: '0', nextTurnSeq: 0,
                    requestedGeneration: '0', completedGeneration: '0',
                },
            } } as Record<string, unknown>,
            { child999: { childTaskId: 'child-task' } }
        );
        await sessionManager.saveSnapshot({
            tenantId,
            sessionId: parentTaskId,
            agentId: 'agent',
            expectedWmVersion: BigInt(0),
            snapshot: baseWithPending
        });

        await engine.handleChildCompleted({
            tenantId,
            parentTaskId,
            childToken: 'child999',
            childTaskId: 'child-task',
            result: { status: { state: 'completed' }, data: { ok: true } }
        });

        const snap = await sessionManager.load(tenantId, parentTaskId);
        const tasks = getPendingTasks((snap?.snapshot as any) || {});
        const inbox = normalizeObservationInbox((snap?.snapshot as any)?.inbox);
        const childCompletions = inbox.all.filter(obs => obs.kind === 'child.completed');

        expect(tasks.child999).toBeUndefined();
        expect(childCompletions).toHaveLength(1);
        expect(childCompletions[0].payload).toMatchObject({ token: 'child999', childTaskId: 'child-task' });
    });

    it('inbox normalization accepts conversation source in task-engine context', async () => {
        const { sessionManager } = buildEngine();
        await sessionManager.saveSnapshot({
            tenantId,
            sessionId: parentTaskId,
            agentId: 'agent',
            expectedWmVersion: BigInt(0),
            snapshot: {
                inbox: {
                    current: [{
                        source: 'conversation',
                        kind: 'message.received',
                        payload: {
                            kind: 'message.received',
                            message: {
                                id: 'msg-te-inbox-1',
                                conversation: { kind: 'thread', id: 'thread-te-1' },
                                senderAgentId: 'parent',
                                senderMemberId: 'parent',
                                recipientAgentId: 'child',
                                recipientMemberId: 'mem-child',
                                speechAct: 'request',
                                content: { question: true },
                                sequenceNumber: 1,
                                ts: new Date().toISOString(),
                            },
                        },
                    }],
                    all: [],
                },
            },
        });

        const snap = await sessionManager.load(tenantId, parentTaskId);
        const inbox = normalizeObservationInbox((snap?.snapshot as any)?.inbox);
        expect(inbox.current[0]).toMatchObject({ source: 'conversation', kind: 'message.received' });
    });
});
