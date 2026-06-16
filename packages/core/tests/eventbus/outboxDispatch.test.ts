import { describe, it, expect, afterEach, jest } from '@jest/globals';
import {
    deleteOutboxRow,
    dispatchOutboxRow,
    getHatchetOutboxTopics,
    getOutboxDispatcherMode,
    handleOutboxDispatchFailure,
    isHatchetOutboxTopic,
    outboxChannel,
    parseTraceIdFromTraceparent,
    resolveOutboxDispatchContext,
    shouldPollerSkipOutboxRow,
    type OutboxRow,
} from '../../src/eventbus/outboxDispatch.js';
import { createInMemoryEventBus } from '../../src/eventbus/inMemoryEventBus.js';

describe('outboxDispatch', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    describe('outboxChannel', () => {
        it('maps task topics to task channel', () => {
            expect(outboxChannel({ topic: 'task.status', key: 'task-1' })).toBe('task.task-1.events');
            expect(outboxChannel({ topic: 'task.input_required', key: 'task-1' })).toBe(
                'task.task-1.events'
            );
            expect(outboxChannel({ topic: 'task.child_dispatch', key: 'task-1' })).toBe(
                'task.task-1.events'
            );
        });

        it('passes conversation topics through', () => {
            expect(outboxChannel({ topic: 'conversation.message', key: 'k' })).toBe(
                'conversation.message'
            );
        });

        it('returns topic as channel for other topics', () => {
            expect(outboxChannel({ topic: 'custom.topic', key: 'k' })).toBe('custom.topic');
        });
    });

    describe('resolveOutboxDispatchContext', () => {
        it('parses trace id from traceparent', () => {
            expect(parseTraceIdFromTraceparent('00-abc123def456789012345678901234-7890123456789012-01')).toBe(
                'abc123def456789012345678901234'
            );
            expect(
                resolveOutboxDispatchContext({
                    traceparent: '00-trace99trace99trace99trace99trace99-7890123456789012-01',
                    token: 'tok-1',
                }).traceId
            ).toBe('trace99trace99trace99trace99trace99');
            expect(
                resolveOutboxDispatchContext({ token: 'tok-1' }, { traceId: 'override' }).traceId
            ).toBe('override');
        });
    });

    describe('hatchet topic helpers', () => {
        it('defaults to poll mode', () => {
            delete process.env.CALLAGENT_OUTBOX_DISPATCHER;
            expect(getOutboxDispatcherMode()).toBe('poll');
            expect(isHatchetOutboxTopic('task.status')).toBe(false);
        });

        it('recognizes hatchet-owned topics in hatchet mode', () => {
            process.env.CALLAGENT_OUTBOX_DISPATCHER = 'hatchet';
            expect(getOutboxDispatcherMode()).toBe('hatchet');
            expect(getHatchetOutboxTopics().has('task.status')).toBe(true);
            expect(isHatchetOutboxTopic('task.status')).toBe(true);
            expect(isHatchetOutboxTopic('conversation.message')).toBe(false);
            expect(shouldPollerSkipOutboxRow({ topic: 'task.status' })).toBe(true);
        });

        it('honors CALLAGENT_OUTBOX_HATCHET_TOPICS override', () => {
            process.env.CALLAGENT_OUTBOX_DISPATCHER = 'hatchet';
            process.env.CALLAGENT_OUTBOX_HATCHET_TOPICS = 'custom.only';
            expect(isHatchetOutboxTopic('task.status')).toBe(false);
            expect(isHatchetOutboxTopic('custom.only')).toBe(true);
        });
    });

    describe('dispatchOutboxRow', () => {
        it('publishes bus event with expected shape', async () => {
            const bus = createInMemoryEventBus();
            const published: unknown[] = [];
            await bus.subscribe('task.task-1.events', (ev) => {
                published.push(ev);
            });
            const row: OutboxRow = {
                id: 'row-1',
                tenantId: 'tenant-a',
                topic: 'task.status',
                key: 'task-1',
                payload: { taskId: 'task-1', status: { state: 'working' } },
                createdAt: new Date('2026-01-01T00:00:00.000Z'),
                retryCount: 0,
            };
            await dispatchOutboxRow({ eventBus: bus, row });
            expect(published).toHaveLength(1);
            const ev = published[0] as {
                channel: string;
                partitionKey: string;
                payload: { id: string; type: string; data: unknown };
            };
            expect(ev.channel).toBe('task.task-1.events');
            expect(ev.partitionKey).toBe('task-1');
            expect(ev.payload.id).toBe('row-1');
            expect(ev.payload.type).toBe('task.status');
        });
    });

    describe('deleteOutboxRow', () => {
        it('deletes row successfully', async () => {
            const prisma = {
                outbox: {
                    delete: jest.fn().mockResolvedValue(undefined),
                },
            };
            await deleteOutboxRow({ prisma, id: 'row-1' });
            expect(prisma.outbox.delete).toHaveBeenCalledWith({ where: { id: 'row-1' } });
        });

        it('ignores P2025 not-found', async () => {
            const prisma = {
                outbox: {
                    delete: jest.fn().mockRejectedValue({ code: 'P2025' }),
                },
            };
            await expect(deleteOutboxRow({ prisma, id: 'row-1' })).resolves.toBeUndefined();
        });
    });

    describe('handleOutboxDispatchFailure', () => {
        const row: OutboxRow = {
            id: 'row-1',
            tenantId: 'tenant-a',
            topic: 'task.status',
            key: 'task-1',
            payload: { ok: true },
            createdAt: new Date(),
            retryCount: 0,
        };

        it('increments retry count below max', async () => {
            const prisma = {
                outbox: {
                    delete: jest.fn(),
                    update: jest.fn().mockResolvedValue(undefined),
                },
                conversationDeadLetter: { create: jest.fn() },
            };
            await handleOutboxDispatchFailure({
                prisma,
                row,
                error: new Error('transient'),
                maxRetries: 3,
            });
            expect(prisma.outbox.update).toHaveBeenCalledWith({
                where: { id: 'row-1' },
                data: { retryCount: 1 },
            });
        });

        it('dead-letters and deletes at max retries', async () => {
            const prisma = {
                outbox: {
                    delete: jest.fn().mockResolvedValue(undefined),
                    update: jest.fn(),
                },
                conversationDeadLetter: { create: jest.fn().mockResolvedValue(undefined) },
            };
            await handleOutboxDispatchFailure({
                prisma,
                row: { ...row, retryCount: 2 },
                error: new Error('permanent'),
                maxRetries: 3,
            });
            expect(prisma.conversationDeadLetter.create).toHaveBeenCalled();
            expect(prisma.outbox.delete).toHaveBeenCalledWith({ where: { id: 'row-1' } });
        });
    });
});
