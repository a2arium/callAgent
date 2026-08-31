// src/api/rpc/tasksSend.ts
import type { Request, Response } from 'express';
import { EngineLocator } from '../../orchestration/EngineLocator.js';
import type { TaskEngine, TaskEntity } from '../../orchestration/taskEngine.js';
import { normalizeRpcTaskParams } from './taskParams.js';
import { resolveRpcActiveRunTimeout } from './activeRunTimeout.js';

type RequestWithTenant = Request & { tenantId?: string };

/**
 * Handler for the tasks/send method
 */
export async function handleTasksSend(req: Request, res: Response): Promise<void> {
    try {
        // Extract request data
        const body = req.body as { id?: unknown; params?: unknown };
        const params = normalizeRpcTaskParams(body.params);

        if (!params) {
            return sendError(res, -32602, 'Invalid params: params object is required');
        }

        // Create a task entity
        const task: TaskEntity = {
            id: params.id,
            input: params
        };

        const engine = getEngineOrRespond(res);
        if (!engine) return;

        // Process in buffered mode (not streaming)
        const startedAtMs = Date.now();
        const resultTask = await engine.startTask({
            task,
            isStreaming: false,
            agentId: typeof params.agentId === 'string' ? params.agentId : undefined,
            tenantId: typeof params.tenantId === 'string'
                ? params.tenantId
                : ((req as RequestWithTenant).tenantId || req.header('x-tenant-id') || undefined),
        });
        if (
            resultTask !== undefined &&
            typeof engine.awaitTaskTerminal === 'function' &&
            (resultTask.status === undefined ||
                resultTask.status.state === 'submitted' ||
                resultTask.status.state === 'working')
        ) {
            const timeout = resolveRpcActiveRunTimeout(
                typeof params.agentId === 'string' ? params.agentId : undefined,
            );
            const observed = await engine.awaitTaskTerminal({
                tenantId: typeof params.tenantId === 'string'
                    ? params.tenantId
                    : ((req as RequestWithTenant).tenantId || req.header('x-tenant-id') || 'default'),
                taskId: task.id,
                agentId: typeof params.agentId === 'string' ? params.agentId : undefined,
                timeoutMs: timeout.timeoutMs,
                timeoutSource: timeout.source,
                startedAtMs,
            });
            resultTask.status = observed.status;
        }

        // Send the JSON-RPC response with the complete task results
        res.json({
            jsonrpc: '2.0',
            id: body.id ?? null,
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
