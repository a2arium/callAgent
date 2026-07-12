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
import { AgentResultCache } from '@a2arium/callagent-memory-engine';
import { defaultMetricsRegistry } from '../observability/metrics.js';
import {
    isProductionMode,
    isPublicRpcEnabled,
    OperatorAuthError,
    resolveOperatorRequestContext,
    type OperatorRequestContext,
} from '../operator/operatorAuth.js';
import { OperatorAuditRepository, writeOperatorAudit } from '../operator/operatorAudit.js';
import { SemanticMemoryObserverRepository } from '../operator/semanticMemoryObserver.js';

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
            const costState = req.query.costState === 'captured' || req.query.costState === 'missing' ? req.query.costState : undefined;
            const page = await engine.listAgentRuns({
                tenantId: context.tenantId,
                ...(typeof req.query.agentId === 'string' && req.query.agentId.length > 0 ? { agentId: req.query.agentId } : {}),
                ...(typeof req.query.status === 'string' && req.query.status.length > 0 ? { status: req.query.status } : {}),
                ...(typeof req.query.since === 'string' && req.query.since.length > 0 ? { since: req.query.since } : {}),
                ...(typeof req.query.cursor === 'string' && req.query.cursor.length > 0 ? { cursor: req.query.cursor } : {}),
                ...(typeof req.query.taskId === 'string' && req.query.taskId.length > 0 ? { taskId: req.query.taskId } : {}),
                ...(req.query.hasLlm === 'true' ? { hasLlm: true } : {}),
                ...(req.query.hasMemory === 'true' ? { hasMemory: true } : {}),
                ...(costState ? { costState } : {}),
                ...(limitRaw !== undefined && Number.isFinite(limitRaw) ? { limit: limitRaw } : {}),
                scope,
            });
            res.json(page);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            res.status(500).json({ error: 'Failed to list agent runs', message });
        }
    }));

    router.get('/memory/semantic', observeRoute('memory-semantic-list', async (req, res) => {
        try {
            const context = contextOrRespond(req, res);
            if (!context) return;
            const repository = semanticMemoryRepository();
            const limit = numberQuery(req.query.limit, 50);
            const page = await repository.list({
                tenantId: context.tenantId,
                key: stringQuery(req.query.key),
                tag: stringQuery(req.query.tag),
                entity: stringQuery(req.query.entity),
                entityType: stringQuery(req.query.entityType),
                agentId: stringQuery(req.query.agentId),
                taskId: stringQuery(req.query.taskId),
                since: stringQuery(req.query.since),
                until: stringQuery(req.query.until),
                hasBlob: req.query.hasBlob === 'true',
                hasAlignment: req.query.hasAlignment === 'true',
                cursor: stringQuery(req.query.cursor),
                limit,
            });
            res.json(page);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            res.status(500).json({ error: 'Failed to list semantic memory', message });
        }
    }));

    router.get('/memory/semantic/:key', observeRoute('memory-semantic-detail', async (req, res) => {
        try {
            const context = contextOrRespond(req, res);
            if (!context) return;
            const key = req.params.key;
            if (!key) {
                res.status(400).json({ error: 'key is required' });
                return;
            }
            const detail = await semanticMemoryRepository().detail({ tenantId: context.tenantId, key });
            if (!detail) {
                res.status(404).json({ error: 'Memory item not found' });
                return;
            }
            res.json(detail);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            res.status(500).json({ error: 'Failed to load semantic memory item', message });
        }
    }));

    router.get('/memory/activity', observeRoute('memory-activity', async (req, res) => {
        try {
            const context = contextOrRespond(req, res);
            if (!context) return;
            const page = await semanticMemoryRepository().activity({
                tenantId: context.tenantId,
                key: stringQuery(req.query.key),
                taskId: stringQuery(req.query.taskId),
                agentId: stringQuery(req.query.agentId),
                op: memoryOpQuery(req.query.op),
                since: stringQuery(req.query.since),
                until: stringQuery(req.query.until),
                cursor: stringQuery(req.query.cursor),
                limit: numberQuery(req.query.limit, 100),
            });
            res.json(page);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            res.status(500).json({ error: 'Failed to list memory activity', message });
        }
    }));

    router.get('/memory/entities', observeRoute('memory-entities', async (req, res) => {
        try {
            const context = contextOrRespond(req, res);
            if (!context) return;
            const page = await semanticMemoryRepository().entities({
                tenantId: context.tenantId,
                search: stringQuery(req.query.search),
                entityType: stringQuery(req.query.entityType),
                cursor: stringQuery(req.query.cursor),
                limit: numberQuery(req.query.limit, 100),
            });
            res.json(page);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            res.status(500).json({ error: 'Failed to list memory entities', message });
        }
    }));

    router.get('/memory/semantic/:key/audit', observeRoute('memory-semantic-audit', async (req, res) => {
        try {
            const context = contextOrRespond(req, res);
            if (!context) return;
            const key = req.params.key;
            if (!key) {
                res.status(400).json({ error: 'key is required' });
                return;
            }
            const page = await operatorAuditRepository().listMemoryEvents({
                tenantId: context.tenantId,
                key,
                limit: numberQuery(req.query.limit, 20),
            });
            res.json(page);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            res.status(500).json({ error: 'Failed to list semantic memory audit events', message });
        }
    }));

    router.post('/memory/probe', observeRoute('memory-probe', async (req, res) => {
        try {
            const context = contextOrRespond(req, res);
            if (!context) return;
            const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
            if (body.filters !== undefined && (!Array.isArray(body.filters) || !body.filters.every(isProbeFilter))) {
                res.status(400).json({ error: 'filters must use a supported operator and a non-empty path' });
                return;
            }
            const result = await semanticMemoryRepository().probe({
                tenantId: context.tenantId,
                pattern: typeof body.pattern === 'string' ? body.pattern : undefined,
                tag: typeof body.tag === 'string' ? body.tag : undefined,
                filters: Array.isArray(body.filters) ? body.filters : undefined,
                limit: typeof body.limit === 'number' ? body.limit : 50,
                random: body.random === true,
                expectedKey: typeof body.expectedKey === 'string' ? body.expectedKey : undefined,
            });
            res.json(result);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            res.status(500).json({ error: 'Failed to probe semantic memory', message });
        }
    }));

    router.patch('/memory/semantic/:key/tags', observeRoute('memory-retag', async (req, res) => {
        const context = contextOrRespond(req, res);
        if (!context) return;
        const requestedAt = new Date();
        const key = req.params.key;
        const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        const tags = Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string') : [];
        try {
            if (!key) {
                res.status(400).json({ error: 'key is required' });
                return;
            }
            if (!reason) {
                await auditOperatorAction(context, {
                    action: 'memory.retag',
                    reason,
                    requestedAt,
                    accepted: false,
                    resultStatus: 'rejected',
                    errorCode: 'REASON_REQUIRED',
                    metadata: { key },
                });
                res.status(400).json({ error: 'reason is required' });
                return;
            }
            const result = await semanticMemoryRepository().retag({ tenantId: context.tenantId, key, tags });
            await auditOperatorAction(context, {
                action: 'memory.retag',
                reason,
                requestedAt,
                accepted: true,
                resultStatus: 'completed',
                metadata: { key, tags },
            });
            res.json(result);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await auditOperatorAction(context, {
                action: 'memory.retag',
                reason,
                requestedAt,
                accepted: false,
                resultStatus: 'failed',
                errorCode: error instanceof Error ? error.name : 'Error',
                metadata: { key },
            }).catch(() => undefined);
            res.status(500).json({ error: 'Failed to retag semantic memory item', message });
        }
    }));

    router.patch('/memory/semantic/:key', observeRoute('memory-update', async (req, res) => {
        const context = contextOrRespond(req, res);
        if (!context) return;
        const requestedAt = new Date();
        const key = req.params.key;
        const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        const nextKey = typeof body.key === 'string' ? body.key.trim() : undefined;
        const hasValue = Object.prototype.hasOwnProperty.call(body, 'value');
        try {
            if (!key) {
                res.status(400).json({ error: 'key is required' });
                return;
            }
            if (!reason) {
                await auditOperatorAction(context, {
                    action: 'memory.update',
                    reason,
                    requestedAt,
                    accepted: false,
                    resultStatus: 'rejected',
                    errorCode: 'REASON_REQUIRED',
                    metadata: { key, nextKey, hasValue },
                });
                res.status(400).json({ error: 'reason is required' });
                return;
            }
            if (nextKey !== undefined && nextKey.length === 0) {
                await auditOperatorAction(context, {
                    action: 'memory.update',
                    reason,
                    requestedAt,
                    accepted: false,
                    resultStatus: 'rejected',
                    errorCode: 'KEY_REQUIRED',
                    metadata: { key, hasValue },
                });
                res.status(400).json({ error: 'new key cannot be empty' });
                return;
            }
            if (nextKey === undefined && !hasValue) {
                res.status(400).json({ error: 'key or value must be provided' });
                return;
            }
            const result = await semanticMemoryRepository().update({
                tenantId: context.tenantId,
                key,
                ...(nextKey !== undefined ? { nextKey } : {}),
                ...(hasValue ? { value: body.value } : {}),
            });
            await auditOperatorAction(context, {
                action: 'memory.update',
                reason,
                requestedAt,
                accepted: true,
                resultStatus: 'completed',
                metadata: { key, nextKey, keyChanged: nextKey !== undefined && nextKey !== key, valueChanged: hasValue },
            });
            res.json(result);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await auditOperatorAction(context, {
                action: 'memory.update',
                reason,
                requestedAt,
                accepted: false,
                resultStatus: 'failed',
                errorCode: error instanceof Error ? error.name : 'Error',
                metadata: { key, nextKey, hasValue },
            }).catch(() => undefined);
            res.status(500).json({ error: 'Failed to update semantic memory item', message });
        }
    }));

    router.delete('/memory/semantic/:key', observeRoute('memory-delete', async (req, res) => {
        const context = contextOrRespond(req, res);
        if (!context) return;
        const requestedAt = new Date();
        const key = req.params.key;
        const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        const confirmKey = typeof body.confirmKey === 'string' ? body.confirmKey : '';
        try {
            if (!key) {
                res.status(400).json({ error: 'key is required' });
                return;
            }
            if (!reason || confirmKey !== key) {
                await auditOperatorAction(context, {
                    action: 'memory.delete',
                    reason,
                    requestedAt,
                    accepted: false,
                    resultStatus: 'rejected',
                    errorCode: !reason ? 'REASON_REQUIRED' : 'CONFIRM_KEY_MISMATCH',
                    metadata: { key },
                });
                res.status(400).json({ error: !reason ? 'reason is required' : 'confirmKey must match key' });
                return;
            }
            const result = await semanticMemoryRepository().delete({ tenantId: context.tenantId, key });
            await auditOperatorAction(context, {
                action: 'memory.delete',
                reason,
                requestedAt,
                accepted: true,
                resultStatus: 'completed',
                metadata: { key },
            });
            res.json(result);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await auditOperatorAction(context, {
                action: 'memory.delete',
                reason,
                requestedAt,
                accepted: false,
                resultStatus: 'failed',
                errorCode: error instanceof Error ? error.name : 'Error',
                metadata: { key },
            }).catch(() => undefined);
            res.status(500).json({ error: 'Failed to delete semantic memory item', message });
        }
    }));

    router.get('/artifacts/:artifactId', observeRoute('artifact-detail', async (req, res) => {
        try {
            const context = contextOrRespond(req, res);
            if (!context) return;
            const artifactId = req.params.artifactId;
            if (artifactId === undefined || artifactId.length === 0 || artifactId === 'local' || artifactId === 'unknown') {
                res.status(400).json({ error: 'artifactId is required' });
                return;
            }
            const engine = EngineLocator.getEngine<TaskEngine>();
            const prisma = engine && typeof (engine as any).getOperatorPrismaClient === 'function'
                ? (engine as any).getOperatorPrismaClient()
                : undefined;
            if (!prisma) {
                res.status(503).json({ error: 'Artifact store is not available' });
                return;
            }
            const cache = new AgentResultCache(prisma as never);
            let value: unknown;
            try {
                value = await cache.loadArtifact(context.tenantId, artifactId);
            } catch {
                res.status(404).json({ error: 'Artifact not found or expired' });
                return;
            }
            const contentType = inferArtifactContentType(value);
            res.json({
                artifactId,
                contentType,
                filename: artifactFilename(artifactId, contentType, value),
                sizeBytes: artifactSizeBytes(value),
                value,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            res.status(500).json({ error: 'Failed to load artifact', message });
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

function inferArtifactContentType(value: unknown): string {
    if (typeof value === 'string') {
        return value.trimStart().startsWith('<') ? 'text/html' : 'text/plain';
    }
    if (value !== null && typeof value === 'object') {
        return 'application/json';
    }
    return 'text/plain';
}

function artifactSizeBytes(value: unknown): number {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    return Buffer.byteLength(serialized ?? '', 'utf8');
}

function artifactFilename(artifactId: string, contentType: string, value: unknown): string {
    const shortId = artifactId.length > 16 ? artifactId.slice(0, 16) : artifactId;
    const safeId = shortId.replace(/[^a-zA-Z0-9_.-]/g, '_') || 'artifact';
    const extension = contentType === 'text/html'
        ? 'html'
        : contentType === 'application/json' || (value !== null && typeof value === 'object')
            ? 'json'
            : 'txt';
    return `artifact-${safeId}.${extension}`;
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

function semanticMemoryRepository(): SemanticMemoryObserverRepository {
    const engine = EngineLocator.getEngine<TaskEngine>();
    const prisma = engine && typeof (engine as any).getOperatorPrismaClient === 'function'
        ? (engine as any).getOperatorPrismaClient()
        : undefined;
    return new SemanticMemoryObserverRepository(prisma as never);
}

function operatorAuditRepository(): OperatorAuditRepository {
    const engine = EngineLocator.getEngine<TaskEngine>();
    const prisma = engine && typeof (engine as any).getOperatorPrismaClient === 'function'
        ? (engine as any).getOperatorPrismaClient()
        : undefined;
    return new OperatorAuditRepository(prisma as never);
}

function stringQuery(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    return undefined;
}

function numberQuery(value: unknown, fallback: number): number {
    const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : undefined;
    return Number.isFinite(parsed) ? parsed! : fallback;
}

function memoryOpQuery(value: unknown): 'read' | 'write' | 'delete' | undefined {
    return value === 'read' || value === 'write' || value === 'delete' ? value : undefined;
}

function isProbeFilter(value: unknown): value is { path: string; operator: string; value: unknown } {
    return !!value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof (value as Record<string, unknown>).path === 'string' &&
        ((value as Record<string, unknown>).path as string).trim().length > 0 &&
        ['=', '!=', 'CONTAINS', 'STARTS_WITH', 'ENDS_WITH'].includes(String((value as Record<string, unknown>).operator));
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
