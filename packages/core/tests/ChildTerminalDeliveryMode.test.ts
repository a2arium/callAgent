import { describe, expect, it } from '@jest/globals';
import { coordinateChildTerminal } from '../src/orchestration/ChildTerminalCoordinator.js';
import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import { SessionManager } from '../src/orchestration/SessionManager.js';
import { snapshotHasProcessedSegmentKey } from '../src/runtime/segmentProcessedKeys.js';

async function parentSession(taskId: string, withGroup = false): Promise<SessionManager> {
    const session = new SessionManager(new InMemorySessionManager());
    await session.saveSnapshot({
        tenantId: 'tenant',
        sessionId: taskId,
        agentId: 'parent',
        expectedWmVersion: 0n,
        snapshot: {
            meta: {
                agentId: 'parent',
                taskLifecycle: {
                    taskId, rootTaskId: taskId, ancestorTaskIds: [], state: 'active',
                },
                turnCoordinator: {
                    schemaVersion: 1,
                    nextFence: '0',
                    nextTurnSeq: 0,
                    requestedGeneration: '0',
                    completedGeneration: '0',
                },
            },
            pending: {
                tasks: {
                    child: {
                        agentId: 'child-agent', childTaskId: 'child-task',
                        options: { autoClearToken: true },
                    },
                },
                children: { child: { agent: 'child-agent' } },
                ...(withGroup ? {
                    groups: {
                        group: {
                            childTokens: ['child'], results: {},
                            handlers: { allCompleted: 'onGroupComplete' },
                        },
                    },
                } : {}),
            },
            inbox: { current: [], all: [] },
        },
    });
    return session;
}

describe('child terminal delivery modes', () => {
    it('consumes a blocking child inline without creating another generation', async () => {
        const session = await parentSession('parent-inline');
        const claim = await coordinateChildTerminal({
            session,
            tenantId: 'tenant',
            parentTaskId: 'parent-inline',
            deliveryMode: 'inline',
            runtimeSurface: 'in_process',
            request: {
                kind: 'completed', token: 'child', completedAt: '2026-07-19T12:00:00.000Z',
                childTaskId: 'child-task', agentId: 'child-agent', result: { ok: true },
            },
        });

        expect(claim.publicationDisposition).toBe('inline_consumed');
        const persisted = await session.load('tenant', 'parent-inline');
        const snapshot = persisted?.snapshot as any;
        expect(snapshot.meta.turnCoordinator.requestedGeneration).toBe('0');
        expect(snapshot.meta.turnCoordinator.dispatchIntent).toBeUndefined();
        expect(snapshotHasProcessedSegmentKey(snapshot, 'parent-inline:child:child')).toBe(false);
        expect(snapshot.inbox.all).toHaveLength(1);
        expect(snapshot.pending.childTerminals.child.claimId).toBeUndefined();
    });

    it('advances asynchronous delivery once and makes matching replay nudge-only', async () => {
        const session = await parentSession('parent-async', true);
        const request = {
            kind: 'completed' as const,
            token: 'child',
            completedAt: '2026-07-19T12:00:00.000Z',
            childTaskId: 'child-task',
            agentId: 'child-agent',
            result: { ok: true },
            terminalIdentity: {
                claimId: 'child-claim', fence: '7', generation: '3', turnSeq: 4,
            },
        };
        const first = await coordinateChildTerminal({
            session,
            tenantId: 'tenant',
            parentTaskId: 'parent-async',
            deliveryMode: 'async_wake',
            runtimeSurface: 'in_process',
            request,
        });
        const replay = await coordinateChildTerminal({
            session,
            tenantId: 'tenant',
            parentTaskId: 'parent-async',
            deliveryMode: 'async_wake',
            runtimeSurface: 'in_process',
            request,
        });

        expect(first.publicationDisposition).toBe('new_delivery');
        expect(first.groupIntents).toEqual([
            expect.objectContaining({ groupToken: 'group', handler: 'onGroupComplete' }),
        ]);
        expect(replay.publicationDisposition).toBe('matching_replay');
        const persisted = await session.load('tenant', 'parent-async');
        const snapshot = persisted?.snapshot as any;
        expect(snapshot.meta.turnCoordinator.requestedGeneration).toBe('1');
        expect(snapshot.meta.turnCoordinator.dispatchIntent.generation).toBe('1');
        expect(snapshotHasProcessedSegmentKey(snapshot, 'parent-async:child:child')).toBe(true);
        expect(snapshot.pending.groups).toEqual({});
        expect(snapshot.pending.childTerminals.child).toEqual(expect.objectContaining({
            claimId: 'child-claim', fence: '7', generation: '3', turnSeq: 4,
        }));
        expect(snapshot.inbox.all).toHaveLength(1);
    });

    it('keeps a parent timeout authoritative when child completion arrives late', async () => {
        const session = await parentSession('parent-timeout');
        const timeout = await coordinateChildTerminal({
            session,
            tenantId: 'tenant',
            parentTaskId: 'parent-timeout',
            deliveryMode: 'async_wake',
            runtimeSurface: 'hatchet',
            request: {
                kind: 'failed', token: 'child', failedAt: '2026-07-19T12:00:00.000Z',
                childTaskId: 'child-task', agentId: 'child-agent',
                error: { code: 'CHILD_TIMEOUT', message: 'Child timed out.', timeoutMs: 30_000 },
            },
        });
        const lateCompletion = await coordinateChildTerminal({
            session,
            tenantId: 'tenant',
            parentTaskId: 'parent-timeout',
            deliveryMode: 'async_wake',
            runtimeSurface: 'hatchet',
            request: {
                kind: 'completed', token: 'child', completedAt: '2026-07-19T12:00:01.000Z',
                childTaskId: 'child-task', agentId: 'child-agent', result: { ok: true },
                executionMetadata: { origin: 'cache' },
            },
        });

        expect(timeout.publicationDisposition).toBe('new_delivery');
        expect(lateCompletion).toEqual(expect.objectContaining({
            won: false,
            lateCompletion: true,
            disposition: 'competing_terminal',
            publicationDisposition: 'none',
        }));
        const persisted = await session.load('tenant', 'parent-timeout');
        const snapshot = persisted?.snapshot as any;
        expect(snapshot.pending.childTerminals.child).toEqual(expect.objectContaining({
            kind: 'failed',
            error: expect.objectContaining({ code: 'CHILD_TIMEOUT' }),
        }));
        expect(snapshot.inbox.all).toHaveLength(1);
        expect(snapshot.inbox.all[0].kind).toBe('child.failed');
    });
});
