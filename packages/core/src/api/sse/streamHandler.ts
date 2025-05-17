// src/api/sse/streamHandler.ts
import type { Request, Response } from 'express';
import { eventBus } from '../../eventbus/inMemoryEventBus.js';
import { taskChannel } from '../../eventbus/taskEventEmitter.js';
import type { A2AEvent } from '../../shared/types/StreamingEvents.js';

/**
 * Handles Server-Sent Events (SSE) streaming for a task
 * @param req - The request object
 * @param res - The response object to stream events to
 * @param taskId - The ID of the task to stream events for
 */
export function handleSSE(req: Request, res: Response, taskId: string): void {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Flush headers immediately
    res.flushHeaders();

    // Write SSE format: "data: {...}\n\n"
    const writeEvent = (event: A2AEvent): void => {
        const jsonString = JSON.stringify({
            jsonrpc: '2.0',
            id: 1, // Fixed ID for streaming responses
            result: event
        });

        // Check if we can write to the response
        if (res.writableEnded) {
            console.warn('Cannot write to ended response');
            return;
        }

        // Handle backpressure (if res.write returns false, the buffer is full)
        const canContinue = res.write(`data: ${jsonString}\n\n`);
        if (!canContinue) {
            // Pause event processing until drain event
            eventBus.unsubscribe(taskChannel(taskId), handleEvent);
            res.once('drain', () => {
                // Resume events after drain
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
    writeEvent({
        id: taskId,
        status: {
            state: 'submitted',
            timestamp: new Date().toISOString()
        },
        final: false
    });
} 