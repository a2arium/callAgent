import { describe, expect, it, jest } from '@jest/globals';
import { WorkingMemoryVersionConflictError } from '@a2arium/callagent-types';
import {
    assertTaskEffectActive,
    registerTaskEffect,
} from '../src/orchestration/TaskEffectRegistration.js';

const activeSnapshot = () => ({
    meta: {
        agentId: 'agent-a',
        taskLifecycle: {
            taskId: 'task-a',
            rootTaskId: 'task-a',
            ancestorTaskIds: [],
            state: 'active',
        },
    },
    pending: { tools: {} },
});

describe('TaskEffectRegistration', () => {
    it('rejects a detached owner without invoking the logical mutation or writing', async () => {
        const mutate = jest.fn();
        const saveSnapshot = jest.fn();
        const session = {
            load: jest.fn().mockResolvedValue({
                snapshot: {
                    ...activeSnapshot(),
                    meta: {
                        ...activeSnapshot().meta,
                        taskLifecycle: {
                            ...activeSnapshot().meta.taskLifecycle,
                            state: 'detached',
                            reason: 'child_timeout',
                        },
                    },
                },
                wmVersion: BigInt(4),
                agentId: 'agent-a',
            }),
            saveSnapshot,
        } as any;

        await expect(registerTaskEffect({
            session,
            tenantId: 'tenant-a',
            taskId: 'task-a',
            effectKind: 'tool',
            operation: 'test.tool.register',
            mutate,
        })).rejects.toMatchObject({
            code: 'TASK_LIFECYCLE_TERMINAL',
            details: { state: 'detached', effectKind: 'tool', reason: 'child_timeout' },
        });
        expect(mutate).not.toHaveBeenCalled();
        expect(saveSnapshot).not.toHaveBeenCalled();
    });

    it('reloads after a CAS loss and lets detachment reject the stale registration', async () => {
        let current: any = {
            snapshot: activeSnapshot(),
            wmVersion: BigInt(1),
            agentId: 'agent-a',
        };
        let firstWrite = true;
        const session = {
            load: jest.fn(async () => current),
            saveSnapshot: jest.fn(async (params: any) => {
                if (firstWrite) {
                    firstWrite = false;
                    current = {
                        ...current,
                        wmVersion: BigInt(2),
                        snapshot: {
                            ...current.snapshot,
                            meta: {
                                ...current.snapshot.meta,
                                taskLifecycle: {
                                    ...current.snapshot.meta.taskLifecycle,
                                    state: 'detached',
                                    reason: 'concurrent_timeout',
                                },
                            },
                        },
                    };
                    throw new WorkingMemoryVersionConflictError({
                        tenantId: 'tenant-a',
                        sessionId: 'task-a',
                        expectedWmVersion: params.expectedWmVersion.toString(),
                        actualWmVersion: '2',
                    });
                }
                throw new Error('unexpected second write');
            }),
        } as any;

        await expect(registerTaskEffect({
            session,
            tenantId: 'tenant-a',
            taskId: 'task-a',
            effectKind: 'child',
            operation: 'test.child.register',
            mutate: ({ snapshot }: any) => ({
                snapshot: { ...snapshot, marker: 'registered' },
                value: undefined,
            }),
        })).rejects.toMatchObject({
            code: 'TASK_LIFECYCLE_TERMINAL',
            details: { reason: 'concurrent_timeout' },
        });
        expect(session.saveSnapshot).toHaveBeenCalledTimes(1);
        expect(current.snapshot.marker).toBeUndefined();
    });

    it('rejects a missing durable token before provider start', async () => {
        const session = {
            load: jest.fn().mockResolvedValue({
                snapshot: activeSnapshot(),
                wmVersion: BigInt(3),
                agentId: 'agent-a',
            }),
        } as any;
        await expect(assertTaskEffectActive({
            session,
            tenantId: 'tenant-a',
            taskId: 'task-a',
            effectKind: 'tool',
            token: 'tool-missing',
            pendingKind: 'tools',
        })).rejects.toMatchObject({
            code: 'TASK_LIFECYCLE_TERMINAL',
            details: { reason: 'effect_token_not_pending' },
        });
    });
});
