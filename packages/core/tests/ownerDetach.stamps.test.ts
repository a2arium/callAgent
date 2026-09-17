import { describe, expect, it } from '@jest/globals';
import { TaskEngine } from '../src/orchestration/taskEngine.js';
import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { setPendingTasks } from '../src/orchestration/Handles.js';
import { setPendingInputs } from '../src/orchestration/DurableHandlerRegistry.js';
import { prepareSegmentWake } from '../src/runtime/segmentWakeApplicator.js';
import { InboxManager } from '../src/orchestration/InboxManager.js';

describe('owner detach plan stamps', () => {
    it('taskEngine.detachTaskBranch copies stamps onto child and input terminals', async () => {
        const store = new InMemorySessionManager();
        const engine = new TaskEngine({ sessionStore: store });
        const tenantId = 't1';
        const taskId = 'task-a';

        let snapshot = setPendingTasks({
            meta: {
                turnCoordinator: {
                    schemaVersion: 1,
                    nextFence: '0',
                    nextTurnSeq: 0,
                    requestedGeneration: '0',
                    completedGeneration: '0',
                },
                taskLifecycle: {
                    taskId,
                    rootTaskId: taskId,
                    ancestorTaskIds: [],
                    state: 'active',
                },
            },
            pending: {},
            inbox: { current: [], all: [] },
        }, {
            'child-tok': {
                agentId: 'child-agent',
                childTaskId: 'child-1',
                planId: 'p1',
                stepId: 'A',
                advanceCursor: true,
                handlers: {},
            },
        });
        snapshot = setPendingInputs(snapshot, {
            'tok-in': {
                schema: { type: 'string' },
                planId: 'p1',
                stepId: 'B',
                advanceCursor: false,
            },
        });

        await store.writeSnapshotCAS({
            tenantId,
            sessionId: taskId,
            agentId: 'agent-a',
            expectedWmVersion: BigInt(0),
            snapshot,
        });

        await engine.detachTaskBranch({
            tenantId,
            taskId,
            reason: 'test_detach',
            detachedAt: '2026-08-17T00:00:00.000Z',
        });

        const loaded = await store.getSessionSnapshot(tenantId, taskId);
        const pending = (loaded!.snapshot as {
            pending: {
                tasks: Record<string, unknown>;
                inputs: Record<string, unknown>;
                childTerminals: Record<string, unknown>;
                inputTerminals: Record<string, unknown>;
            };
        }).pending;

        expect(pending.tasks).toEqual({});
        expect(pending.inputs).toEqual({});
        expect(pending.childTerminals['child-tok']).toEqual(expect.objectContaining({
            kind: 'failed',
            planId: 'p1',
            stepId: 'A',
            advanceCursor: true,
            error: { code: 'CHILD_OWNER_TERMINAL', message: expect.stringContaining(taskId) },
        }));
        expect(pending.inputTerminals['tok-in']).toEqual(expect.objectContaining({
            kind: 'cancelled',
            planId: 'p1',
            stepId: 'B',
            advanceCursor: false,
        }));
    });

    it('segment-wake owner recovery tombstones stamped pending inputs', async () => {
        let version = BigInt(3);
        let snapshot: Record<string, unknown> = setPendingInputs({
            meta: {
                turn: 2,
                agentId: 'agent-a',
                taskLifecycle: {
                    taskId: 'task-a',
                    rootTaskId: 'task-a',
                    ancestorTaskIds: [],
                    state: 'completed',
                    reason: 'task_completed',
                },
            },
            pending: {},
            inbox: InboxManager.normalizeInbox(undefined),
        }, {
            'tok-in': {
                schema: { type: 'string' },
                planId: 'p1',
                stepId: 'B',
                advanceCursor: false,
            },
        });
        const session = {
            load: async () => ({ snapshot, wmVersion: version, agentId: 'agent-a' }),
            saveSnapshot: async (params: { expectedWmVersion: bigint; snapshot: Record<string, unknown> }) => {
                snapshot = params.snapshot;
                version += BigInt(1);
                return { newVersion: version };
            },
            appendEvent: async () => ({ eventId: 'event', seq: 1 }),
        };

        const prepared = await prepareSegmentWake(session as never, {
            tenantId: 'tenant-a',
            taskId: 'task-a',
            wake: { trigger: 'start', input: { stale: true } },
        });

        expect(prepared.skipTurn).toBe(true);
        const pending = (snapshot as {
            pending: {
                inputs: Record<string, unknown>;
                inputTerminals: Record<string, unknown>;
            };
        }).pending;
        expect(pending.inputs).toEqual({});
        expect(pending.inputTerminals['tok-in']).toEqual(expect.objectContaining({
            kind: 'cancelled',
            planId: 'p1',
            stepId: 'B',
            advanceCursor: false,
        }));
    });
});
