import type { Request, Response } from 'express';
import { handleSSE } from '../sse/streamHandler.js';

/**
 * Handler for the tasks/resubscribe method
 * Allows clients to reconnect to an existing task's event stream
 */
export async function handleTasksResubscribe(req: Request, res: Response): Promise<void> {
    try {
        // Extract request data
        const { params } = req.body;

        if (!params?.id) {
            return sendError(res, -32602, 'Invalid params: task ID is required');
        }

        // Simply hand off to SSE handler with the existing task ID
        // No need to start a new task - just reopen the event stream
        handleSSE(req, res, params.id);
    } catch (error) {
        console.error('Error handling tasks/resubscribe:', error);
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