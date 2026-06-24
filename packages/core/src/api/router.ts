// src/api/router.ts
import { Router } from 'express';
import fs from 'node:fs/promises';
import {
    handleTasksSend,
    handleTasksSubscribe,
    handleTasksResubscribe,
    handleTasksInput
} from './rpc/index.js';
import { normalizeRpcTaskParams } from './rpc/taskParams.js';
import { EngineLocator } from '../orchestration/EngineLocator.js';
import type { TaskEngine } from '../orchestration/taskEngine.js';
import { getAgentWorkspaceInfo, listAgentWorkspaceInfos } from '../plugin/WorkspaceLoader.js';
import { PluginManager } from '../plugin/pluginManager.js';
import type { AgentCard } from '@a2arium/callagent-types';
import { defaultMetricsRegistry } from '../observability/metrics.js';
import {
    isProductionMode,
    isPublicRpcEnabled,
    OperatorAuthError,
    resolveOperatorRequestContext,
    type OperatorRequestContext,
} from '../operator/operatorAuth.js';
import { writeOperatorAudit } from '../operator/operatorAudit.js';

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
    router.post('/rpc', observeRoute('rpc', async (req, res) => {
        const method = req.body?.method;
        const protectedRpc = isOperatorLaunch(req) || shouldProtectRpcMethod(method);
        const operatorContext = protectedRpc ? contextOrThrow(req) : undefined;
        if (operatorContext && isTaskStartingRpcMethod(method)) {
            const normalized = normalizeRpcTaskParams(req.body?.params);
            if (normalized) {
                normalized.tenantId = operatorContext.tenantId;
                req.body.params = normalized;
                await auditOperatorAction(operatorContext, {
                    action: 'payload.launch',
                    taskId: normalized.id,
                    agentId: typeof normalized.agentId === 'string' ? normalized.agentId : undefined,
                    accepted: true,
                    resultStatus: 'requested',
                    metadata: { method, payloadKeys: Object.keys(normalized).sort() },
                });
            }
        } else if (operatorContext && method === 'tasks/input') {
            const params = req.body?.params;
            if (params && typeof params === 'object' && !Array.isArray(params)) {
                (params as Record<string, unknown>).tenantId = operatorContext.tenantId;
            }
        }

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
    }));

    router.get('/metrics', (_req, res) => {
        const context = contextOrRespond(_req, res);
        if (!context) return;
        if (process.env.CALLAGENT_METRICS_ENABLED === 'false') {
            res.status(404).json({ ok: false, error: 'Metrics endpoint is disabled' });
            return;
        }
        res.json({
            ok: true,
            metrics: defaultMetricsRegistry.snapshot(),
        });
    });

    router.get('/agent-runs', observeRoute('agent-runs', async (req, res) => {
        try {
            const context = contextOrRespond(req, res);
            if (!context) return;
            const engine = EngineLocator.getEngine<TaskEngine>();
            if (!engine) {
                res.status(503).json({ error: 'Task engine is not available' });
                return;
            }
            const limitRaw = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : undefined;
            const scope = req.query.scope === 'all' ? 'all' : 'roots';
            const page = await engine.listAgentRuns({
                tenantId: context.tenantId,
                ...(typeof req.query.agentId === 'string' && req.query.agentId.length > 0 ? { agentId: req.query.agentId } : {}),
                ...(typeof req.query.status === 'string' && req.query.status.length > 0 ? { status: req.query.status } : {}),
                ...(typeof req.query.since === 'string' && req.query.since.length > 0 ? { since: req.query.since } : {}),
                ...(typeof req.query.cursor === 'string' && req.query.cursor.length > 0 ? { cursor: req.query.cursor } : {}),
                ...(limitRaw !== undefined && Number.isFinite(limitRaw) ? { limit: limitRaw } : {}),
                scope,
            });
            res.json(page);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            res.status(500).json({ error: 'Failed to list agent runs', message });
        }
    }));

    router.get('/agents', observeRoute('agents', async (req, res) => {
        const context = contextOrRespond(req, res);
        if (!context) return;
        const agentsById = new Map<string, ListedAgent>();

        for (const card of PluginManager.listAgents()) {
            const workspace = getAgentWorkspaceInfo(card.name);
            agentsById.set(card.name, {
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
            });
        }

        for (const { agentName, info } of listAgentWorkspaceInfos()) {
            if (agentsById.has(agentName)) {
                continue;
            }
            const card = await readIndexedAgentCard(agentName, info.agentCardPath);
            agentsById.set(agentName, {
                id: card.name,
                name: card.name,
                version: card.version,
                description: card.description,
                tags: card.skills.flatMap((skill) => skill.tags ?? []),
                defaultInputModes: card.defaultInputModes,
                defaultOutputModes: card.defaultOutputModes,
                capabilities: card.capabilities,
                skills: card.skills,
                workspace: {
                    name: info.workspaceName,
                    root: info.workspaceRoot,
                },
            });
        }

        const agents = Array.from(agentsById.values()).sort((left, right) => left.name.localeCompare(right.name));

        res.json({ items: agents });
    }));

    router.get('/tasks/:taskId/run-graph', observeRoute('run-graph', async (req, res) => {
        try {
            const context = contextOrRespond(req, res);
            if (!context) return;
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
            const graph = await engine.buildAgentRunGraph({
                tenantId: context.tenantId,
                taskId,
            });
            res.json(graph);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            res.status(500).json({ error: 'Failed to build run graph', message });
        }
    }));

    router.post('/tasks/:taskId/cancel', observeRoute('task-cancel', async (req, res) => {
        const context = contextOrRespond(req, res);
        if (!context) return;
        const requestedAt = new Date();
        const taskId = req.params.taskId;
        const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
        const reason = typeof body.reason === 'string' && body.reason.trim().length > 0
            ? body.reason.trim()
            : 'operator cancel';
        const agentId = typeof body.agentId === 'string' && body.agentId.length > 0
            ? body.agentId
            : undefined;
        try {
            const engine = EngineLocator.getEngine<TaskEngine>();
            if (!engine) {
                res.status(503).json({ error: 'Task engine is not available' });
                return;
            }
            if (taskId === undefined || taskId.length === 0) {
                res.status(400).json({ error: 'taskId is required' });
                return;
            }
            await auditOperatorAction(context, {
                action: agentId ? 'agent.cancel' : 'run.cancel',
                taskId,
                agentId,
                reason,
                requestedAt,
                accepted: true,
                resultStatus: 'requested',
                childPropagation: 'best_effort',
            });
            const result = await engine.cancelTask({
                tenantId: context.tenantId,
                taskId,
                ...(agentId !== undefined ? { agentId } : {}),
                reason,
            });
            res.json(result);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await auditOperatorAction(context, {
                action: agentId ? 'agent.cancel' : 'run.cancel',
                taskId,
                agentId,
                reason,
                requestedAt,
                accepted: false,
                resultStatus: 'failed',
                errorCode: error instanceof Error ? error.name : 'Error',
            }).catch(() => undefined);
            res.status(500).json({ error: 'Failed to cancel task', message });
        }
    }));

    router.get('/tasks/:taskId/turns/:turnSeq', observeRoute('turn-detail', async (req, res) => {
        try {
            const context = contextOrRespond(req, res);
            if (!context) return;
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
            const turn = await engine.getAgentRunTurn({ tenantId: context.tenantId, taskId, turnSeq });
            if (turn === null) {
                res.status(404).json({ error: 'Turn not found' });
                return;
            }
            res.json(turn);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            res.status(500).json({ error: 'Failed to load turn', message });
        }
    }));

    router.get('/tasks/:taskId/memory', observeRoute('memory-detail', async (req, res) => {
        try {
            const context = contextOrRespond(req, res);
            if (!context) return;
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
            const memory = await engine.getAgentRunMemory({ tenantId: context.tenantId, taskId });
            res.json(memory);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            res.status(500).json({ error: 'Failed to load memory', message });
        }
    }));

    return router;
}

function observeRoute(route: string, handler: (req: any, res: any, next?: any) => Promise<void> | void) {
    return async (req: any, res: any, next?: any) => {
        const method = req.method ?? 'unknown';
        const end = defaultMetricsRegistry.startTimer('operator.api_request_ms', {
            route,
            method,
        });
        defaultMetricsRegistry.increment('operator.api_request_total', {
            route,
            method,
        });
        try {
            await handler(req, res, next);
        } catch (error) {
            if (error instanceof OperatorAuthError) {
                defaultMetricsRegistry.increment('operator.api_error_total', {
                    route,
                    method,
                    errorCode: error.code,
                });
                res.status(error.status).json({ error: error.code, message: error.message });
                return;
            }
            defaultMetricsRegistry.increment('operator.api_error_total', {
                route,
                method,
                errorCode: error instanceof Error ? error.name : 'Error',
            });
            throw error;
        } finally {
            const status = res.statusCode ?? 200;
            if (status >= 500) {
                defaultMetricsRegistry.increment('operator.api_error_total', {
                    route,
                    method,
                    status,
                });
            }
            end({
                route,
                method,
                status,
            });
        }
    };
}

function contextOrThrow(req: any): OperatorRequestContext {
    return resolveOperatorRequestContext(req);
}

function contextOrRespond(req: any, res: any): OperatorRequestContext | undefined {
    try {
        return contextOrThrow(req);
    } catch (error) {
        if (error instanceof OperatorAuthError) {
            res.status(error.status).json({ error: error.code, message: error.message });
            return undefined;
        }
        throw error;
    }
}

function isOperatorLaunch(req: any): boolean {
    return req.header?.('x-callagent-operator-launch') === 'true';
}

function shouldProtectRpcMethod(method: unknown): boolean {
    if (!isProductionMode() || isPublicRpcEnabled()) return false;
    return method === 'tasks/send' || method === 'tasks/sendSubscribe' || method === 'tasks/input';
}

function isTaskStartingRpcMethod(method: unknown): method is 'tasks/send' | 'tasks/sendSubscribe' {
    return method === 'tasks/send' || method === 'tasks/sendSubscribe';
}

async function auditOperatorAction(
    context: OperatorRequestContext,
    record: Parameters<typeof writeOperatorAudit>[0]['record']
): Promise<void> {
    const engine = EngineLocator.getEngine<TaskEngine>();
    const prisma = engine && typeof (engine as any).getOperatorPrismaClient === 'function'
        ? (engine as any).getOperatorPrismaClient()
        : undefined;
    await writeOperatorAudit({
        prisma: prisma as never,
        context,
        record,
        required: context.production,
    });
}

async function readIndexedAgentCard(agentName: string, agentCardPath: string | undefined): Promise<AgentCard> {
    if (agentCardPath !== undefined) {
        try {
            const parsed = JSON.parse(await fs.readFile(agentCardPath, 'utf8')) as Partial<AgentCard>;
            if (typeof parsed.name === 'string' && parsed.name.length > 0) {
                return normalizeListedAgentCard(agentName, parsed);
            }
        } catch {
            // Fall back to a minimal launcher card. The runtime can still load the agent by id.
        }
    }
    return normalizeListedAgentCard(agentName, { name: agentName });
}

function normalizeListedAgentCard(agentName: string, card: Partial<AgentCard>): AgentCard {
    const skill = Array.isArray(card.skills) && card.skills.length > 0
        ? card.skills
        : [
              {
                  id: agentName,
                  name: agentName,
                  description: card.description ?? 'Indexed workspace agent.',
              },
          ];
    return {
        name: typeof card.name === 'string' && card.name.length > 0 ? card.name : agentName,
        version: typeof card.version === 'string' && card.version.length > 0 ? card.version : '0.0.0',
        description: typeof card.description === 'string' && card.description.length > 0
            ? card.description
            : 'Indexed workspace agent.',
        supportedInterfaces: Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : [],
        capabilities: card.capabilities ?? {},
        defaultInputModes: Array.isArray(card.defaultInputModes) ? card.defaultInputModes : ['application/json'],
        defaultOutputModes: Array.isArray(card.defaultOutputModes) ? card.defaultOutputModes : ['application/json'],
        skills: skill,
        ...(card.url ? { url: card.url } : {}),
        ...(card.provider ? { provider: card.provider } : {}),
        ...(card.documentationUrl ? { documentationUrl: card.documentationUrl } : {}),
        ...(card.iconUrl ? { iconUrl: card.iconUrl } : {}),
    };
}
