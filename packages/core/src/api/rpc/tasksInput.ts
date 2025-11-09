// src/api/rpc/tasksInput.ts
import type { Request, Response } from 'express';
import { EngineLocator } from '../../core/orchestration/EngineLocator.js';
import type { TaskEngine } from '../../core/orchestration/taskEngine.js';
import { getIdempotent, setIdempotent } from './IdempotencyStore.js';

/**
 * Handler for the tasks/input method (idempotent)
 * Accepts an opaque input token and optional Idempotency-Key
 */
export async function handleTasksInput(req: Request, res: Response): Promise<void> {
    try {
        const { params } = req.body;
        if (!params?.id || !params?.token || typeof params.input === 'undefined') {
            return sendError(res, -32602, 'Invalid params: id, token, and input are required');
        }

        const tenantId = (req as any).tenantId || 'default';
        const idempotencyKey = (req.header('Idempotency-Key') || params.idempotencyKey) as string | undefined;
        const cached = getIdempotent(tenantId, params.id, params.token, idempotencyKey);
        if (cached) {
            res.json(cached);
            return;
        }
        const engine = getEngineOrRespond(res);
        if (!engine) return;

        const result = await engine.resumeInput({ tenantId, taskId: params.id, token: params.token, input: params.input });
        const payload = { jsonrpc: '2.0' as const, id: req.body.id ?? null, result };
        if (idempotencyKey) setIdempotent(tenantId, params.id, params.token, idempotencyKey, payload);
        res.json(payload);
        return;
    } catch (error: unknown) {
        sendError(res, -32603, error instanceof Error ? error.message : 'Internal error');
    }
}

function sendError(res: Response, code: number, message: string, data?: unknown): void {
    res.json({ jsonrpc: '2.0', error: { code, message, data }, id: null });
}

function getEngineOrRespond(res: Response): TaskEngine | null {
    const engine = EngineLocator.getEngine<TaskEngine>();
    if (!engine) {
        sendError(res, -32603, 'TaskEngine not configured on server');
        return null;
    }
    return engine;
}


