// src/api/rpc/tasksSend.ts
import type { Request, Response } from 'express';
import { EngineLocator } from '../../core/orchestration/EngineLocator.js';
import type { TaskEngine, TaskEntity } from '../../core/orchestration/taskEngine.js';

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

        const engine = getEngineOrRespond(res);
        if (!engine) return;

        // Process in buffered mode (not streaming)
        const resultTask = await engine.startTask({ task, isStreaming: false });

        // Send the JSON-RPC response with the complete task results
        res.json({
            jsonrpc: '2.0',
            id: req.body.id || null,
            result: resultTask
        });
    } catch (error: unknown) {
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

function getEngineOrRespond(res: Response): TaskEngine | null {
    const engine = EngineLocator.getEngine<TaskEngine>();
    if (!engine) {
        sendError(res, -32603, 'TaskEngine not configured on server');
        return null;
    }
    return engine;
}