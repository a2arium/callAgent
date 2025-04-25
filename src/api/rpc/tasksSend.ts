// src/api/rpc/tasksSend.ts
import type { Request, Response } from 'express';
import { taskEngine, TaskEntity } from '../../core/orchestration/taskEngine.js';
import { v4 as uuidv4 } from 'uuid'; // Assuming uuid is installed

/**
 * Handler for the tasks/send method
 */
export async function handleTasksSend(req: Request, res: Response): Promise<void> {
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

        // Process in buffered mode (not streaming)
        const resultTask = await taskEngine.startTask({ task, isStreaming: false });

        // Send the JSON-RPC response with the complete task results
        res.json({
            jsonrpc: '2.0',
            id: req.body.id || null,
            result: resultTask
        });
    } catch (error) {
        console.error('Error handling tasks/send:', error);
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