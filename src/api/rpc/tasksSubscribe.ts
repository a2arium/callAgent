// src/api/rpc/tasksSubscribe.ts
import type { Request, Response } from 'express';
import { taskEngine, TaskEntity } from '../../core/orchestration/taskEngine.js';
import { handleSSE } from '../sse/streamHandler.js';

/**
 * Handler for the tasks/sendSubscribe method
 * This opens a streaming response using SSE
 */
export async function handleTasksSubscribe(req: Request, res: Response): Promise<void> {
    try {
        // Extract request data
        const { params } = req.body;

        if (!params?.id) {
            return sendError(res, -32602, 'Invalid params: task ID is required');
        }

        // Create a task entity
        const task: TaskEntity = {
            id: params.id,
            input: params
        };

        // Send initial response (acknowledgement)
        // Don't await the task completion - we'll stream updates
        taskEngine.startTask({ task, isStreaming: true }).catch(error => {
            console.error('Error in streaming task execution:', error);
        });

        // Hand off to SSE handler (never returns - response is managed by SSE)
        handleSSE(req, res, task.id);
    } catch (error) {
        console.error('Error handling tasks/sendSubscribe:', error);
        sendError(
            res,
            -32603,
            error instanceof Error ? error.message : 'Internal error'
        );
    }
}

/**
 * Helper to send JSON-RPC error responses
 */
function sendError(res: Response, code: number, message: string, data?: unknown): void {
    res.json({
        jsonrpc: '2.0',
        error: {
            code,
            message,
            data
        },
        id: null
    });
} 