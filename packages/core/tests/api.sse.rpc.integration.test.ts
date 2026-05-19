import { jest } from '@jest/globals';
import { createApiRouter } from '../src/api/router.js';
import { handleSSE } from '../src/api/sse/streamHandler.js';
import { createBusEvent } from '../src/eventbus/busEventHelpers.js';
import { createInMemoryEventBus } from '../src/eventbus/inMemoryEventBus.js';
import { taskChannel } from '../src/eventbus/taskEventEmitter.js';
import { EngineLocator } from '../src/orchestration/EngineLocator.js';
import { RUNTIME_STREAM_EVENT_VERSION } from '../src/streaming/runtimeStreamEvents.js';
import type { A2AEvent } from '../src/shared/types/StreamingEvents.js';

type RpcHandler = (req: any, res: any) => Promise<void>;

describe('RPC SSE integration', () => {
    afterEach(() => {
        EngineLocator.setEngine(null);
    });

    test('tasks/sendSubscribe streams CloudEvent SSE frames and closes only on terminal task status', async () => {
        const taskId = 'task-send-subscribe';
        const bus = createInMemoryEventBus();
        const res = fakeSseResponse();
        const artifactDidNotClose: boolean[] = [];
        const startTask = jest.fn(async () => {
            await delay(0);
            await publishA2A(bus, taskId, {
                id: taskId,
                artifact: {
                    name: 'reply',
                    index: 0,
                    append: true,
                    lastChunk: true,
                    parts: [{ type: 'text', text: 'hello' }],
                },
                final: true,
            }, 'artifact');
            artifactDidNotClose.push(!res.ended);
            await publishA2A(bus, taskId, {
                id: taskId,
                status: { state: 'completed' },
                final: true,
            }, 'completed');
        });

        EngineLocator.setEngine({
            eventBus: bus,
            startTask,
        });

        await rpcHandler()(
            fakeReq({ method: 'tasks/sendSubscribe', params: { id: taskId, input: { text: 'hi' }, agentId: 'agent-stream', tenantId: 'tenant-stream' } }),
            res
        );
        await waitFor(() => res.ended === true);

        expect(startTask).toHaveBeenCalledWith(expect.objectContaining({
            agentId: 'agent-stream',
            tenantId: 'tenant-stream',
            isStreaming: true,
            task: expect.objectContaining({ id: taskId }),
        }));
        expect(res.headers['Content-Type']).toBe('text/event-stream');
        expect(artifactDidNotClose).toEqual([true]);
        expect(res.ended).toBe(true);

        const events = sseDataEvents(res.writes);
        expect(events.map((event) => event.data)).toEqual([
            expect.objectContaining({ id: taskId, status: expect.objectContaining({ state: 'submitted' }), final: false }),
            expect.objectContaining({ id: taskId, artifact: expect.objectContaining({ lastChunk: true }), final: true }),
            expect.objectContaining({ id: taskId, status: expect.objectContaining({ state: 'completed' }), final: true }),
        ]);
        expect(events.every((event) => event.cloud.specversion === '1.0')).toBe(true);
        expect(events.every((event) => event.cloud.source === `/tasks/${taskId}`)).toBe(true);
    });

    test('tasks/resubscribe reopens an existing task SSE stream', async () => {
        const taskId = 'task-resubscribe';
        const bus = createInMemoryEventBus();
        const res = fakeSseResponse();

        EngineLocator.setEngine({ eventBus: bus });
        await rpcHandler()(
            fakeReq({ method: 'tasks/resubscribe', params: { id: taskId } }),
            res
        );

        await waitFor(() => sseDataEvents(res.writes).length > 0);
        await publishA2A(bus, taskId, {
            id: taskId,
            status: {
                state: 'failed',
                message: { role: 'agent', parts: [{ type: 'text', text: 'boom' }] },
            },
            final: true,
        }, 'failed');
        await waitFor(() => res.ended === true);

        expect(res.ended).toBe(true);
        const events = sseDataEvents(res.writes);
        expect(events.map((event) => event.data)).toEqual([
            expect.objectContaining({ id: taskId, status: expect.objectContaining({ state: 'submitted' }), final: false }),
            expect.objectContaining({ id: taskId, status: expect.objectContaining({ state: 'failed' }), final: true }),
        ]);
    });

    test('handleSSE replays events after numeric Last-Event-ID as sequence cursor', async () => {
        const taskId = 'task-replay';
        const tenantId = 'tenant-replay';
        const bus = createInMemoryEventBus();
        const res = fakeSseResponse();
        const listEventsSince = jest.fn(async () => [
            {
                eventId: 'event-6',
                seq: 6,
                type: 'task.artifact',
                createdAt: '2026-05-02T00:00:06.000Z',
                payload: {
                    id: taskId,
                    artifact: {
                        name: 'reply',
                        index: 0,
                        append: true,
                        parts: [{ type: 'text', text: 'missed' }],
                    },
                    final: false,
                },
            },
            {
                eventId: 'event-7',
                seq: 7,
                type: 'task.status',
                createdAt: '2026-05-02T00:00:07.000Z',
                payload: {
                    id: taskId,
                    status: { state: 'working' },
                    final: false,
                },
            },
        ]);

        EngineLocator.setEngine({ eventBus: bus });
        await handleSSE(
            fakeReq({}, { 'Last-Event-ID': '5' }),
            res,
            taskId,
            { listEventsSince } as any,
            tenantId
        );

        expect(listEventsSince).toHaveBeenCalledWith({ tenantId, sessionId: taskId, sinceSeq: 5 });
        const events = sseDataEvents(res.writes);
        expect(events.map((event) => event.cloud.id)).toEqual(['6', '7', expect.any(String)]);
        expect(events.slice(0, 2).map((event) => event.data)).toEqual([
            expect.objectContaining({ id: taskId, artifact: expect.objectContaining({ name: 'reply' }) }),
            expect.objectContaining({ id: taskId, status: expect.objectContaining({ state: 'working' }) }),
        ]);
        expect(events[2].data).toEqual(expect.objectContaining({
            id: taskId,
            status: expect.objectContaining({ state: 'submitted' }),
            final: false,
        }));
    });

    test('handleSSE replays canonical tool debug events only for debug visibility', async () => {
        const taskId = 'task-replay-tools';
        const tenantId = 'tenant-replay';
        const listEventsSince = jest.fn(async () => [
            {
                eventId: 'event-8',
                seq: 8,
                type: 'task.tool_requested',
                createdAt: '2026-05-02T00:00:08.000Z',
                payload: {
                    token: 'tool-1',
                    toolName: 'search',
                    argsPreview: { q: 'Tallinn' },
                },
            },
        ]);

        EngineLocator.setEngine({ eventBus: createInMemoryEventBus() });

        const publicRes = fakeSseResponse();
        await handleSSE(
            fakeReq({}, { 'Last-Event-ID': '7' }),
            publicRes,
            taskId,
            { listEventsSince } as any,
            tenantId
        );
        expect(publicRes.writes.join('')).not.toContain('tool.started');

        const debugRes = fakeSseResponse();
        await handleSSE(
            fakeReq({}, { 'Last-Event-ID': '7' }, { visibility: 'debug' }),
            debugRes,
            taskId,
            { listEventsSince } as any,
            tenantId
        );

        const frames = sseFrames(debugRes.writes);
        expect(frames[0]).toEqual({
            id: 'event-8',
            event: 'tool.started',
            data: expect.objectContaining({
                version: RUNTIME_STREAM_EVENT_VERSION,
                id: 'event-8',
                seq: 8,
                taskId,
                tenantId,
                type: 'tool.started',
                visibility: 'debug',
                data: {
                    token: 'tool-1',
                    toolName: 'search',
                    argsPreview: { q: 'Tallinn' },
                },
            }),
        });
    });

    test('handleSSE replays canonical child debug events only for debug visibility', async () => {
        const taskId = 'task-replay-children';
        const tenantId = 'tenant-replay';
        const listEventsSince = jest.fn(async () => [
            {
                eventId: 'event-9',
                seq: 9,
                type: 'task.child_started',
                createdAt: '2026-05-02T00:00:09.000Z',
                payload: {
                    token: 'child-1',
                    agentId: 'research-agent',
                },
            },
            {
                eventId: 'event-10',
                seq: 10,
                type: 'task.child_completed',
                createdAt: '2026-05-02T00:00:10.000Z',
                payload: {
                    token: 'child-1',
                    agentId: 'research-agent',
                    childTaskId: 'task-child-1',
                    resultPreview: { ok: true },
                },
            },
            {
                eventId: 'event-11',
                seq: 11,
                type: 'task.child_input_required',
                createdAt: '2026-05-02T00:00:11.000Z',
                payload: {
                    token: 'child-1',
                    agentId: 'research-agent',
                    childTaskId: 'task-child-1',
                    prompt: 'Need approval?',
                },
            },
        ]);

        EngineLocator.setEngine({ eventBus: createInMemoryEventBus() });

        const publicRes = fakeSseResponse();
        await handleSSE(
            fakeReq({}, { 'Last-Event-ID': '8' }),
            publicRes,
            taskId,
            { listEventsSince } as any,
            tenantId
        );
        expect(publicRes.writes.join('')).not.toContain('child.started');
        expect(publicRes.writes.join('')).not.toContain('child.completed');
        expect(publicRes.writes.join('')).not.toContain('child.message');

        const debugRes = fakeSseResponse();
        await handleSSE(
            fakeReq({}, { 'Last-Event-ID': '8' }, { visibility: 'debug' }),
            debugRes,
            taskId,
            { listEventsSince } as any,
            tenantId
        );

        const frames = sseFrames(debugRes.writes);
        expect(frames.slice(0, 3).map((frame) => frame.event)).toEqual(['child.started', 'child.completed', 'child.message']);
        expect(frames[0].data).toEqual(expect.objectContaining({
            id: 'event-9',
            seq: 9,
            taskId,
            tenantId,
            type: 'child.started',
            visibility: 'debug',
            data: {
                token: 'child-1',
                agentId: 'research-agent',
            },
        }));
        expect(frames[1].data).toEqual(expect.objectContaining({
            id: 'event-10',
            seq: 10,
            taskId,
            tenantId,
            type: 'child.completed',
            visibility: 'debug',
            data: {
                token: 'child-1',
                agentId: 'research-agent',
                childTaskId: 'task-child-1',
                status: 'completed',
                resultPreview: { ok: true },
            },
        }));
        expect(frames[2].data).toEqual(expect.objectContaining({
            id: 'event-11',
            seq: 11,
            taskId,
            tenantId,
            type: 'child.message',
            visibility: 'debug',
            data: {
                token: 'child-1',
                agentId: 'research-agent',
                childTaskId: 'task-child-1',
                parts: [{ type: 'text', text: 'Need approval?' }],
            },
        }));
    });

    test('handleSSE streams live canonical debug events when debug visibility is requested', async () => {
        const taskId = 'task-live-tool-debug';
        const bus = createInMemoryEventBus();
        const res = fakeSseResponse();

        EngineLocator.setEngine({ eventBus: bus });
        await handleSSE(
            fakeReq({}, {}, { visibility: 'debug' }),
            res,
            taskId,
            undefined,
            'tenant-live'
        );

        await bus.publish(createBusEvent({
            channel: taskChannel(taskId),
            cloud: {
                id: 'runtime-tool-1',
                type: 'tool.started',
                source: `/tasks/${taskId}`,
                time: '2026-05-03T00:00:00.000Z',
                data: {
                    version: RUNTIME_STREAM_EVENT_VERSION,
                    id: 'runtime-tool-1',
                    seq: 1,
                    taskId,
                    tenantId: 'tenant-live',
                    ts: '2026-05-03T00:00:00.000Z',
                    type: 'tool.started',
                    visibility: 'debug',
                    channel: 'debug',
                    data: {
                        token: 'tool-1',
                        toolName: 'search',
                    },
                },
            },
        }));

        await waitFor(() => sseFrames(res.writes).some((frame) => frame.event === 'tool.started'));
        expect(sseFrames(res.writes).some((frame) => frame.event === 'tool.started')).toBe(true);
    });
});

function rpcHandler(): RpcHandler {
    const router = createApiRouter() as any;
    const layer = router.stack.find((l: any) => l.route?.path === '/rpc');
    return layer.route.stack[0].handle;
}

function fakeReq(body: unknown, headers: Record<string, string> = {}, query: Record<string, string> = {}): any {
    const handlers = new Map<string, Array<() => void>>();
    return {
        body,
        query,
        get: (name: string) => headers[name],
        header: (name: string) => headers[name],
        on: (event: string, handler: () => void) => {
            const existing = handlers.get(event) ?? [];
            existing.push(handler);
            handlers.set(event, existing);
        },
    };
}

function sseFrames(writes: string[]): Array<{ id?: string; event?: string; data: unknown }> {
    return writes
        .join('')
        .split('\n\n')
        .filter(Boolean)
        .map((frame) => {
            const parsed: { id?: string; event?: string; data?: unknown } = {};
            for (const line of frame.split('\n')) {
                if (line.startsWith('id: ')) parsed.id = line.slice('id: '.length);
                if (line.startsWith('event: ')) parsed.event = line.slice('event: '.length);
                if (line.startsWith('data: ')) parsed.data = JSON.parse(line.slice('data: '.length));
            }
            return parsed.data === undefined ? undefined : parsed as { id?: string; event?: string; data: unknown };
        })
        .filter((frame): frame is { id?: string; event?: string; data: unknown } => Boolean(frame));
}

function fakeSseResponse(): any {
    let resolveEnd!: () => void;
    const ended = new Promise<void>((resolve) => { resolveEnd = resolve; });
    const res: any = {
        headers: {} as Record<string, string>,
        writes: [] as string[],
        ended: false,
        writableEnded: false,
        setHeader(name: string, value: string) {
            res.headers[name] = value;
        },
        flushHeaders() { },
        write(chunk: string) {
            res.writes.push(chunk);
        },
        end() {
            res.ended = true;
            res.writableEnded = true;
            resolveEnd();
        },
        json(body: unknown) {
            res.body = body;
            res.end();
        },
    };
    void ended;
    return res;
}

async function publishA2A(bus: ReturnType<typeof createInMemoryEventBus>, taskId: string, data: A2AEvent, id: string): Promise<void> {
    await bus.publish(createBusEvent({
        channel: taskChannel(taskId),
        cloud: {
            id,
            type: 'task.event',
            source: 'api.sse.rpc.integration.test',
            time: '2026-05-02T00:00:00.000Z',
            data,
        },
    }));
}

function sseDataEvents(writes: string[]): Array<{ cloud: any; data: A2AEvent }> {
    return writes
        .join('')
        .split('\n\n')
        .filter(Boolean)
        .map((frame) => {
            const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
            if (!dataLine) return undefined;
            const cloud = JSON.parse(dataLine.slice('data: '.length));
            return { cloud, data: cloud.data as A2AEvent };
        })
        .filter((event): event is { cloud: any; data: A2AEvent } => Boolean(event));
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
        if (predicate()) return;
        await delay(0);
    }
    throw new Error('Timed out waiting for condition');
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
