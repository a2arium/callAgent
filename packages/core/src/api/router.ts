// src/api/router.ts
import { Router } from 'express';
import {
    handleTasksSend,
    handleTasksSubscribe,
    handleTasksResubscribe,
    handleTasksInput
} from './rpc/index.js';
import { EngineLocator } from '../orchestration/EngineLocator.js';
import type { TaskEngine } from '../orchestration/taskEngine.js';

/**
 * Create the main API router for A2A endpoints
 */
export function createApiRouter(): Router {
    const router = Router();

    // JSON-RPC endpoint
    router.post('/rpc', async (req, res) => {
        const { method } = req.body;

        // Route to the appropriate handler based on method
        switch (method) {
            case 'tasks/send':
                await handleTasksSend(req, res);
                break;

            case 'tasks/sendSubscribe':
                await handleTasksSubscribe(req, res);
                break;

            case 'tasks/resubscribe':
                await handleTasksResubscribe(req, res);
                break;

            case 'tasks/input':
                await handleTasksInput(req, res);
                break;

            default:
                // Method not found
                res.json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32601,
                        message: 'Method not found',
                        data: { method }
                    },
                    id: req.body.id || null
                });
        }
    });

    router.get('/tasks/:taskId/run-graph', async (req, res) => {
        try {
            const engine = EngineLocator.getEngine<TaskEngine>();
            if (!engine) {
                res.status(503).json({ error: 'Task engine is not available' });
                return;
            }
            const taskId = req.params.taskId;
            if (taskId === undefined || taskId.length === 0) {
                res.status(400).json({ error: 'taskId is required' });
                return;
            }
            const tenantId = req.header('x-tenant-id') ?? String(req.query.tenantId ?? 'default');
            const graph = await engine.buildAgentRunGraph({
                tenantId,
                taskId,
            });
            res.json(graph);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            res.status(500).json({ error: 'Failed to build run graph', message });
        }
    });

    return router;
} 