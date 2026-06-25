import type {
    AgentRunEdge,
    AgentRunEvent,
    AgentRunGraph,
    AgentRunNode,
    AgentRunStatus,
    EffectRun,
    TurnRun,
} from './runGraph.js';

export type OperatorProjectionMode = 'bridge' | 'compare' | 'semantic';
export type OperatorProjectionWriteMode = 'off' | 'shadow' | 'on';

export type SemanticAgentRunListParams = {
    tenantId: string;
    agentId?: string;
    status?: string;
    since?: string;
    cursor?: string;
    limit: number;
    scope: 'roots' | 'all';
};

export type SemanticAgentRunListItem = {
    agentId?: string;
    taskId: string;
    rootTaskId: string;
    status: string;
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
    turns: number;
    children: number;
    llmCalls: number;
    memoryOps?: number;
    costUsd: number;
    error?: unknown;
    traceId?: string;
    providerRunId?: string | null;
};

export type SemanticAgentRunListPage = {
    items: SemanticAgentRunListItem[];
    nextCursor?: string;
    pageInfo?: {
        nextCursor?: string;
        hasMore: boolean;
        limit: number;
    };
    projection?: {
        source: 'bridge' | 'semantic';
        lagMs?: number;
        partial: boolean;
    };
};

type PrismaDelegate = {
    upsert?: (args: Record<string, unknown>) => Promise<unknown>;
    findMany?: (args: Record<string, unknown>) => Promise<unknown[]>;
    count?: (args: Record<string, unknown>) => Promise<number>;
    updateMany?: (args: Record<string, unknown>) => Promise<unknown>;
};

type ProjectionPrisma = {
    agentRun?: PrismaDelegate;
    agentRunEdge?: PrismaDelegate;
    turnRun?: PrismaDelegate;
    runEffect?: PrismaDelegate;
};

const operatorProjectionProfileEnabled = () => process.env.CALLAGENT_OPERATOR_PROFILE === '1';
const operatorProjectionSlowMs = () => {
    const raw = Number.parseInt(process.env.CALLAGENT_OPERATOR_PROFILE_SLOW_MS ?? '', 10);
    return Number.isFinite(raw) && raw >= 0 ? raw : 50;
};

function projectionNow(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
}

function logProjectionProfile(
    operation: string,
    startedAt: number,
    details: Record<string, unknown>,
): void {
    if (!operatorProjectionProfileEnabled()) return;
    const durationMs = projectionNow() - startedAt;
    if (durationMs < operatorProjectionSlowMs()) return;
    console.warn('[OperatorProjectionProfile]', {
        operation,
        durationMs: Number(durationMs.toFixed(1)),
        ...details,
    });
}

const operatorProjectionInFlight = new Map<string, Promise<unknown>>();

function operatorProjectionSingleFlightEnabled(): boolean {
    return process.env.CALLAGENT_OPERATOR_READ_SINGLE_FLIGHT !== '0';
}

async function operatorProjectionSingleFlight<T>(
    key: string,
    factory: () => Promise<T>,
): Promise<T> {
    if (!operatorProjectionSingleFlightEnabled()) {
        return factory();
    }
    const existing = operatorProjectionInFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = factory().finally(() => {
        if (operatorProjectionInFlight.get(key) === promise) {
            operatorProjectionInFlight.delete(key);
        }
    });
    operatorProjectionInFlight.set(key, promise);
    return promise;
}

export type OperatorProjectionEvent = {
    tenantId: string;
    sessionId: string;
    type: string;
    payload: Record<string, unknown>;
    eventId?: string;
    seq?: number;
    createdAt?: Date | string;
};

type SemanticRunRow = {
    id: string;
    tenantId: string;
    taskId: string;
    rootTaskId: string;
    agentId?: string | null;
    scope: string;
    status: string;
    attention?: string | null;
    parentTaskId?: string | null;
    childCount: number;
    turnCount: number;
    llmCallCount: number;
    memoryOpCount: number;
    knownCostUsd?: unknown;
    startedAt?: Date | string | null;
    terminalAt?: Date | string | null;
    durationMs?: number | null;
    terminalCode?: string | null;
    terminalMessage?: string | null;
    outputState?: string | null;
    traceId?: string | null;
    providerRunId?: string | null;
    updatedAt: Date | string;
};

type SemanticEdgeRow = {
    id: string;
    tenantId: string;
    rootTaskId: string;
    parentTaskId: string;
    childTaskId: string;
    parentTurnSeq?: number | null;
    token?: string | null;
    edgeKind: string;
    status: string;
    terminalCode?: string | null;
    terminalMessage?: string | null;
    createdAt: Date | string;
    resolvedAt?: Date | string | null;
};

type SemanticTurnRow = {
    id: string;
    tenantId: string;
    taskId: string;
    rootTaskId: string;
    agentId?: string | null;
    turnSeq: number;
    status: string;
    startedAt?: Date | string | null;
    completedAt?: Date | string | null;
    durationMs?: number | null;
    transitionKind?: string | null;
    boundaryKind?: string | null;
    outputProduced: boolean;
    llmCallCount: number;
    memoryOpCount: number;
    terminalCode?: string | null;
    terminalMessage?: string | null;
    turnTraceId?: string | null;
};

type SemanticEffectRow = {
    id: string;
    tenantId: string;
    rootTaskId: string;
    taskId: string;
    turnSeq?: number | null;
    operation: string;
    status: string;
    token?: string | null;
    providerRunId?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    createdAt: Date | string;
    updatedAt: Date | string;
};

export function readProjectionMode(): OperatorProjectionMode {
    const raw = process.env.CALLAGENT_OPERATOR_PROJECTION_READ;
    return raw === 'compare' || raw === 'semantic' ? raw : 'bridge';
}

export function readProjectionWriteMode(): OperatorProjectionWriteMode {
    const raw = process.env.CALLAGENT_OPERATOR_PROJECTION_WRITE;
    return raw === 'off' || raw === 'on' ? raw : 'shadow';
}

export class OperatorProjectionRepository {
    constructor(private readonly prisma: ProjectionPrisma) {}

    isAvailable(): boolean {
        return this.prisma.agentRun !== undefined &&
            this.prisma.agentRunEdge !== undefined &&
            this.prisma.turnRun !== undefined &&
            this.prisma.runEffect !== undefined;
    }

    async projectGraph(graph: AgentRunGraph): Promise<void> {
        if (!this.isAvailable()) return;
        const nodesByTask = new Map(graph.nodes.map((node) => [node.taskId, node]));
        for (const node of graph.nodes) {
            await this.upsertRun(node, graph);
        }
        for (const edge of graph.edges) {
            await this.upsertEdge(edge, graph);
        }
        for (const turn of graph.turns) {
            await this.upsertTurn(turn, nodesByTask, graph);
        }
        for (const effect of graph.effects) {
            await this.upsertEffect(effect, graph);
        }
    }

    async projectListPage(tenantId: string, items: SemanticAgentRunListItem[]): Promise<void> {
        if (!this.isAvailable()) return;
        await Promise.all(items.map(async (item) => {
            const isRoot = item.taskId === item.rootTaskId;
            await this.prisma.agentRun!.upsert!({
                where: { tenantId_taskId: { tenantId, taskId: item.taskId } },
                create: stripUndefined({
                    tenantId,
                    taskId: item.taskId,
                    rootTaskId: item.rootTaskId,
                    agentId: item.agentId,
                    operation: 'agent.run',
                    scope: isRoot ? 'root' : 'child',
                    status: normalizeStatus(item.status),
                    childCount: item.children,
                    turnCount: item.turns,
                    llmCallCount: item.llmCalls,
                    memoryOpCount: item.memoryOps ?? 0,
                    knownCostUsd: item.costUsd,
                    startedAt: item.startedAt ? new Date(item.startedAt) : undefined,
                    terminalAt: item.finishedAt ? new Date(item.finishedAt) : undefined,
                    durationMs: item.durationMs,
                    terminalCode: errorCode(item.error),
                    terminalMessage: errorMessage(item.error),
                    outputState: 'not_captured',
                    traceId: item.traceId,
                    providerRunId: item.providerRunId ?? undefined,
                }),
                update: stripUndefined({
                    rootTaskId: item.rootTaskId,
                    agentId: item.agentId,
                    scope: isRoot ? 'root' : 'child',
                    status: normalizeStatus(item.status),
                    childCount: item.children,
                    turnCount: item.turns,
                    llmCallCount: item.llmCalls,
                    memoryOpCount: item.memoryOps ?? 0,
                    knownCostUsd: item.costUsd,
                    startedAt: item.startedAt ? new Date(item.startedAt) : undefined,
                    terminalAt: item.finishedAt ? new Date(item.finishedAt) : undefined,
                    durationMs: item.durationMs,
                    terminalCode: errorCode(item.error),
                    terminalMessage: errorMessage(item.error),
                    traceId: item.traceId,
                    providerRunId: item.providerRunId ?? undefined,
                }),
            });
        }));
    }

    async projectEvent(event: OperatorProjectionEvent): Promise<void> {
        if (!this.isAvailable()) return;
        const createdAt = event.createdAt ? new Date(event.createdAt) : new Date();
        const taskId = stringField(event.payload, 'taskId') ?? event.sessionId;
        const agentId = stringField(event.payload, 'agentId') ?? stringField(event.payload, 'childAgentId');
        const traceId = stringField(event.payload, 'traceparent') ?? stringField(event.payload, 'traceId');
        const parentRootTaskId = await this.parentRootTaskId(event.tenantId, event.sessionId);
        const rootTaskId = stringField(event.payload, 'rootTaskId') ?? parentRootTaskId ?? event.sessionId;

        if (event.type === 'task.started') {
            const existingRootTaskId = parentRootTaskId ?? taskId;
            await this.upsertEventRun({
                tenantId: event.tenantId,
                taskId,
                rootTaskId: existingRootTaskId,
                agentId,
                scope: existingRootTaskId === taskId ? 'root' : 'child',
                status: 'running',
                startedAt: createdAt,
                traceId,
                outputState: 'not_captured',
            });
            return;
        }

        if (event.type === 'task.completed') {
            await this.upsertEventRun({
                tenantId: event.tenantId,
                taskId,
                rootTaskId: parentRootTaskId ?? taskId,
                status: 'completed',
                terminalAt: createdAt,
                traceId,
                outputState: numberField(event.payload, 'artifactsCount') > 0 ? 'artifact_metadata' : undefined,
            });
            await this.resolveEdgesForTerminalChild({
                tenantId: event.tenantId,
                childTaskId: taskId,
                status: 'completed',
                resolvedAt: createdAt,
            });
            return;
        }

        if (event.type === 'task.failed') {
            const error = event.payload.error;
            await this.upsertEventRun({
                tenantId: event.tenantId,
                taskId,
                rootTaskId: parentRootTaskId ?? taskId,
                status: 'failed',
                terminalAt: createdAt,
                traceId,
                terminalCode: errorCode(error),
                terminalMessage: errorMessage(error) ?? (typeof error === 'string' ? error : undefined),
            });
            await this.resolveEdgesForTerminalChild({
                tenantId: event.tenantId,
                childTaskId: taskId,
                status: 'failed',
                resolvedAt: createdAt,
                terminalCode: errorCode(error),
                terminalMessage: errorMessage(error) ?? (typeof error === 'string' ? error : undefined),
            });
            return;
        }

        if (event.type === 'task.child_started') {
            const childTaskId = stringField(event.payload, 'childTaskId');
            if (!childTaskId) return;
            const childAgentId = stringField(event.payload, 'childAgentId') ?? stringField(event.payload, 'agentId');
            const token = stringField(event.payload, 'token') ?? '';
            await this.upsertEventRun({
                tenantId: event.tenantId,
                taskId: event.sessionId,
                rootTaskId,
                status: 'waiting',
            });
            await this.upsertEventRun({
                tenantId: event.tenantId,
                taskId: childTaskId,
                rootTaskId,
                parentTaskId: event.sessionId,
                agentId: childAgentId,
                scope: 'child',
                status: 'queued',
                startedAt: createdAt,
                outputState: 'not_captured',
            });
            await this.upsertEventEdge({
                tenantId: event.tenantId,
                rootTaskId,
                parentTaskId: event.sessionId,
                childTaskId,
                token,
                status: 'running',
                createdAt,
            });
            return;
        }

        if (event.type === 'task.child_completed' || event.type === 'task.child_failed') {
            const childTaskId = stringField(event.payload, 'childTaskId');
            if (!childTaskId) return;
            const failed = event.type === 'task.child_failed';
            const childAgentId = stringField(event.payload, 'childAgentId') ?? stringField(event.payload, 'agentId');
            const token = stringField(event.payload, 'token') ?? '';
            const error = event.payload.error;
            await this.upsertEventRun({
                tenantId: event.tenantId,
                taskId: childTaskId,
                rootTaskId,
                parentTaskId: event.sessionId,
                agentId: childAgentId,
                scope: 'child',
                status: failed ? 'failed' : 'completed',
                terminalAt: createdAt,
                terminalCode: failed ? errorCode(error) : undefined,
                terminalMessage: failed ? errorMessage(error) ?? (typeof error === 'string' ? error : undefined) : undefined,
            });
            await this.upsertEventEdge({
                tenantId: event.tenantId,
                rootTaskId,
                parentTaskId: event.sessionId,
                childTaskId,
                token,
                status: failed ? 'failed' : 'completed',
                resolvedAt: createdAt,
                terminalCode: failed ? errorCode(error) : undefined,
                terminalMessage: failed ? errorMessage(error) ?? (typeof error === 'string' ? error : undefined) : undefined,
            });
            return;
        }

        if (event.type === 'turn.started') {
            const turnSeq = numberField(event.payload, 'turnSeq');
            if (turnSeq <= 0) return;
            await this.upsertEventTurn({
                tenantId: event.tenantId,
                taskId,
                rootTaskId,
                agentId,
                turnSeq,
                status: 'running',
                startedAt: createdAt,
                turnTraceId: stringField(event.payload, 'turnId'),
            });
            await this.upsertEventRun({
                tenantId: event.tenantId,
                taskId,
                rootTaskId,
                agentId,
                status: 'running',
            });
            return;
        }

        if (event.type === 'turn.completed') {
            const turnSeq = numberField(event.payload, 'turnSeq');
            if (turnSeq <= 0) return;
            const transition = event.payload.transition;
            const transitionKindValue = transitionKind(transition);
            const boundary = isAwaitBoundaryKind(transitionKindValue) ? transitionKindValue : undefined;
            const semanticError = eventHasOkFalse(transition);
            const output = outputProduced({ cognition: { transition }, status: 'completed' } as TurnRun);
            await this.upsertEventTurn({
                tenantId: event.tenantId,
                taskId,
                rootTaskId,
                agentId,
                turnSeq,
                status: semanticError ? 'failed' : 'completed',
                completedAt: createdAt,
                transitionKind: transitionKindValue,
                boundaryKind: boundary,
                outputProduced: output,
                llmCallCount: arrayCount(event.payload.llmCalls),
                memoryOpCount: 0,
                knownCostUsd: costFromUsage(event.payload.usage),
                terminalCode: semanticError ? errorCode(transition) : undefined,
                terminalMessage: semanticError ? errorMessage(transition) : undefined,
                turnTraceId: stringField(event.payload, 'turnId'),
            });
            const runStatus = semanticError ? 'failed' : boundary ? 'waiting' : transitionKindValue === 'complete' ? 'completed' : 'running';
            await this.upsertEventRun({
                tenantId: event.tenantId,
                taskId,
                rootTaskId,
                agentId,
                status: runStatus,
                terminalAt: semanticError || transitionKindValue === 'complete' ? createdAt : undefined,
                terminalCode: semanticError ? errorCode(transition) : undefined,
                terminalMessage: semanticError ? errorMessage(transition) : undefined,
                outputState: output ? 'available' : undefined,
            });
            if (semanticError || transitionKindValue === 'complete') {
                await this.resolveEdgesForTerminalChild({
                    tenantId: event.tenantId,
                    childTaskId: taskId,
                    status: runStatus,
                    resolvedAt: createdAt,
                    terminalCode: semanticError ? errorCode(transition) : undefined,
                    terminalMessage: semanticError ? errorMessage(transition) : undefined,
                });
            }
            return;
        }

        if (event.type.startsWith('memory.')) {
            await this.upsertEventEffect({
                tenantId: event.tenantId,
                rootTaskId,
                taskId,
                operation: event.type,
                status: 'completed',
                idempotencyKey: `${event.tenantId}:${event.sessionId}:${event.eventId ?? event.type}:${event.seq ?? 'unknown'}`,
            });
            return;
        }

        if (event.type === 'payload.budget_exceeded') {
            const code = stringField(event.payload, 'code') ?? 'LIMIT_OPERATOR_RESPONSE_TOO_LARGE';
            const message = stringField(event.payload, 'message') ?? 'Payload exceeded configured budget.';
            await this.upsertEventEffect({
                tenantId: event.tenantId,
                rootTaskId,
                taskId,
                operation: 'payload.budget',
                status: 'failed',
                idempotencyKey: `${event.tenantId}:${event.sessionId}:${event.eventId ?? event.type}:${event.seq ?? 'unknown'}`,
                errorCode: code,
                errorMessage: message,
            });
            return;
        }

        if (event.type === 'wm.snapshot_limit') {
            await this.upsertEventEffect({
                tenantId: event.tenantId,
                rootTaskId,
                taskId,
                operation: 'wm.snapshot_budget',
                status: 'failed',
                idempotencyKey: `${event.tenantId}:${event.sessionId}:${event.eventId ?? event.type}:${event.seq ?? 'unknown'}`,
                errorCode: 'LIMIT_WM_SNAPSHOT_TOO_LARGE',
                errorMessage: 'Working-memory snapshot exceeded the configured size limit.',
            });
            return;
        }

        if (event.type === 'observability.incident') {
            await this.upsertEventEffect({
                tenantId: event.tenantId,
                rootTaskId,
                taskId,
                operation: stringField(event.payload, 'operation') ?? 'observability.incident',
                status: 'failed',
                idempotencyKey: `${event.tenantId}:${event.sessionId}:${event.eventId ?? event.type}:${event.seq ?? 'unknown'}`,
                errorCode: stringField(event.payload, 'errorCode') ?? 'OBSERVABILITY_INCIDENT',
                errorMessage: stringField(event.payload, 'message') ?? 'Observability incident recorded.',
            });
        }
    }

    async listAgentRuns(params: SemanticAgentRunListParams): Promise<SemanticAgentRunListPage | undefined> {
        if (!this.isAvailable()) return undefined;
        return operatorProjectionSingleFlight(
            [
                'agentRuns',
                params.tenantId,
                params.scope,
                params.agentId ?? '',
                params.status ?? '',
                params.since ?? '',
                params.cursor ?? '',
                params.limit,
            ].join('\x1f'),
            () => this.listAgentRunsUncoalesced(params),
        );
    }

    private async listAgentRunsUncoalesced(params: SemanticAgentRunListParams): Promise<SemanticAgentRunListPage | undefined> {
        const profileStartedAt = projectionNow();
        const cursor = decodeCursor(params.cursor);
        const where: Record<string, unknown> = {
            tenantId: params.tenantId,
            ...(params.scope === 'roots' ? { scope: 'root' } : {}),
            ...(params.agentId ? { agentId: params.agentId } : {}),
            ...(params.status ? { status: params.status } : {}),
        };
        if (params.since) {
            const since = new Date(params.since);
            if (!Number.isNaN(since.getTime())) {
                where.updatedAt = { gte: since };
            }
        }
        if (cursor) {
            const cursorDate = new Date(cursor.updatedAt);
            if (!Number.isNaN(cursorDate.getTime())) {
                where.OR = [
                    { updatedAt: { lt: cursorDate } },
                    { updatedAt: cursorDate, id: { lt: cursor.id } },
                ];
            }
        }
        const pageStartedAt = projectionNow();
        const rows = await this.prisma.agentRun!.findMany!({
            where,
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            take: params.limit + 1,
        }) as SemanticRunRow[];
        const pageMs = projectionNow() - pageStartedAt;
        const pageRows = rows.slice(0, params.limit);
        const mapStartedAt = projectionNow();
        const overflow = rows.length > params.limit ? rows[params.limit] : undefined;
        const nextCursor = overflow ? encodeCursor({
            updatedAt: toIso(overflow.updatedAt) ?? new Date().toISOString(),
            id: overflow.id,
        }) : undefined;
        const items = pageRows.map((row) => rowToListItem(row));
        const mapMs = projectionNow() - mapStartedAt;
        logProjectionProfile('listAgentRuns', profileStartedAt, {
            tenantId: params.tenantId,
            scope: params.scope,
            agentId: params.agentId ?? null,
            status: params.status ?? null,
            limit: params.limit,
            rows: rows.length,
            pageRows: pageRows.length,
            pageMs: Number(pageMs.toFixed(1)),
            mapMs: Number(mapMs.toFixed(1)),
        });
        return {
            items,
            ...(nextCursor ? { nextCursor } : {}),
            pageInfo: {
                ...(nextCursor ? { nextCursor } : {}),
                hasMore: nextCursor !== undefined,
                limit: params.limit,
            },
            projection: { source: 'semantic', partial: false },
        };
    }

    async buildGraph(params: { tenantId: string; taskId: string }): Promise<AgentRunGraph | undefined> {
        if (!this.isAvailable()) return undefined;
        return operatorProjectionSingleFlight(
            ['runGraph', params.tenantId, params.taskId].join('\x1f'),
            () => this.buildGraphUncoalesced(params),
        );
    }

    private async buildGraphUncoalesced(params: { tenantId: string; taskId: string }): Promise<AgentRunGraph | undefined> {
        const profileStartedAt = projectionNow();
        const runsStartedAt = projectionNow();
        const runs = await this.prisma.agentRun!.findMany!({
            where: { tenantId: params.tenantId, rootTaskId: params.taskId },
            orderBy: [{ startedAt: 'asc' }, { updatedAt: 'asc' }],
        }) as SemanticRunRow[];
        const runsMs = projectionNow() - runsStartedAt;
        const root = runs.find((run) => run.taskId === params.taskId);
        if (!root) return undefined;
        const joinStartedAt = projectionNow();
        const [edges, turns, effects] = await Promise.all([
            this.prisma.agentRunEdge!.findMany!({
                where: { tenantId: params.tenantId, rootTaskId: params.taskId },
                orderBy: [{ createdAt: 'asc' }],
            }) as Promise<SemanticEdgeRow[]>,
            this.prisma.turnRun!.findMany!({
                where: { tenantId: params.tenantId, rootTaskId: params.taskId },
                orderBy: [{ taskId: 'asc' }, { turnSeq: 'asc' }],
            }) as Promise<SemanticTurnRow[]>,
            this.prisma.runEffect!.findMany!({
                where: { tenantId: params.tenantId, rootTaskId: params.taskId },
                orderBy: [{ createdAt: 'asc' }],
            }) as Promise<SemanticEffectRow[]>,
        ]);
        const joinMs = projectionNow() - joinStartedAt;
        const mapStartedAt = projectionNow();
        const nodes = runs.map(rowToNode);
        const expectedTurnCount = runs.reduce((sum, run) => sum + Math.max(0, run.turnCount ?? 0), 0);
        const expectedEdgeCount = runs.reduce((sum, run) => sum + Math.max(0, run.childCount ?? 0), 0);
        const partial = turns.length < expectedTurnCount || edges.length < expectedEdgeCount;
        const graph: AgentRunGraph = {
            schemaVersion: 1,
            tenantId: params.tenantId,
            taskId: params.taskId,
            root: rowToNode(root),
            nodes,
            edges: edges.map(rowToEdge),
            turns: turns.map(rowToTurn),
            memoryOps: [],
            effects: effects.map(rowToEffect),
            events: [],
            debug: { driverRuns: [] },
            projection: { source: 'semantic', partial },
        };
        const mapMs = projectionNow() - mapStartedAt;
        logProjectionProfile('buildGraph', profileStartedAt, {
            tenantId: params.tenantId,
            taskId: params.taskId,
            runs: runs.length,
            edges: edges.length,
            turns: turns.length,
            effects: effects.length,
            runsMs: Number(runsMs.toFixed(1)),
            joinMs: Number(joinMs.toFixed(1)),
            mapMs: Number(mapMs.toFixed(1)),
        });
        return graph;
    }

    private async parentRootTaskId(tenantId: string, taskId: string): Promise<string | undefined> {
        const rows = await this.prisma.agentRun!.findMany!({
            where: { tenantId, taskId },
            take: 1,
        }) as SemanticRunRow[];
        return rows[0]?.rootTaskId;
    }

    private async upsertEventRun(params: {
        tenantId: string;
        taskId: string;
        rootTaskId: string;
        agentId?: string;
        scope?: 'root' | 'child';
        status: string;
        parentTaskId?: string;
        startedAt?: Date;
        terminalAt?: Date;
        terminalCode?: string;
        terminalMessage?: string;
        traceId?: string;
        outputState?: string;
    }): Promise<void> {
        const data = stripUndefined({
            rootTaskId: params.rootTaskId,
            agentId: params.agentId,
            operation: 'agent.run',
            scope: params.scope ?? (params.taskId === params.rootTaskId ? 'root' : 'child'),
            status: normalizeStatus(params.status),
            parentTaskId: params.parentTaskId,
            startedAt: params.startedAt,
            terminalAt: params.terminalAt,
            durationMs: params.startedAt && params.terminalAt ? Math.max(0, params.terminalAt.getTime() - params.startedAt.getTime()) : undefined,
            terminalCode: params.terminalCode,
            terminalMessage: params.terminalMessage,
            traceId: params.traceId,
            outputState: params.outputState,
        });
        await this.prisma.agentRun!.upsert!({
            where: { tenantId_taskId: { tenantId: params.tenantId, taskId: params.taskId } },
            create: {
                tenantId: params.tenantId,
                taskId: params.taskId,
                ...data,
            },
            update: data,
        });
    }

    private async upsertEventEdge(params: {
        tenantId: string;
        rootTaskId: string;
        parentTaskId: string;
        childTaskId: string;
        token: string;
        status: string;
        createdAt?: Date;
        resolvedAt?: Date;
        terminalCode?: string;
        terminalMessage?: string;
    }): Promise<void> {
        const token = params.token ?? '';
        const data = stripUndefined({
            rootTaskId: params.rootTaskId,
            edgeKind: 'delegates_to',
            status: normalizeStatus(params.status),
            token,
            resolvedAt: params.resolvedAt,
            terminalCode: params.terminalCode,
            terminalMessage: params.terminalMessage,
        });
        await this.prisma.agentRunEdge!.upsert!({
            where: {
                tenantId_parentTaskId_childTaskId_token: {
                    tenantId: params.tenantId,
                    parentTaskId: params.parentTaskId,
                    childTaskId: params.childTaskId,
                    token,
                },
            },
            create: {
                tenantId: params.tenantId,
                parentTaskId: params.parentTaskId,
                childTaskId: params.childTaskId,
                createdAt: params.createdAt,
                ...data,
            },
            update: data,
        });
    }

    private async resolveEdgesForTerminalChild(params: {
        tenantId: string;
        childTaskId: string;
        status: string;
        resolvedAt: Date;
        terminalCode?: string;
        terminalMessage?: string;
    }): Promise<void> {
        const updateMany = this.prisma.agentRunEdge?.updateMany;
        if (typeof updateMany !== 'function') return;
        await updateMany({
            where: {
                tenantId: params.tenantId,
                childTaskId: params.childTaskId,
            },
            data: stripUndefined({
                status: normalizeStatus(params.status),
                resolvedAt: params.resolvedAt,
                terminalCode: params.terminalCode,
                terminalMessage: params.terminalMessage,
            }),
        });
    }

    private async upsertEventTurn(params: {
        tenantId: string;
        taskId: string;
        rootTaskId: string;
        agentId?: string;
        turnSeq: number;
        status: string;
        startedAt?: Date;
        completedAt?: Date;
        transitionKind?: string;
        boundaryKind?: string;
        outputProduced?: boolean;
        llmCallCount?: number;
        memoryOpCount?: number;
        knownCostUsd?: number;
        terminalCode?: string;
        terminalMessage?: string;
        turnTraceId?: string;
    }): Promise<void> {
        const data = stripUndefined({
            rootTaskId: params.rootTaskId,
            agentId: params.agentId,
            status: normalizeStatus(params.status),
            startedAt: params.startedAt,
            completedAt: params.completedAt,
            durationMs: params.startedAt && params.completedAt ? Math.max(0, params.completedAt.getTime() - params.startedAt.getTime()) : undefined,
            transitionKind: params.transitionKind,
            boundaryKind: params.boundaryKind,
            outputProduced: params.outputProduced,
            llmCallCount: params.llmCallCount,
            memoryOpCount: params.memoryOpCount,
            knownCostUsd: params.knownCostUsd,
            terminalCode: params.terminalCode,
            terminalMessage: params.terminalMessage,
            turnTraceId: params.turnTraceId,
        });
        await this.prisma.turnRun!.upsert!({
            where: { tenantId_taskId_turnSeq: { tenantId: params.tenantId, taskId: params.taskId, turnSeq: params.turnSeq } },
            create: {
                tenantId: params.tenantId,
                taskId: params.taskId,
                turnSeq: params.turnSeq,
                ...data,
            },
            update: data,
        });
    }

    private async upsertEventEffect(params: {
        tenantId: string;
        rootTaskId: string;
        taskId: string;
        operation: string;
        status: string;
        idempotencyKey: string;
        errorCode?: string;
        errorMessage?: string;
    }): Promise<void> {
        const data = stripUndefined({
            rootTaskId: params.rootTaskId,
            taskId: params.taskId,
            operation: params.operation,
            status: normalizeStatus(params.status),
            idempotencyKey: params.idempotencyKey,
            errorCode: params.errorCode,
            errorMessage: params.errorMessage,
        });
        await this.prisma.runEffect!.upsert!({
            where: { idempotencyKey: params.idempotencyKey },
            create: {
                tenantId: params.tenantId,
                ...data,
            },
            update: data,
        });
    }

    private async upsertRun(node: AgentRunNode, graph: AgentRunGraph): Promise<void> {
        const isRoot = node.taskId === graph.root.taskId;
        const turns = graph.turns.filter((turn) => turn.taskId === node.taskId);
        const childCount = graph.edges.filter((edge) => edge.parentTaskId === node.taskId && edge.childTaskId !== undefined).length;
        const llmCallCount = turns.reduce((count, turn) => count + (Array.isArray(turn.llmCalls) ? turn.llmCalls.length : 0), 0);
        const memoryOpCount = turns.reduce((count, turn) => count + (Array.isArray(turn.memoryOps) ? turn.memoryOps.length : 0), 0);
        const terminalAt = node.finishedAt ? new Date(node.finishedAt) : undefined;
        const startedAt = node.startedAt ? new Date(node.startedAt) : undefined;
        const data = stripUndefined({
            rootTaskId: node.rootTaskId,
            agentId: node.agentId,
            operation: 'agent.run',
            scope: isRoot ? 'root' : 'child',
            status: normalizeStatus(node.status),
            parentTaskId: node.parentTaskId,
            childCount,
            turnCount: turns.length,
            llmCallCount,
            memoryOpCount,
            startedAt,
            terminalAt,
            durationMs: startedAt && terminalAt ? Math.max(0, terminalAt.getTime() - startedAt.getTime()) : undefined,
            terminalCode: errorCode(node.error),
            terminalMessage: errorMessage(node.error),
            cancelReason: node.cancellation?.reason,
            outputState: node.outputPreview === undefined ? 'not_captured' : 'available',
            traceId: node.traceId,
            providerRunId: node.providerRunId,
        });
        await this.prisma.agentRun!.upsert!({
            where: { tenantId_taskId: { tenantId: node.tenantId, taskId: node.taskId } },
            create: {
                tenantId: node.tenantId,
                taskId: node.taskId,
                ...data,
            },
            update: data,
        });
    }

    private async upsertEdge(edge: AgentRunEdge, graph: AgentRunGraph): Promise<void> {
        if (!edge.childTaskId) return;
        const data = stripUndefined({
            rootTaskId: edge.rootTaskId,
            parentTurnSeq: parentTurnSeq(graph, edge.parentTaskId, edge.childTaskId),
            edgeKind: edge.edgeKind,
            status: normalizeStatus(edge.status),
            token: edge.token ?? edge.edgeToken ?? '',
            terminalCode: errorCode(edge.error),
            terminalMessage: errorMessage(edge.error),
            resolvedAt: edge.finishedAt ? new Date(edge.finishedAt) : undefined,
        });
        await this.prisma.agentRunEdge!.upsert!({
            where: {
                tenantId_parentTaskId_childTaskId_token: {
                    tenantId: graph.tenantId,
                    parentTaskId: edge.parentTaskId,
                    childTaskId: edge.childTaskId,
                    token: edge.token ?? edge.edgeToken ?? '',
                },
            },
            create: {
                tenantId: graph.tenantId,
                parentTaskId: edge.parentTaskId,
                childTaskId: edge.childTaskId,
                ...data,
            },
            update: data,
        });
    }

    private async upsertTurn(turn: TurnRun, nodesByTask: Map<string, AgentRunNode>, graph: AgentRunGraph): Promise<void> {
        const turnSeq = turn.turnSeq ?? 0;
        if (turnSeq <= 0) return;
        const node = nodesByTask.get(turn.taskId);
        const transition = turn.cognition?.transition;
        const data = stripUndefined({
            rootTaskId: turn.rootTaskId,
            agentId: turn.agentId ?? node?.agentId,
            status: normalizeStatus(turn.status),
            startedAt: turn.startedAt ? new Date(turn.startedAt) : undefined,
            completedAt: turn.finishedAt ? new Date(turn.finishedAt) : undefined,
            durationMs: durationMs(turn.startedAt, turn.finishedAt),
            transitionKind: transitionKind(transition),
            boundaryKind: turn.boundaryKind,
            outputProduced: outputProduced(turn),
            llmCallCount: Array.isArray(turn.llmCalls) ? turn.llmCalls.length : 0,
            memoryOpCount: Array.isArray(turn.memoryOps) ? turn.memoryOps.length : 0,
            terminalCode: errorCode(turn.error),
            terminalMessage: errorMessage(turn.error),
            turnTraceId: turn.turnTraceRef?.turnTraceId,
        });
        await this.prisma.turnRun!.upsert!({
            where: { tenantId_taskId_turnSeq: { tenantId: graph.tenantId, taskId: turn.taskId, turnSeq } },
            create: {
                tenantId: graph.tenantId,
                taskId: turn.taskId,
                turnSeq,
                ...data,
            },
            update: data,
        });
    }

    private async upsertEffect(effect: EffectRun, graph: AgentRunGraph): Promise<void> {
        const taskId = effect.taskId ?? graph.taskId;
        const idempotencyKey = `${graph.tenantId}:${effect.id}`;
        const data = stripUndefined({
            rootTaskId: effect.rootTaskId,
            taskId,
            operation: effect.operation,
            status: normalizeStatus(effect.status),
            idempotencyKey,
            token: effect.token,
            providerRunId: effect.providerRunId,
            errorCode: errorCode(effect.error),
            errorMessage: errorMessage(effect.error),
        });
        await this.prisma.runEffect!.upsert!({
            where: { idempotencyKey },
            create: {
                tenantId: graph.tenantId,
                ...data,
            },
            update: data,
        });
    }
}

function rowToListItem(
    row: SemanticRunRow,
    overrides: { children?: number; turns?: number; llmCalls?: number; memoryOps?: number } = {}
): SemanticAgentRunListItem {
    return {
        ...(row.agentId ? { agentId: row.agentId } : {}),
        taskId: row.taskId,
        rootTaskId: row.rootTaskId,
        status: row.status,
        ...(row.startedAt ? { startedAt: toIso(row.startedAt) } : {}),
        ...(row.terminalAt ? { finishedAt: toIso(row.terminalAt) } : {}),
        ...(typeof row.durationMs === 'number' ? { durationMs: row.durationMs } : {}),
        turns: overrides.turns ?? row.turnCount,
        children: overrides.children ?? row.childCount,
        llmCalls: overrides.llmCalls ?? row.llmCallCount,
        memoryOps: overrides.memoryOps ?? row.memoryOpCount,
        costUsd: decimalToNumber(row.knownCostUsd),
        ...(row.terminalCode || row.terminalMessage ? { error: { code: row.terminalCode, message: row.terminalMessage } } : {}),
        ...(row.traceId ? { traceId: row.traceId } : {}),
        ...(row.providerRunId ? { providerRunId: row.providerRunId } : {}),
    };
}

function rowToNode(row: SemanticRunRow): AgentRunNode {
    return {
        id: row.taskId,
        kind: 'agent',
        tenantId: row.tenantId,
        rootTaskId: row.rootTaskId,
        taskId: row.taskId,
        ...(row.agentId ? { agentId: row.agentId } : {}),
        ...(row.scope === 'child' ? { parentTaskId: row.parentTaskId ?? undefined } : {}),
        status: normalizeStatus(row.status),
        ...(row.terminalCode || row.terminalMessage ? { error: { code: row.terminalCode, message: row.terminalMessage } } : {}),
        ...(row.traceId ? { traceId: row.traceId } : {}),
        ...(row.providerRunId ? { providerRunId: row.providerRunId } : {}),
        ...(row.startedAt ? { startedAt: toIso(row.startedAt) } : {}),
        ...(row.terminalAt ? { finishedAt: toIso(row.terminalAt) } : {}),
    };
}

function rowToEdge(row: SemanticEdgeRow): AgentRunEdge {
    return {
        id: row.id,
        kind: 'agent-child',
        rootTaskId: row.rootTaskId,
        parentTaskId: row.parentTaskId,
        childTaskId: row.childTaskId,
        token: row.token ?? undefined,
        edgeToken: row.token ?? undefined,
        edgeKind: 'delegates_to',
        status: normalizeStatus(row.status),
        ...(row.terminalCode || row.terminalMessage ? { error: { code: row.terminalCode, message: row.terminalMessage } } : {}),
        startedAt: toIso(row.createdAt),
        ...(row.resolvedAt ? { finishedAt: toIso(row.resolvedAt) } : {}),
    };
}

function rowToTurn(row: SemanticTurnRow): TurnRun {
    return {
        id: row.id,
        rootTaskId: row.rootTaskId,
        taskId: row.taskId,
        ...(row.agentId ? { agentId: row.agentId } : {}),
        status: normalizeStatus(row.status),
        operation: 'turn.segment',
        turnSeq: row.turnSeq,
        ...(row.boundaryKind ? { boundaryKind: row.boundaryKind } : {}),
        ...(row.startedAt ? { startedAt: toIso(row.startedAt) } : {}),
        ...(row.completedAt ? { finishedAt: toIso(row.completedAt) } : {}),
        ...(row.terminalCode || row.terminalMessage ? { error: { code: row.terminalCode, message: row.terminalMessage } } : {}),
        ...(row.turnTraceId ? { turnTraceRef: { turnTraceId: row.turnTraceId } } : {}),
    };
}

function rowToEffect(row: SemanticEffectRow): EffectRun {
    return {
        id: row.id,
        rootTaskId: row.rootTaskId,
        taskId: row.taskId,
        operation: row.operation,
        status: normalizeStatus(row.status),
        ...(row.token ? { token: row.token } : {}),
        ...(row.providerRunId ? { providerRunId: row.providerRunId } : {}),
        hiddenByDefault: true,
        ...(row.errorCode || row.errorMessage ? { error: { code: row.errorCode, message: row.errorMessage } } : {}),
    };
}

function parentTurnSeq(graph: AgentRunGraph, parentTaskId: string, childTaskId: string): number | undefined {
    const matching = graph.turns.find((turn) =>
        turn.taskId === parentTaskId &&
        turn.boundaryKind === 'await_child' &&
        graph.edges.some((edge) => edge.parentTaskId === parentTaskId && edge.childTaskId === childTaskId)
    );
    return matching?.turnSeq;
}

function outputProduced(turn: TurnRun): boolean {
    const transition = turn.cognition?.transition;
    if (!transition || typeof transition !== 'object') return false;
    const kind = (transition as Record<string, unknown>).kind;
    return kind === 'complete';
}

function transitionKind(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const kind = (value as Record<string, unknown>).kind;
    return typeof kind === 'string' ? kind : undefined;
}

function errorCode(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    const code = record.code;
    if (typeof code === 'string') return code;
    const result = record.result;
    if (result && typeof result === 'object') {
        const error = (result as Record<string, unknown>).error;
        if (error && typeof error === 'object') {
            const nestedCode = (error as Record<string, unknown>).code;
            return typeof nestedCode === 'string' ? nestedCode : undefined;
        }
    }
    return undefined;
}

function errorMessage(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') {
        return value instanceof Error ? value.message : undefined;
    }
    const record = value as Record<string, unknown>;
    const message = record.message;
    if (typeof message === 'string') return message;
    const result = record.result;
    if (result && typeof result === 'object') {
        const error = (result as Record<string, unknown>).error;
        if (error && typeof error === 'object') {
            const nestedMessage = (error as Record<string, unknown>).message;
            return typeof nestedMessage === 'string' ? nestedMessage : undefined;
        }
    }
    return undefined;
}

function eventHasOkFalse(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const result = (value as Record<string, unknown>).result;
    return !!result && typeof result === 'object' && (result as Record<string, unknown>).ok === false;
}

function isAwaitBoundaryKind(value: string | undefined): boolean {
    return value === 'await_input' || value === 'await_tool' || value === 'await_child' || value === 'await_event';
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
    const field = value[key];
    return typeof field === 'string' && field.length > 0 ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number {
    const field = value[key];
    return typeof field === 'number' && Number.isFinite(field) ? field : 0;
}

function arrayCount(value: unknown): number {
    return Array.isArray(value) ? value.length : 0;
}

function costFromUsage(value: unknown): number | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const totalCost = (value as Record<string, unknown>).totalCost;
    return typeof totalCost === 'number' && Number.isFinite(totalCost) ? totalCost : undefined;
}

function normalizeStatus(status: string): AgentRunStatus {
    switch (status) {
        case 'queued':
        case 'running':
        case 'waiting':
        case 'completed':
        case 'failed':
        case 'canceled':
            return status;
        case 'cancelled':
            return 'canceled';
        default:
            return 'unknown';
    }
}

function toIso(value: Date | string | null | undefined): string | undefined {
    if (!value) return undefined;
    if (value instanceof Date) return value.toISOString();
    return value;
}

function durationMs(start: string | undefined, end: string | undefined): number | undefined {
    if (!start || !end) return undefined;
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();
    return Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : undefined;
}

function decimalToNumber(value: unknown): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    if (value && typeof value === 'object' && 'toString' in value) {
        const parsed = Number(String(value));
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

type CursorValue = { updatedAt: string; id: string };

function encodeCursor(cursor: CursorValue): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string | undefined): CursorValue | undefined {
    if (!value) return undefined;
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
        if (!parsed || typeof parsed !== 'object') return undefined;
        const record = parsed as Record<string, unknown>;
        return typeof record.updatedAt === 'string' && typeof record.id === 'string'
            ? { updatedAt: record.updatedAt, id: record.id }
            : undefined;
    } catch {
        return undefined;
    }
}
