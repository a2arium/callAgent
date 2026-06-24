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
};

type ProjectionPrisma = {
    agentRun?: PrismaDelegate;
    agentRunEdge?: PrismaDelegate;
    turnRun?: PrismaDelegate;
    runEffect?: PrismaDelegate;
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
        await Promise.all(graph.nodes.map((node) => this.upsertRun(node, graph)));
        await Promise.all(graph.edges.map((edge) => this.upsertEdge(edge, graph)));
        await Promise.all(graph.turns.map((turn) => this.upsertTurn(turn, nodesByTask, graph)));
        await Promise.all(graph.effects.map((effect) => this.upsertEffect(effect, graph)));
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

    async listAgentRuns(params: SemanticAgentRunListParams): Promise<SemanticAgentRunListPage | undefined> {
        if (!this.isAvailable()) return undefined;
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
        const rows = await this.prisma.agentRun!.findMany!({
            where,
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            take: params.limit + 1,
        }) as SemanticRunRow[];
        const pageRows = rows.slice(0, params.limit);
        const overflow = rows.length > params.limit ? rows[params.limit] : undefined;
        const nextCursor = overflow ? encodeCursor({
            updatedAt: toIso(overflow.updatedAt) ?? new Date().toISOString(),
            id: overflow.id,
        }) : undefined;
        return {
            items: pageRows.map(rowToListItem),
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
        const runs = await this.prisma.agentRun!.findMany!({
            where: { tenantId: params.tenantId, rootTaskId: params.taskId },
            orderBy: [{ startedAt: 'asc' }, { updatedAt: 'asc' }],
        }) as SemanticRunRow[];
        const root = runs.find((run) => run.taskId === params.taskId);
        if (!root) return undefined;
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
        const nodes = runs.map(rowToNode);
        return {
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
            projection: { source: 'semantic', partial: false },
        };
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

function rowToListItem(row: SemanticRunRow): SemanticAgentRunListItem {
    return {
        ...(row.agentId ? { agentId: row.agentId } : {}),
        taskId: row.taskId,
        rootTaskId: row.rootTaskId,
        status: row.status,
        ...(row.startedAt ? { startedAt: toIso(row.startedAt) } : {}),
        ...(row.terminalAt ? { finishedAt: toIso(row.terminalAt) } : {}),
        ...(typeof row.durationMs === 'number' ? { durationMs: row.durationMs } : {}),
        turns: row.turnCount,
        children: row.childCount,
        llmCalls: row.llmCallCount,
        memoryOps: row.memoryOpCount,
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
    const code = (value as Record<string, unknown>).code;
    return typeof code === 'string' ? code : undefined;
}

function errorMessage(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') {
        return value instanceof Error ? value.message : undefined;
    }
    const message = (value as Record<string, unknown>).message;
    return typeof message === 'string' ? message : undefined;
}

function normalizeStatus(status: string): AgentRunStatus {
    switch (status) {
        case 'queued':
        case 'running':
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
