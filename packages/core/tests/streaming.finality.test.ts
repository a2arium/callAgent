import { jest } from '@jest/globals';
import { extendContextWithStreaming } from '../src/context/StreamingContext.js';
import { handleSSE } from '../src/api/sse/streamHandler.js';
import { createInMemoryEventBus } from '../src/eventbus/inMemoryEventBus.js';
import { createBusEvent } from '../src/eventbus/busEventHelpers.js';
import { taskChannel } from '../src/eventbus/taskEventEmitter.js';
import { EngineLocator } from '../src/orchestration/EngineLocator.js';
import { mapA2AEventToRuntimeStream } from '../src/streaming/a2aMapper.js';
import type { A2AEvent } from '../src/shared/types/StreamingEvents.js';
import { runWithSegmentIdempotencyKey } from '../src/runtime/segmentProcessedKeys.js';

const publishTaskEvent = async (bus: ReturnType<typeof createInMemoryEventBus>, taskId: string, data: A2AEvent) => {
    await bus.publish(
        createBusEvent({
            channel: taskChannel(taskId),
            partitionKey: taskId,
            cloud: {
                id: `event-${Math.random().toString(36).slice(2)}`,
                type: 'task.a2a',
                source: `/tasks/${taskId}`,
                time: new Date().toISOString(),
                datacontenttype: 'application/json',
                data,
            },
        })
    );
};

describe('streaming finality', () => {
    afterEach(() => {
        EngineLocator.setEngine(null as any);
        jest.restoreAllMocks();
    });

    it('does not promote reply lastChunk to task-level final', async () => {
        const taskId = 'task-last-chunk';
        const bus = createInMemoryEventBus();
        const events: A2AEvent[] = [];
        await bus.subscribe(taskChannel(taskId), async (event) => {
            events.push(event.payload.data as A2AEvent);
        });

        const ctx: any = {
            task: { id: taskId },
            tenantId: 'tenant-test',
            agentId: 'agent-test',
        };
        extendContextWithStreaming(ctx, true, bus);

        await ctx.reply('done chunk', { lastChunk: true });
        await Promise.resolve();

        expect(events).toHaveLength(1);
        expect('artifact' in events[0]).toBe(true);
        expect((events[0] as any).artifact.lastChunk).toBe(true);
        expect((events[0] as any).final).toBe(false);
    });

    it('maps ctx.progress percentage updates to canonical non-terminal task.status', async () => {
        const taskId = 'task-progress-status';
        const bus = createInMemoryEventBus();
        const events: A2AEvent[] = [];
        await bus.subscribe(taskChannel(taskId), async (event) => {
            events.push(event.payload.data as A2AEvent);
        });

        const ctx: any = {
            task: { id: taskId },
            tenantId: 'tenant-test',
            agentId: 'agent-test',
        };
        extendContextWithStreaming(ctx, true, bus);

        ctx.progress(35, 'Loading context');
        await Promise.resolve();

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            id: taskId,
            status: {
                state: 'working',
                metadata: { progress: 35 },
                message: { role: 'agent', parts: [{ type: 'text', text: 'Loading context' }] },
            },
            final: false,
        });

        const canonical = mapA2AEventToRuntimeStream(events[0], {
            id: 'progress-event-1',
            seq: 1,
            ts: '2026-05-04T00:00:00.000Z',
            tenantId: 'tenant-test',
            agentId: 'agent-test',
        });

        expect(canonical).toEqual([
            expect.objectContaining({
                type: 'task.status',
                taskId,
                visibility: 'public',
                data: expect.objectContaining({
                    state: 'working',
                    terminal: false,
                    metadata: { progress: 35 },
                    message: { role: 'agent', parts: [{ type: 'text', text: 'Loading context' }] },
                }),
            }),
        ]);
    });

    it('buffers fenced terminal APIs until durable arbitration', async () => {
        const taskId = 'task-buffered-terminal';
        const bus = createInMemoryEventBus();
        const events: A2AEvent[] = [];
        await bus.subscribe(taskChannel(taskId), async (event) => {
            events.push(event.payload.data as A2AEvent);
        });
        const ctx: any = { task: { id: taskId }, tenantId: 'tenant-test', agentId: 'agent-test' };
        extendContextWithStreaming(ctx, true, bus);

        await runWithSegmentIdempotencyKey('segment-1', async () => {
            ctx.recordUsage({ cost: 0.25, kind: 'llm' });
            ctx.complete(100, 'Fetch failed: HTTP 500');
        }, {
            tenantId: 'tenant-test',
            taskId,
            claimId: 'claim-1',
            fence: '1',
            ownerId: 'owner-1',
            requestKey: 'segment-1',
            claimedGeneration: '1',
            turnSeq: 1,
            acquiredAt: '2026-01-01T00:00:00.000Z',
            heartbeatAt: '2026-01-01T00:00:00.000Z',
            expiresAt: '2026-01-01T00:02:00.000Z',
            runtimeSurface: 'in_process',
        });

        expect(events).toHaveLength(0);
        expect(ctx.__pendingTerminalIntent).toEqual({
            state: 'completed',
            message: 'Fetch failed: HTTP 500',
            progress: 100,
            usage: { totalCost: 0.25, byKind: { llm: 0.25 } },
        });
    });

    it('treats the second complete argument as a message in legacy mode', async () => {
        const taskId = 'task-complete-message';
        const bus = createInMemoryEventBus();
        const events: A2AEvent[] = [];
        await bus.subscribe(taskChannel(taskId), async (event) => {
            events.push(event.payload.data as A2AEvent);
        });
        const ctx: any = { task: { id: taskId }, tenantId: 'tenant-test', agentId: 'agent-test' };
        extendContextWithStreaming(ctx, true, bus);

        ctx.complete(100, 'Fetch failed: HTTP 500');
        await Promise.resolve();

        expect(events).toEqual([
            expect.objectContaining({
                final: true,
                status: expect.objectContaining({
                    state: 'completed',
                    message: { role: 'agent', parts: [{ type: 'text', text: 'Fetch failed: HTTP 500' }] },
                }),
            }),
        ]);
    });

    it('keeps SSE open for artifact final flags and closes on terminal status', async () => {
        const taskId = 'task-sse-finality';
        const bus = createInMemoryEventBus();
        EngineLocator.setEngine({ eventBus: bus } as any);

        const writes: string[] = [];
        const reqHandlers = new Map<string, () => void>();
        const req: any = {
            get: () => undefined,
            on: (event: string, handler: () => void) => {
                reqHandlers.set(event, handler);
            },
        };
        const res: any = {
            writableEnded: false,
            setHeader: jest.fn(),
            flushHeaders: jest.fn(),
            write: jest.fn((chunk: string) => {
                writes.push(chunk);
                return true;
            }),
            end: jest.fn(() => {
                res.writableEnded = true;
            }),
        };

        await handleSSE(req, res, taskId, { listEventsSince: jest.fn() } as any, 'tenant-test');

        await publishTaskEvent(bus, taskId, {
            id: taskId,
            artifact: {
                name: 'response',
                parts: [{ type: 'text', text: 'chunk' }],
                lastChunk: true,
            },
            final: true,
        } as A2AEvent);

        expect(res.end).not.toHaveBeenCalled();
        expect(res.writableEnded).toBe(false);

        await publishTaskEvent(bus, taskId, {
            id: taskId,
            status: {
                state: 'input-required',
                timestamp: new Date().toISOString(),
                message: { role: 'agent', parts: [{ type: 'text', text: 'Need more input' }] },
                metadata: { token: 'tok-1' },
            },
            final: true,
        });

        expect(res.end).not.toHaveBeenCalled();
        expect(res.writableEnded).toBe(false);

        await publishTaskEvent(bus, taskId, {
            id: taskId,
            status: { state: 'completed', timestamp: new Date().toISOString() },
            final: true,
        });

        expect(res.end).toHaveBeenCalledTimes(1);
        expect(res.writableEnded).toBe(true);
        expect(writes.join('')).toContain('"artifact"');
        expect(writes.join('')).toContain('"status"');
    });
});
