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
import { getAgentWorkspaceInfo } from '../plugin/WorkspaceLoader.js';
import { PluginManager } from '../plugin/pluginManager.js';
import type { AgentCard } from '@a2arium/callagent-types';

type ListedAgent = {
    id: string;
    name: string;
    version: string;
    description: string;
    tags: string[];
    defaultInputModes: string[];
    defaultOutputModes: string[];
    capabilities: AgentCard['capabilities'];
    skills: AgentCard['skills'];
    workspace?: {
        name: string;
        root: string;
    };
};

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

    router.get('/agent-runs', async (req, res) => {
        try {
            const engine = EngineLocator.getEngine<TaskEngine>();
            if (!engine) {
                res.status(503).json({ error: 'Task engine is not available' });
                return;
            }
            const tenantId = req.header('x-tenant-id') ?? String(req.query.tenantId ?? 'default');
            const limitRaw = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : undefined;
            const page = await engine.listAgentRuns({
                tenantId,
                ...(typeof req.query.agentId === 'string' && req.query.agentId.length > 0 ? { agentId: req.query.agentId } : {}),
                ...(typeof req.query.status === 'string' && req.query.status.length > 0 ? { status: req.query.status } : {}),
                ...(typeof req.query.since === 'string' && req.query.since.length > 0 ? { since: req.query.since } : {}),
                ...(typeof req.query.cursor === 'string' && req.query.cursor.length > 0 ? { cursor: req.query.cursor } : {}),
                ...(limitRaw !== undefined && Number.isFinite(limitRaw) ? { limit: limitRaw } : {}),
            });
            res.json(page);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            res.status(500).json({ error: 'Failed to list agent runs', message });
        }
    });

    router.get('/agents', (_req, res) => {
        const agents: ListedAgent[] = PluginManager.listAgents()
            .map((card) => {
                const workspace = getAgentWorkspaceInfo(card.name);
                return {
                    id: card.name,
                    name: card.name,
                    version: card.version,
                    description: card.description,
                    tags: card.skills.flatMap((skill) => skill.tags ?? []),
                    defaultInputModes: card.defaultInputModes,
                    defaultOutputModes: card.defaultOutputModes,
                    capabilities: card.capabilities,
                    skills: card.skills,
                    ...(workspace
                        ? {
                            workspace: {
                                name: workspace.workspaceName,
                                root: workspace.workspaceRoot,
                            },
                        }
                        : {}),
                };
            })
            .sort((left, right) => left.name.localeCompare(right.name));

        res.json({ items: agents });
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

    router.get('/tasks/:taskId/turns/:turnSeq', async (req, res) => {
        try {
            const engine = EngineLocator.getEngine<TaskEngine>();
            if (!engine) {
                res.status(503).json({ error: 'Task engine is not available' });
                return;
            }
            const taskId = req.params.taskId;
            const turnSeqRaw = req.params.turnSeq;
            if (taskId === undefined || taskId.length === 0) {
                res.status(400).json({ error: 'taskId is required' });
                return;
            }
            const turnSeq = Number.parseInt(turnSeqRaw ?? '', 10);
            if (!Number.isFinite(turnSeq)) {
                res.status(400).json({ error: 'turnSeq must be a number' });
                return;
            }
            const tenantId = req.header('x-tenant-id') ?? String(req.query.tenantId ?? 'default');
            const turn = await engine.getAgentRunTurn({ tenantId, taskId, turnSeq });
            if (turn === null) {
                res.status(404).json({ error: 'Turn not found' });
                return;
            }
            res.json(turn);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            res.status(500).json({ error: 'Failed to load turn', message });
        }
    });

    router.get('/tasks/:taskId/memory', async (req, res) => {
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
            const memory = await engine.getAgentRunMemory({ tenantId, taskId });
            res.json(memory);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            res.status(500).json({ error: 'Failed to load memory', message });
        }
    });

    return router;
} 