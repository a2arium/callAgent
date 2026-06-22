import { describe, it, expect, jest } from '@jest/globals';
import { executeOutboxDispatch } from '../src/tasks/outboxDispatch.js';
import type { BusEventHandler, IEventBus } from '@a2arium/callagent-core/unstable';
import type { OutboxRow } from '@a2arium/callagent-core/unstable';

function createTestEventBus(): IEventBus {
    const handlers = new Map<string, Set<BusEventHandler>>();
    return {
        async publish(event) {
            const subs = handlers.get(event.channel);
            if (!subs) return;
            for (const handler of subs) {
                await handler(event);
            }
        },
        async subscribe(channel, handler) {
            if (!handlers.has(channel)) {
                handlers.set(channel, new Set());
            }
            handlers.get(channel)!.add(handler);
            return {
                unsubscribe: async () => {
                    handlers.get(channel)?.delete(handler);
                },
            };
        },
    };
}

describe('executeOutboxDispatch', () => {
    const row: OutboxRow = {
        id: 'row-1',
        tenantId: 'tenant-a',
        topic: 'task.status',
        key: 'task-1',
        payload: { taskId: 'task-1' },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        retryCount: 0,
    };

    it('publishes and deletes an outbox row', async () => {
        const bus = createTestEventBus();
        const published: string[] = [];
        await bus.subscribe('task.task-1.events', async () => {
            published.push('ok');
        });
        const prisma = {
            outbox: {
                findUnique: jest.fn(async () => row),
                delete: jest.fn(async () => undefined),
            },
        };
        const ctx = {
            workflowRunId: () => 'wf-run-1',
            taskRunExternalId: () => 'task-run-1',
            retryCount: () => 0,
        };

        const result = await executeOutboxDispatch(
            { outboxRowId: 'row-1', eventType: 'task.status', tenantId: 'tenant-a', taskId: 'task-1' },
            ctx as never,
            { eventBus: bus, prisma }
        );

        expect(result).toEqual({ ok: true });
        expect(published).toHaveLength(1);
        expect(prisma.outbox.delete).toHaveBeenCalledWith({ where: { id: 'row-1' } });
    });

    it('mirrors task console errors to Hatchet logs', async () => {
        const prisma = {
            outbox: {
                findUnique: jest.fn(async () => row),
                delete: jest.fn(async () => undefined),
            },
        };
        const ctx = {
            workflowRunId: () => 'wf-run-1',
            taskRunExternalId: () => 'task-run-1',
            retryCount: () => 0,
            logger: {
                info: jest.fn(async () => undefined),
                debug: jest.fn(async () => undefined),
                warn: jest.fn(async () => undefined),
                error: jest.fn(async () => undefined),
            },
        };
        const bus = {
            publish: jest.fn(async () => {
                console.error('provider failed', new Error('server_error'));
                throw new Error('provider failed');
            }),
            subscribe: jest.fn(),
        };

        await expect(
            executeOutboxDispatch(
                { outboxRowId: 'row-1', eventType: 'task.status', tenantId: 'tenant-a', taskId: 'task-1' },
                ctx as never,
                { eventBus: bus as never, prisma }
            )
        ).rejects.toThrow('provider failed');

        expect(ctx.logger.error).toHaveBeenCalledWith(
            expect.stringContaining('provider failed'),
            expect.objectContaining({ operation: 'effect.outbox.dispatch' })
        );
    });

    it('returns skipped when the row is already gone', async () => {
        const prisma = {
            outbox: {
                findUnique: jest.fn(async () => null),
                delete: jest.fn(async () => undefined),
            },
        };
        const result = await executeOutboxDispatch(
            { outboxRowId: 'missing', eventType: 'task.status' },
            {
                workflowRunId: () => 'wf',
                taskRunExternalId: () => 'tr',
                retryCount: () => 0,
            } as never,
            { eventBus: createTestEventBus(), prisma }
        );
        expect(result).toEqual({ ok: true, skipped: true });
    });

    it('dead-letters the outbox row when Hatchet retries are exhausted', async () => {
        const bus = {
            publish: jest.fn(async () => {
                throw new Error('nats down');
            }),
            subscribe: jest.fn(),
        };
        const prisma = {
            outbox: {
                findUnique: jest.fn(async () => row),
                delete: jest.fn(async () => undefined),
                update: jest.fn(async () => undefined),
            },
            conversationDeadLetter: {
                create: jest.fn(async () => undefined),
            },
        };
        const ctx = {
            workflowRunId: () => 'wf-run-1',
            taskRunExternalId: () => 'task-run-1',
            retryCount: () => 3,
        };

        await expect(
            executeOutboxDispatch(
                { outboxRowId: 'row-1', eventType: 'task.status', tenantId: 'tenant-a', taskId: 'task-1' },
                ctx as never,
                { eventBus: bus as never, prisma: prisma as never }
            )
        ).rejects.toThrow('nats down');

        expect(prisma.conversationDeadLetter.create).toHaveBeenCalled();
        expect(prisma.outbox.delete).toHaveBeenCalledWith({ where: { id: 'row-1' } });
    });
});
