import { describe, expect, it } from '@jest/globals';
import {
    claimToolTerminalInSnapshot,
    coordinateToolTerminal,
    detachPendingToolsInSnapshot,
} from '../src/orchestration/ToolTerminalCoordinator.js';
import { markTaskLifecycle } from '../src/orchestration/TaskLifecycle.js';

const pendingToolSnapshot = () => ({
    meta: {
        turn: 1,
        agentId: 'agent-a',
        taskLifecycle: {
            taskId: 'task-a',
            rootTaskId: 'root-a',
            ancestorTaskIds: ['root-a'],
            state: 'active',
        },
        turnCoordinator: {
            schemaVersion: 1,
            nextFence: '0',
            nextTurnSeq: 0,
            requestedGeneration: '1',
            completedGeneration: '1',
        },
    },
    pending: {
        tools: {
            'tool-1': {
                name: 'slow-tool',
                args: { secret: 'not-for-diagnostics' },
                ownerTaskId: 'task-a',
                rootTaskId: 'root-a',
                ancestorTaskIds: ['root-a'],
                idempotencyKey: 'task-a:tool:tool-1',
            },
        },
    },
    inbox: { current: [], all: [] },
});

describe('ToolTerminalCoordinator', () => {
    it('atomically consumes a pending tool and stages one resumable observation', () => {
        const claim = claimToolTerminalInSnapshot(pendingToolSnapshot(), {
            taskId: 'task-a',
            token: 'tool-1',
            completedAt: '2026-07-16T12:00:00.000Z',
            result: { ok: true },
        });

        expect(claim).toMatchObject({
            won: true,
            disposition: 'committed_delivery',
            resumeEligible: true,
            terminal: { kind: 'completed', rootTaskId: 'root-a' },
        });
        expect((claim.snapshot as any).pending.tools['tool-1']).toBeUndefined();
        expect((claim.snapshot as any).pending.toolTerminals['tool-1']).toMatchObject({
            kind: 'completed',
            deliveryKey: 'task-a:tool:tool-1',
        });
        expect((claim.snapshot as any).inbox.all).toEqual([
            expect.objectContaining({
                kind: 'tool.completed',
                payload: expect.objectContaining({ token: 'tool-1', result: { ok: true } }),
            }),
        ]);

        const replay = claimToolTerminalInSnapshot(claim.snapshot, {
            taskId: 'task-a',
            token: 'tool-1',
            completedAt: '2026-07-16T12:00:01.000Z',
            result: { ok: true },
        });
        expect(replay).toMatchObject({
            won: false,
            disposition: 'matching_replay',
            resumeEligible: true,
        });
        expect((replay.snapshot as any).inbox.all).toHaveLength(1);
    });

    it('copies plan stamps onto the tombstone before deleting pending', () => {
        const snapshot = pendingToolSnapshot();
        (snapshot.pending.tools['tool-1'] as { planId: string; stepId: string; advanceCursor: boolean }).planId = 'p1';
        (snapshot.pending.tools['tool-1'] as { planId: string; stepId: string; advanceCursor: boolean }).stepId = 'A';
        (snapshot.pending.tools['tool-1'] as { planId: string; stepId: string; advanceCursor: boolean }).advanceCursor = true;

        const claim = claimToolTerminalInSnapshot(snapshot, {
            taskId: 'task-a',
            token: 'tool-1',
            completedAt: '2026-07-16T12:00:00.000Z',
            result: { ok: true },
        });

        expect((claim.snapshot as { pending: { tools: Record<string, unknown> } }).pending.tools['tool-1']).toBeUndefined();
        expect(claim.terminal).toEqual(
            expect.objectContaining({
                kind: 'completed',
                planId: 'p1',
                stepId: 'A',
                advanceCursor: true,
            })
        );
        expect(
            (claim.snapshot as { pending: { toolTerminals: Record<string, unknown> } }).pending.toolTerminals['tool-1']
        ).toEqual(expect.objectContaining({ planId: 'p1', stepId: 'A', advanceCursor: true }));
    });

    it('detaches all pending tools without staging delivery', () => {
        const terminalOwner = markTaskLifecycle(pendingToolSnapshot(), {
            taskId: 'task-a',
            state: 'detached',
            changedAt: '2026-07-16T12:00:00.000Z',
            reason: 'child_timeout',
        });
        const detached = detachPendingToolsInSnapshot(terminalOwner, {
            taskId: 'task-a',
            reason: 'child_timeout',
            detachedAt: '2026-07-16T12:00:00.000Z',
        });

        expect(detached.detached).toEqual([
            expect.objectContaining({ kind: 'detached', reason: 'child_timeout' }),
        ]);
        expect((detached.snapshot as any).pending.tools).toEqual({});
        expect((detached.snapshot as any).inbox.all).toEqual([]);

        const late = claimToolTerminalInSnapshot(detached.snapshot, {
            taskId: 'task-a',
            token: 'tool-1',
            completedAt: '2026-07-16T12:00:02.000Z',
            result: { ok: true },
        });
        expect(late).toMatchObject({
            won: false,
            lateCompletion: true,
            resumeEligible: false,
            disposition: 'competing_terminal',
        });
    });

    it('linearizes concurrent completion and detachment through snapshot CAS', async () => {
        let current = {
            snapshot: pendingToolSnapshot() as Record<string, unknown>,
            wmVersion: BigInt(1),
            agentId: 'agent-a',
        };
        const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
        const session = {
            load: async () => current,
            saveSnapshot: async (params: { expectedWmVersion: bigint; snapshot: Record<string, unknown> }) => {
                if (params.expectedWmVersion !== current.wmVersion) {
                    const error = new Error('CAS_MISMATCH') as Error & { code?: string };
                    error.code = 'WM_VERSION_CONFLICT';
                    throw error;
                }
                current = {
                    snapshot: params.snapshot as ReturnType<typeof pendingToolSnapshot>,
                    wmVersion: current.wmVersion + BigInt(1),
                    agentId: 'agent-a',
                };
                return { newVersion: current.wmVersion };
            },
            appendEvent: async (_tenantId: string, _taskId: string, type: string, payload: Record<string, unknown>) => {
                events.push({ type, payload });
            },
        };

        const [completion, detachment] = await Promise.all([
            coordinateToolTerminal({
                session,
                tenantId: 'tenant-a',
                taskId: 'task-a',
                token: 'tool-1',
                result: { ok: true },
            }),
            coordinateToolTerminal({
                session,
                tenantId: 'tenant-a',
                taskId: 'task-a',
                token: 'tool-1',
                result: undefined,
                detachReason: 'child_timeout',
            }),
        ]);

        expect([completion.won, detachment.won].filter(Boolean)).toHaveLength(1);
        expect((current.snapshot as any).pending.tools).toEqual({});
        expect(Object.keys((current.snapshot as any).pending.toolTerminals)).toEqual(['tool-1']);
        expect((current.snapshot as any).inbox.all).toHaveLength(
            (current.snapshot as any).pending.toolTerminals['tool-1'].kind === 'completed' ? 1 : 0
        );
        expect(events).toHaveLength(1);
    });
});
