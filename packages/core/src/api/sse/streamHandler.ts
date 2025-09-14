// src/api/sse/streamHandler.ts
import type { Request, Response } from 'express';
import { eventBus } from '../../eventbus/inMemoryEventBus.js';
import { taskChannel } from '../../eventbus/taskEventEmitter.js';
import type { A2AEvent } from '../../shared/types/StreamingEvents.js';
import type { IWorkingMemorySessionStore } from '../../core/memory/stores/SessionStore.js';
import { WorkingMemorySessionStore } from '@a2arium/callagent-memory-sql';

/**
 * Handles Server-Sent Events (SSE) streaming for a task
 * @param req - The request object
 * @param res - The response object to stream events to
 * @param taskId - The ID of the task to stream events for
 */
export async function handleSSE(req: Request, res: Response, taskId: string, store?: IWorkingMemorySessionStore, tenantId: string = 'default'): Promise<void> {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // CloudEvents-friendly headers
    res.setHeader('X-Accel-Buffering', 'no');

    // Flush headers immediately
    res.flushHeaders();

    const sessionStore: IWorkingMemorySessionStore = store || (new (WorkingMemorySessionStore as any)());
    const lastEventIdHeader = req.get('Last-Event-ID');
    const sinceSeq = lastEventIdHeader ? parseInt(lastEventIdHeader, 10) : 0;

    // Replay missed events on resume using WMEvent log
    if (sinceSeq > 0 && Number.isFinite(sinceSeq)) {
        try {
            const missed = await (sessionStore as any).listEventsSince({ tenantId, sessionId: taskId, sinceSeq });
            for (const ev of missed) {
                const cloud = {
                    specversion: '1.0',
                    id: String(ev.seq),
                    type: ev.type,
                    source: `/tasks/${taskId}`,
                    time: ev.createdAt,
                    datacontenttype: 'application/json',
                    data: ev.payload
                };
                res.write(`id: ${cloud.id}\n`);
                res.write(`event: ${cloud.type}\n`);
                res.write(`data: ${JSON.stringify(cloud)}\n\n`);
            }
        } catch {
            // ignore replay failures
        }
    }

    // Write SSE format: "data: {...}\n\n"
    const writeEvent = (event: A2AEvent): void => {
        const cloud = {
            specversion: '1.0',
            id: String(Date.now()), // monotonic-ish; external resume uses WMEvent seq
            type: 'task.status',
            source: `/tasks/${taskId}`,
            time: new Date().toISOString(),
            datacontenttype: 'application/json',
            data: event
        };
        if (res.writableEnded) return;
        res.write(`id: ${cloud.id}\n`);
        res.write(`event: ${cloud.type}\n`);
        const canContinue = res.write(`data: ${JSON.stringify(cloud)}\n\n`);
        if (!canContinue) {
            eventBus.unsubscribe(taskChannel(taskId), handleEvent);
            res.once('drain', () => {
                eventBus.subscribe<A2AEvent>(taskChannel(taskId), handleEvent);
            });
        }
    };

    // Handler for incoming events
    const handleEvent = (event: A2AEvent): void => {
        writeEvent(event);

        // If this is the final event, end the response
        if ('final' in event && event.final === true) {
            // Unsubscribe and end the response
            eventBus.unsubscribe(taskChannel(taskId), handleEvent);
            res.end();
        }
    };

    // Handle client disconnect
    req.on('close', () => {
        console.log(`Client disconnected from SSE stream for task ${taskId}`);
        eventBus.unsubscribe(taskChannel(taskId), handleEvent);
    });

    // Subscribe to task events
    eventBus.subscribe<A2AEvent>(taskChannel(taskId), handleEvent);

    // Send initial received acknowledgement (not required by spec but helpful)
    writeEvent({ id: taskId, status: { state: 'submitted', timestamp: new Date().toISOString() }, final: false } as any);
} 