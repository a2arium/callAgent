// src/api/sse/streamHandler.ts
import type { Request, Response } from 'express';
import { createInMemoryEventBus } from '../../eventbus/inMemoryEventBus.js';
import { busEventData } from '../../eventbus/busEventHelpers.js';
import type { BusEvent } from '../../public-types/eventbus/schemas.js';
import { taskChannel } from '../../eventbus/taskEventEmitter.js';
import type { A2AEvent } from '../../shared/types/StreamingEvents.js';
import type { IWorkingMemorySessionStore } from '@a2arium/callagent-memory-engine';
import { WorkingMemorySessionStore } from '@a2arium/callagent-memory-sql';
import { EngineLocator } from '../../orchestration/EngineLocator.js';
import type { TaskEngine } from '../../orchestration/taskEngine.js';
import { mapA2AEventToRuntimeStream } from '../../streaming/a2aMapper.js';
import { projectRuntimeStreamSse } from '../../streaming/projections.js';
import { RuntimeStreamEventSchema, isTerminalRuntimeStreamStatus, type RuntimeStreamEvent } from '../../streaming/runtimeStreamEvents.js';
import { mapWorkingMemoryEventToRuntimeStream } from '../../streaming/sessionEventMapper.js';

function requestedVisibility(req: Request): 'public' | 'debug' {
    const query = req.query as Record<string, unknown> | undefined;
    return query?.visibility === 'debug' ? 'debug' : 'public';
}

function shouldCloseSseStream(be: BusEvent, event: A2AEvent, tenantId: string): boolean {
    try {
        const runtimeEvents = mapA2AEventToRuntimeStream(event, {
            id: be.eventId,
            seq: 0,
            ts: be.ts,
            tenantId,
        });
        return projectRuntimeStreamSse(runtimeEvents).some((projected) => projected.closesStream);
    } catch {
        if (!event || typeof event !== 'object') {
            return false;
        }
        if (!('status' in event) || event.final !== true) {
            return false;
        }
        const state = event.status?.state;
        return state === 'completed' || state === 'failed' || state === 'canceled';
    }
}

/**
 * Handles Server-Sent Events (SSE) streaming for a task
 * @param req - The request object
 * @param res - The response object to stream events for
 * @param taskId - The ID of the task to stream events for
 */
export async function handleSSE(
    req: Request,
    res: Response,
    taskId: string,
    store?: IWorkingMemorySessionStore,
    tenantId: string = 'default'
): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const lastEventIdHeader = req.get('Last-Event-ID');
    const sinceSeq = lastEventIdHeader ? parseInt(lastEventIdHeader, 10) : 0;
    const visibility = requestedVisibility(req);

    const writeCanonicalEvent = (event: RuntimeStreamEvent): void => {
        const projected = projectRuntimeStreamSse([event], visibility)[0];
        if (!projected || res.writableEnded) return;
        res.write(`id: ${projected.id}\n`);
        res.write(`event: ${projected.event}\n`);
        res.write(`data: ${JSON.stringify(projected.data)}\n\n`);
    };

    if (sinceSeq > 0 && Number.isFinite(sinceSeq)) {
        try {
            const sessionStore: IWorkingMemorySessionStore = store || (new (WorkingMemorySessionStore as any)());
            const missed = await (sessionStore as any).listEventsSince({ tenantId, sessionId: taskId, sinceSeq });
            for (const ev of missed) {
                const runtimeEvents = mapWorkingMemoryEventToRuntimeStream({
                    eventId: ev.eventId,
                    seq: ev.seq,
                    type: ev.type,
                    payload: ev.payload,
                    createdAt: ev.createdAt,
                }, { taskId, tenantId });
                if (runtimeEvents.length > 0) {
                    for (const runtimeEvent of runtimeEvents) {
                        writeCanonicalEvent(runtimeEvent);
                    }
                    continue;
                }
                const cloud = {
                    specversion: '1.0',
                    id: String(ev.seq),
                    type: ev.type,
                    source: `/tasks/${taskId}`,
                    time: ev.createdAt,
                    datacontenttype: 'application/json',
                    data: ev.payload,
                };
                res.write(`id: ${cloud.id}\n`);
                res.write(`event: ${cloud.type}\n`);
                res.write(`data: ${JSON.stringify(cloud)}\n\n`);
            }
        } catch {
            /* ignore replay failures */
        }
    }

    const engine = EngineLocator.getEngine<TaskEngine>();
    const bus = engine?.eventBus ?? createInMemoryEventBus();
    const channel = taskChannel(taskId);

    const writeEvent = (event: A2AEvent): void => {
        const cloud = {
            specversion: '1.0',
            id: String(Date.now()),
            type: 'task.status',
            source: `/tasks/${taskId}`,
            time: new Date().toISOString(),
            datacontenttype: 'application/json',
            data: event,
        };
        if (res.writableEnded) return;
        res.write(`id: ${cloud.id}\n`);
        res.write(`event: ${cloud.type}\n`);
        res.write(`data: ${JSON.stringify(cloud)}\n\n`);
    };

    const holder: { unsub?: () => Promise<void> } = {};
    const { unsubscribe } = await bus.subscribe(channel, async (be: BusEvent) => {
        const data = busEventData<unknown>(be);
        if (!data) {
            return;
        }
        const parsedRuntimeEvent = RuntimeStreamEventSchema.safeParse(data);
        if (parsedRuntimeEvent.success) {
            writeCanonicalEvent(parsedRuntimeEvent.data);
            if (isTerminalRuntimeStreamStatus(parsedRuntimeEvent.data)) {
                try {
                    await holder.unsub?.();
                } catch {
                    /* noop */
                }
                res.end();
            }
            return;
        }

        if (!data || typeof data !== 'object') {
            return;
        }
        const event = data as A2AEvent;
        writeEvent(event);
        if (shouldCloseSseStream(be, event, tenantId)) {
            try {
                await holder.unsub?.();
            } catch {
                /* noop */
            }
            res.end();
        }
    });
    holder.unsub = unsubscribe;

    req.on('close', () => {
        console.log(`Client disconnected from SSE stream for task ${taskId}`);
        void holder.unsub?.();
    });

    writeEvent({
        id: taskId,
        status: { state: 'submitted', timestamp: new Date().toISOString() },
        final: false,
    } as A2AEvent);
}
