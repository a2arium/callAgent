import type {
    AgentRunEdge,
    AgentRunEvent,
    AgentRunGraph,
    AgentRunNode,
    AgentRunStatus,
    EffectRun,
    TurnAttemptRun,
    TurnRun,
} from './runGraph.js';
import { canonicalTurnAttemptKey, groupTurnAttempts, severityForStatus } from './runGraph.js';
import { readDurableTaskTerminal, readTaskLifecycle } from '../orchestration/TaskLifecycle.js';
import {
    readTaskSubmissionMetadata,
    type TaskSubmissionOrigin,
} from '../orchestration/TaskSubmission.js';

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
    taskId?: string;
    hasLlm?: boolean;
    hasMemory?: boolean;
    costState?: 'captured' | 'missing';
    scheduleId?: string;
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
    origin?: TaskSubmissionOrigin;
};

export type SemanticAgentRunListPage = {
    items: SemanticAgentRunListItem[];
    nextCursor?: string;
    summary?: SemanticAgentRunListSummary;
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

export type SemanticAgentRunListSummary = {
    total: number;
    failed: number;
    waiting: number;
    stuck: number;
    completed: number;
    costCaptured: number;
    costUnavailable: number;
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
    cognitiveTurnRun?: PrismaDelegate;
    runEffect?: PrismaDelegate;
    wMSession?: {
        findMany?: (args: Record<string, unknown>) => Promise<Array<{
            tenantId: string;
            sessionId: string;
            agentId: string;
            snapshot: unknown;
        }>>;
    };
    wMEvent?: PrismaDelegate;
};

export type TerminalProjectionReconciliationCursor = {
    tenantId: string;
    sessionId: string;
};

export type TerminalProjectionReconciliationSummary = {
    scanned: number;
    reconciled: number;
    batches: number;
};

export type CognitiveProjectionReconciliationSummary = {
    scanned: number;
    projected: number;
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
const TERMINAL_AGENT_RUN_STATUSES = new Set(['completed', 'failed', 'canceled']);

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
    cancelReason?: string | null;
    outputState?: string | null;
    traceId?: string | null;
    providerRunId?: string | null;
    originKind?: string | null;
    scheduleId?: string | null;
    scheduleOccurrenceId?: string | null;
    submittedByTaskId?: string | null;
    scheduledFor?: Date | string | null;
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
    turnSeq?: number | null;
    attemptKey: string;
    attemptSeq?: number | null;
    disposition?: string | null;
    claimId?: string | null;
    turnFence?: string | null;
    claimedGeneration?: string | null;
    authoritativeTerminal: boolean;
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

type SemanticCognitiveTurnRow = {
    id: string;
    tenantId: string;
    taskId: string;
    rootTaskId: string;
    agentId?: string | null;
    identityKey: string;
    turnId?: string | null;
    cognitionTurnSeq: number;
    segmentSeq?: number | null;
    attemptKey?: string | null;
    claimId?: string | null;
    disposition: string;
    startedAt?: Date | string | null;
    startedAtEstimated: boolean;
    completedAt?: Date | string | null;
    cognition?: unknown;
    llmCalls?: unknown;
    toolCalls?: unknown;
    childCalls?: unknown;
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
            for (const attempt of turn.attempts) {
                await this.upsertTurn(attempt, nodesByTask, graph);
            }
        }
        await this.convergePersistedTerminalTasks(
            graph.tenantId,
            graph.nodes.map((node) => node.taskId),
        );
        for (const effect of graph.effects) {
            await this.upsertEffect(effect, graph);
        }
    }

    async projectAdmission(params: {
        tenantId: string;
        taskId: string;
        agentId: string;
        admittedAt: string;
        origin?: TaskSubmissionOrigin;
    }): Promise<void> {
        const upsert = this.prisma.agentRun?.upsert;
        if (typeof upsert !== 'function') return;
        const startedAt = new Date(params.admittedAt);
        const provenance = {
            originKind: params.origin?.kind,
            scheduleId: params.origin?.scheduleId,
            scheduleOccurrenceId: params.origin?.scheduleOccurrenceId,
            submittedByTaskId: params.origin?.submittedByTaskId,
            scheduledFor: params.origin?.scheduledFor ? new Date(params.origin.scheduledFor) : undefined,
        };
        await upsert({
            where: { tenantId_taskId: { tenantId: params.tenantId, taskId: params.taskId } },
            create: stripUndefined({
                tenantId: params.tenantId,
                taskId: params.taskId,
                rootTaskId: params.taskId,
                agentId: params.agentId,
                operation: 'agent.run',
                scope: 'root',
                status: 'queued',
                startedAt,
                outputState: 'not_captured',
                ...provenance,
            }),
            update: stripUndefined({
                rootTaskId: params.taskId,
                agentId: params.agentId,
                scope: 'root',
                ...provenance,
            }),
        });
    }

    async projectListPage(tenantId: string, items: SemanticAgentRunListItem[]): Promise<void> {
        if (!this.isAvailable()) return;
        await Promise.all(items.map(async (item) => {
            const isRoot = item.taskId === item.rootTaskId;
            const status = normalizeStatus(item.status);
            const existing = await this.findRun(tenantId, item.taskId);
            const preserveTerminal = shouldPreserveTerminal(existing?.status, status);
            const createData = stripUndefined({
                tenantId,
                taskId: item.taskId,
                rootTaskId: item.rootTaskId,
                agentId: item.agentId,
                operation: 'agent.run',
                scope: isRoot ? 'root' : 'child',
                status,
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
                originKind: item.origin?.kind,
                scheduleId: item.origin?.scheduleId,
                scheduleOccurrenceId: item.origin?.scheduleOccurrenceId,
                submittedByTaskId: item.origin?.submittedByTaskId,
                scheduledFor: item.origin?.scheduledFor ? new Date(item.origin.scheduledFor) : undefined,
            });
            const updateData = stripUndefined({
                rootTaskId: item.rootTaskId,
                agentId: item.agentId,
                scope: isRoot ? 'root' : 'child',
                status: preserveTerminal ? undefined : status,
                childCount: item.children,
                turnCount: item.turns,
                llmCallCount: item.llmCalls,
                memoryOpCount: item.memoryOps ?? 0,
                knownCostUsd: item.costUsd,
                startedAt: item.startedAt ? new Date(item.startedAt) : undefined,
                terminalAt: preserveTerminal ? undefined : item.finishedAt ? new Date(item.finishedAt) : undefined,
                durationMs: preserveTerminal ? undefined : item.durationMs,
                terminalCode: preserveTerminal ? undefined : errorCode(item.error),
                terminalMessage: preserveTerminal ? undefined : errorMessage(item.error),
                traceId: item.traceId,
                providerRunId: item.providerRunId ?? undefined,
                originKind: item.origin?.kind,
                scheduleId: item.origin?.scheduleId,
                scheduleOccurrenceId: item.origin?.scheduleOccurrenceId,
                submittedByTaskId: item.origin?.submittedByTaskId,
                scheduledFor: item.origin?.scheduledFor ? new Date(item.origin.scheduledFor) : undefined,
            });
            await this.prisma.agentRun!.upsert!({
                where: { tenantId_taskId: { tenantId, taskId: item.taskId } },
                create: createData,
                update: updateData,
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
            await this.projectAuthoritativeTerminalAttempt(event, 'completed', createdAt);
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
            await this.projectAuthoritativeTerminalAttempt(event, 'failed', createdAt);
            return;
        }

        if (event.type === 'task.canceled' || event.type === 'task.detached') {
            const reason = stringField(event.payload, 'reason');
            await this.upsertEventRun({
                tenantId: event.tenantId,
                taskId,
                rootTaskId: parentRootTaskId ?? taskId,
                agentId,
                status: 'canceled',
                terminalAt: createdAt,
                traceId,
                cancelReason: reason,
            });
            await this.resolveEdgesForTerminalChild({
                tenantId: event.tenantId,
                childTaskId: taskId,
                status: 'canceled',
                resolvedAt: createdAt,
                terminalMessage: reason,
            });
            await this.projectAuthoritativeTerminalAttempt(event, 'canceled', createdAt);
            return;
        }

        if (event.type === 'turn.attempt_started' || event.type === 'turn.attempt_finished') {
            const attemptKey = stringField(event.payload, 'attemptKey');
            if (!attemptKey) return;
            const finished = event.type === 'turn.attempt_finished';
            const disposition = stringField(event.payload, 'disposition') ?? 'executed';
            const status = finished
                ? stringField(event.payload, 'status') ?? (disposition === 'superseded' ? 'superseded' : 'completed')
                : 'running';
            const normalizedStatus = normalizeStatus(status);
            const authoritativeTerminal = finished &&
                event.payload.authoritativeTerminal === true &&
                TERMINAL_AGENT_RUN_STATUSES.has(normalizedStatus);
            if (authoritativeTerminal) {
                await this.upsertEventRun({
                    tenantId: event.tenantId,
                    taskId,
                    rootTaskId,
                    agentId,
                    status: normalizedStatus,
                    terminalAt: createdAt,
                    traceId,
                });
            }
            await this.upsertEventTurn({
                tenantId: event.tenantId,
                taskId,
                rootTaskId,
                agentId,
                turnSeq: eventTurnSeq(event.payload) || undefined,
                attemptKey,
                disposition,
                claimId: stringField(event.payload, 'claimId'),
                turnFence: stringField(event.payload, 'fence'),
                claimedGeneration: stringField(event.payload, 'claimedGeneration'),
                status,
                ...(finished ? { completedAt: createdAt } : { startedAt: createdAt }),
                authoritativeTerminal,
            });
            if (authoritativeTerminal) {
                await this.convergeTerminalAttempts({
                    tenantId: event.tenantId,
                    taskId,
                    status: normalizedStatus as 'completed' | 'failed' | 'canceled',
                    completedAt: createdAt,
                    authoritativeAttemptKey: attemptKey,
                });
            }
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
                outputState: failed ? undefined : childCompletionOutputState(event.payload),
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
            await this.convergeTerminalAttempts({
                tenantId: event.tenantId,
                taskId: childTaskId,
                status: failed ? 'failed' : 'completed',
                completedAt: createdAt,
            });
            return;
        }

        // Cognition iteration events remain in the event log for diagnostics;
        // runtime attempt projection is owned by turn.attempt_* events.
        if (event.type === 'turn.started') return;

        if (event.type === 'turn.observed' || event.type === 'turn.completed' || event.type === 'turn.superseded') {
            const turnSeq = eventSegmentSeq(event.payload);
            if (turnSeq <= 0) return;
            const superseded = event.type === 'turn.superseded';
            const turnTraceId = stringField(event.payload, 'turnId');
            const transition = event.payload.transition;
            const transitionKindValue = transitionKind(transition);
            const boundary = isAwaitBoundaryKind(transitionKindValue) ? transitionKindValue : undefined;
            const output = outputProduced({ cognition: { transition }, status: 'completed' } as TurnRun);
            await this.upsertCognitiveTurn(event, {
                taskId,
                rootTaskId,
                agentId,
                disposition: superseded ? 'superseded' : event.type === 'turn.completed' ? 'committed' : 'observed',
                completedAt: createdAt,
            });
            void boundary;
            void output;
            if (superseded || event.type === 'turn.observed') return;
            const runStatus = boundary
                ? 'waiting'
                : transitionKindValue === 'complete' ? 'completed' : 'running';
            await this.upsertEventRun({
                tenantId: event.tenantId,
                taskId,
                rootTaskId,
                agentId,
                status: runStatus,
                terminalAt: transitionKindValue === 'complete' ? createdAt : undefined,
                outputState: output ? 'available' : undefined,
            });
            if (transitionKindValue === 'complete') {
                await this.resolveEdgesForTerminalChild({
                    tenantId: event.tenantId,
                    childTaskId: taskId,
                    status: 'completed',
                    resolvedAt: createdAt,
                });
                await this.convergeTerminalAttempts({
                    tenantId: event.tenantId,
                    taskId,
                    status: 'completed',
                    completedAt: createdAt,
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

    /** Idempotently converges semantic rows on the authoritative terminal snapshot. */
    async reconcileDurableTerminal(params: {
        tenantId: string;
        taskId: string;
        snapshot: Record<string, unknown> | undefined;
        agentId?: string;
    }): Promise<boolean> {
        if (!this.isAvailable() || !params.snapshot) return false;
        const terminal = readDurableTaskTerminal(params.snapshot);
        const lifecycle = readTaskLifecycle(params.snapshot, params.taskId);
        if (!terminal && lifecycle?.state !== 'detached') return false;
        const claim = terminal?.turnClaim;
        const status = terminal?.state ?? 'canceled';
        const terminalAt = terminal?.claimedAt ?? lifecycle?.changedAt;
        if (terminalAt === undefined) return false;
        const completedAt = new Date(terminalAt);
        let origin: TaskSubmissionOrigin | undefined;
        try {
            origin = readTaskSubmissionMetadata(params.snapshot)?.origin;
        } catch {
            // Terminal convergence must remain available for historical or
            // corrupt submission envelopes. Invalid provenance is omitted
            // rather than projected as trusted metadata.
        }
        const runData = stripUndefined({
            rootTaskId: lifecycle?.rootTaskId ?? params.taskId,
            parentTaskId: lifecycle?.parentTaskId,
            agentId: params.agentId,
            operation: 'agent.run',
            scope: lifecycle?.parentTaskId ? 'child' : 'root',
            status,
            terminalAt: completedAt,
            outputState: terminal?.state === 'completed' && terminal.status.metadata?.result !== undefined
                ? 'available'
                : undefined,
            terminalMessage: terminal?.status.message?.parts.map((part) => part.text).join(' '),
            cancelReason: lifecycle?.state === 'detached' ? lifecycle.reason : undefined,
            originKind: origin?.kind,
            scheduleId: origin?.scheduleId,
            scheduleOccurrenceId: origin?.scheduleOccurrenceId,
            submittedByTaskId: origin?.submittedByTaskId,
            scheduledFor: origin?.scheduledFor ? new Date(origin.scheduledFor) : undefined,
        });
        await this.prisma.agentRun?.upsert?.({
            where: { tenantId_taskId: { tenantId: params.tenantId, taskId: params.taskId } },
            create: { tenantId: params.tenantId, taskId: params.taskId, ...runData },
            update: runData,
        });
        const attemptKey = claim?.attemptKey ?? (claim ? `claim:${claim.claimId}` : undefined);
        if (claim && attemptKey) {
            await this.upsertEventTurn({
                tenantId: params.tenantId,
                taskId: params.taskId,
                rootTaskId: lifecycle?.rootTaskId ?? params.taskId,
                agentId: params.agentId,
                turnSeq: claim.turnSeq,
                attemptKey,
                disposition: 'executed',
                claimId: claim.claimId,
                turnFence: claim.fence,
                claimedGeneration: claim.generation,
                status,
                completedAt,
                authoritativeTerminal: true,
                outputProduced: terminal?.state === 'completed' && terminal.status.metadata?.result !== undefined,
            });
        }
        await this.convergeTerminalAttempts({
            tenantId: params.tenantId,
            taskId: params.taskId,
            status,
            completedAt,
            authoritativeAttemptKey: attemptKey,
        });
        return true;
    }

    /**
     * Reconcile one keyset-paginated batch of historical terminal snapshots.
     * This is deliberately idempotent so deployment jobs may safely restart or overlap.
     */
    async reconcileDurableTerminalBatch(params: {
        after?: TerminalProjectionReconciliationCursor;
        limit?: number;
    } = {}): Promise<{
        scanned: number;
        reconciled: number;
        next?: TerminalProjectionReconciliationCursor;
    }> {
        if (!this.isAvailable()) return { scanned: 0, reconciled: 0 };
        const findMany = this.prisma.wMSession?.findMany;
        if (typeof findMany !== 'function') return { scanned: 0, reconciled: 0 };
        const limit = Math.max(1, Math.min(1_000, params.limit ?? 100));
        const terminalFilter = {
            OR: [
                ...['completed', 'failed', 'canceled'].map((state) => ({
                    snapshot: { path: ['meta', 'taskTerminal', 'state'], equals: state },
                })),
                { snapshot: { path: ['meta', 'taskLifecycle', 'state'], equals: 'detached' } },
            ],
        };
        const rows = await findMany({
            where: params.after
                ? {
                    AND: [
                        terminalFilter,
                        {
                            OR: [
                                { tenantId: { gt: params.after.tenantId } },
                                {
                                    tenantId: params.after.tenantId,
                                    sessionId: { gt: params.after.sessionId },
                                },
                            ],
                        },
                    ],
                }
                : terminalFilter,
            orderBy: [{ tenantId: 'asc' }, { sessionId: 'asc' }],
            take: limit,
            select: { tenantId: true, sessionId: true, agentId: true, snapshot: true },
        });
        let reconciled = 0;
        for (const row of rows) {
            if (await this.reconcileDurableTerminal({
                tenantId: row.tenantId,
                taskId: row.sessionId,
                agentId: row.agentId,
                snapshot: row.snapshot !== null && typeof row.snapshot === 'object' && !Array.isArray(row.snapshot)
                    ? row.snapshot as Record<string, unknown>
                    : undefined,
            })) {
                reconciled += 1;
            }
        }
        const last = rows.at(-1);
        return {
            scanned: rows.length,
            reconciled,
            ...(last && rows.length === limit
                ? { next: { tenantId: last.tenantId, sessionId: last.sessionId } }
                : {}),
        };
    }

    async reconcileAllDurableTerminals(params: {
        batchSize?: number;
        onBatch?: (summary: TerminalProjectionReconciliationSummary) => void;
    } = {}): Promise<TerminalProjectionReconciliationSummary> {
        const summary: TerminalProjectionReconciliationSummary = {
            scanned: 0,
            reconciled: 0,
            batches: 0,
        };
        let after: TerminalProjectionReconciliationCursor | undefined;
        do {
            const batch = await this.reconcileDurableTerminalBatch({
                ...(after ? { after } : {}),
                limit: params.batchSize,
            });
            summary.scanned += batch.scanned;
            summary.reconciled += batch.reconciled;
            summary.batches += batch.scanned > 0 ? 1 : 0;
            params.onBatch?.({ ...summary });
            after = batch.next;
        } while (after);
        return summary;
    }

    async reconcileCognitiveTurns(params: {
        tenantId?: string;
        taskId?: string;
        batchSize?: number;
    } = {}): Promise<CognitiveProjectionReconciliationSummary> {
        if (typeof this.prisma.wMEvent?.findMany !== 'function') return { scanned: 0, projected: 0 };
        const limit = Math.max(1, Math.min(1_000, params.batchSize ?? 100));
        let after: string | undefined;
        let scanned = 0;
        let projected = 0;
        do {
            const rows = await this.prisma.wMEvent.findMany({
                where: stripUndefined({
                    tenantId: params.tenantId,
                    sessionId: params.taskId,
                    type: { in: ['turn.observed', 'turn.completed', 'turn.superseded'] },
                    ...(after ? { eventId: { gt: after } } : {}),
                }),
                orderBy: { eventId: 'asc' },
                take: limit,
            }) as Array<{ eventId: string; tenantId: string; sessionId: string; seq: number; type: string; payload: unknown; createdAt: Date }>;
            for (const row of rows) {
                if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) continue;
                await this.projectEvent({
                    tenantId: row.tenantId,
                    sessionId: row.sessionId,
                    type: row.type,
                    payload: row.payload as Record<string, unknown>,
                    eventId: row.eventId,
                    seq: row.seq,
                    createdAt: row.createdAt,
                });
                projected += 1;
            }
            scanned += rows.length;
            after = rows.length === limit ? rows.at(-1)?.eventId : undefined;
        } while (after);
        return { scanned, projected };
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
                params.taskId ?? '',
                params.scheduleId ?? '',
                params.hasLlm ? 'llm' : '',
                params.hasMemory ? 'memory' : '',
                params.costState ?? '',
                params.cursor ?? '',
                params.limit,
            ].join('\x1f'),
            () => this.listAgentRunsUncoalesced(params),
        );
    }

    private async listAgentRunsUncoalesced(params: SemanticAgentRunListParams): Promise<SemanticAgentRunListPage | undefined> {
        const profileStartedAt = projectionNow();
        const cursor = decodeCursor(params.cursor);
        const where = buildSemanticAgentRunWhere(params);
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
        const summary = await this.summarizeAgentRuns(where);
        const mapMs = projectionNow() - mapStartedAt;
        logProjectionProfile('listAgentRuns', profileStartedAt, {
            tenantId: params.tenantId,
            scope: params.scope,
            agentId: params.agentId ?? null,
            status: params.status ?? null,
            taskId: params.taskId ?? null,
            hasLlm: params.hasLlm ?? null,
            hasMemory: params.hasMemory ?? null,
            costState: params.costState ?? null,
            limit: params.limit,
            rows: rows.length,
            pageRows: pageRows.length,
            pageMs: Number(pageMs.toFixed(1)),
            mapMs: Number(mapMs.toFixed(1)),
        });
        return {
            items,
            ...(nextCursor ? { nextCursor } : {}),
            summary,
            pageInfo: {
                ...(nextCursor ? { nextCursor } : {}),
                hasMore: nextCursor !== undefined,
                limit: params.limit,
            },
            projection: { source: 'semantic', partial: false },
        };
    }

    private async summarizeAgentRuns(where: Record<string, unknown>): Promise<SemanticAgentRunListSummary | undefined> {
        const agentRun = this.prisma.agentRun as {
            count?: (args: { where?: Record<string, unknown> }) => Promise<number>;
            groupBy?: (args: { by: string[]; where?: Record<string, unknown>; _count: { _all: true } }) => Promise<Array<{ status: string; _count: { _all: number } }>>;
        } | undefined;
        if (!agentRun?.count || !agentRun.groupBy) {
            return undefined;
        }
        const [total, byStatus, costCaptured] = await Promise.all([
            agentRun.count({ where }),
            agentRun.groupBy({ by: ['status'], where, _count: { _all: true } }),
            agentRun.count({ where: { ...where, knownCostUsd: { not: null } } }),
        ]);
        const statusCounts = new Map(byStatus.map((entry) => [normalizeStatusKey(entry.status), entry._count._all]));
        const running = statusCounts.get('running') ?? 0;
        const queued = statusCounts.get('queued') ?? 0;
        const waiting = statusCounts.get('waiting') ?? 0;
        return {
            total,
            failed: statusCounts.get('failed') ?? 0,
            waiting: running + queued + waiting,
            stuck: 0,
            completed: (statusCounts.get('completed') ?? 0) + (statusCounts.get('succeeded') ?? 0) + (statusCounts.get('success') ?? 0),
            costCaptured,
            costUnavailable: Math.max(0, total - costCaptured),
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
        const [edges, turns, cognitiveTurns, effects] = await Promise.all([
            this.prisma.agentRunEdge!.findMany!({
                where: { tenantId: params.tenantId, rootTaskId: params.taskId },
                orderBy: [{ createdAt: 'asc' }],
            }) as Promise<SemanticEdgeRow[]>,
            this.prisma.turnRun!.findMany!({
                where: { tenantId: params.tenantId, rootTaskId: params.taskId },
                orderBy: [{ taskId: 'asc' }, { turnSeq: 'asc' }],
            }) as Promise<SemanticTurnRow[]>,
            typeof this.prisma.cognitiveTurnRun?.findMany === 'function'
                ? this.prisma.cognitiveTurnRun.findMany({
                    where: { tenantId: params.tenantId, rootTaskId: params.taskId },
                    orderBy: [{ taskId: 'asc' }, { cognitionTurnSeq: 'asc' }],
                }) as Promise<SemanticCognitiveTurnRow[]>
                : Promise.resolve([]),
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
        const turnProjection = groupTurnAttempts(turns.map(rowToTurnAttempt));
        const partial = semanticProjectionIsPartial({
            rootTaskId: params.taskId,
            runs,
            edges,
            turns: turnProjection.turns.map((turn) => ({
                ...turn,
                cognitiveTurns: cognitiveTurns
                    .filter((cognition) => cognition.taskId === turn.taskId && cognition.segmentSeq === turn.turnSeq)
                    .map(rowToCognitiveTurn),
            })),
            unassignedAttempts: turnProjection.unassignedAttempts,
            expectedTurnCount,
            expectedEdgeCount,
        });
        const graph: AgentRunGraph = {
            schemaVersion: 3,
            tenantId: params.tenantId,
            taskId: params.taskId,
            root: rowToNode(root),
            nodes,
            edges: edges.map(rowToEdge),
            turns: turnProjection.turns.map((turn) => ({
                ...turn,
                cognitiveTurns: cognitiveTurns
                    .filter((cognition) => cognition.taskId === turn.taskId && cognition.segmentSeq === turn.turnSeq)
                    .map(rowToCognitiveTurn),
            })),
            unassignedAttempts: turnProjection.unassignedAttempts,
            memoryOps: [],
            effects: effects.map(rowToEffect),
            events: [],
            coordination: {
                taskId: params.taskId,
                state: 'idle',
                health: 'attention',
                observedAt: new Date().toISOString(),
                requestedGeneration: '0',
                completedGeneration: '0',
                issues: ['projection_partial'],
            },
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
        cancelReason?: string;
        traceId?: string;
        outputState?: string;
    }): Promise<void> {
        const status = normalizeStatus(params.status);
        const existing = await this.findRun(params.tenantId, params.taskId);
        const preserveTerminal = shouldPreserveTerminal(existing?.status, status);
        const createData = stripUndefined({
            rootTaskId: params.rootTaskId,
            agentId: params.agentId,
            operation: 'agent.run',
            scope: params.scope ?? (params.taskId === params.rootTaskId ? 'root' : 'child'),
            status,
            parentTaskId: params.parentTaskId,
            startedAt: params.startedAt,
            terminalAt: params.terminalAt,
            durationMs: params.startedAt && params.terminalAt ? Math.max(0, params.terminalAt.getTime() - params.startedAt.getTime()) : undefined,
            terminalCode: params.terminalCode,
            terminalMessage: params.terminalMessage,
            cancelReason: params.cancelReason,
            traceId: params.traceId,
            outputState: params.outputState,
        });
        const updateData = stripUndefined({
            rootTaskId: params.rootTaskId,
            agentId: params.agentId,
            operation: 'agent.run',
            scope: params.scope ?? (params.taskId === params.rootTaskId ? 'root' : 'child'),
            status: preserveTerminal ? undefined : status,
            parentTaskId: params.parentTaskId,
            startedAt: params.startedAt,
            terminalAt: preserveTerminal ? undefined : params.terminalAt,
            durationMs: preserveTerminal
                ? undefined
                : params.startedAt && params.terminalAt ? Math.max(0, params.terminalAt.getTime() - params.startedAt.getTime()) : undefined,
            terminalCode: preserveTerminal ? undefined : params.terminalCode,
            terminalMessage: preserveTerminal ? undefined : params.terminalMessage,
            cancelReason: params.cancelReason,
            traceId: params.traceId,
            outputState: params.outputState,
        });
        await this.prisma.agentRun!.upsert!({
            where: { tenantId_taskId: { tenantId: params.tenantId, taskId: params.taskId } },
            create: {
                tenantId: params.tenantId,
                taskId: params.taskId,
                ...createData,
            },
            update: updateData,
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

    private async projectAuthoritativeTerminalAttempt(
        event: OperatorProjectionEvent,
        status: 'completed' | 'failed' | 'canceled',
        completedAt: Date
    ): Promise<void> {
        const claimId = stringField(event.payload, 'claimId');
        const taskId = stringField(event.payload, 'taskId') ?? event.sessionId;
        const attemptKey = claimId
            ? stringField(event.payload, 'attemptKey') ?? `claim:${claimId}`
            : undefined;
        if (claimId && attemptKey) {
            const rootTaskId = stringField(event.payload, 'rootTaskId') ??
                await this.parentRootTaskId(event.tenantId, event.sessionId) ?? taskId;
            await this.upsertEventTurn({
                tenantId: event.tenantId,
                taskId,
                rootTaskId,
                agentId: stringField(event.payload, 'agentId'),
                turnSeq: eventTurnSeq(event.payload) || undefined,
                attemptKey,
                disposition: 'executed',
                claimId,
                turnFence: stringField(event.payload, 'fence'),
                claimedGeneration: stringField(event.payload, 'claimedGeneration'),
                status,
                completedAt,
                authoritativeTerminal: true,
            });
        }
        await this.convergeTerminalAttempts({
            tenantId: event.tenantId,
            taskId,
            status,
            completedAt,
            authoritativeAttemptKey: attemptKey,
        });
    }

    private async convergeTerminalAttempts(params: {
        tenantId: string;
        taskId: string;
        status: 'completed' | 'failed' | 'canceled';
        completedAt: Date;
        authoritativeAttemptKey?: string;
    }): Promise<void> {
        const updateMany = this.prisma.turnRun?.updateMany;
        if (typeof updateMany !== 'function') return;
        if (params.authoritativeAttemptKey) {
            await updateMany({
                where: {
                    tenantId: params.tenantId,
                    taskId: params.taskId,
                    attemptKey: params.authoritativeAttemptKey,
                    status: 'running',
                },
                data: {
                    status: params.status,
                    completedAt: params.completedAt,
                    authoritativeTerminal: true,
                },
            });
            await updateMany({
                where: {
                    tenantId: params.tenantId,
                    taskId: params.taskId,
                    attemptKey: { not: params.authoritativeAttemptKey },
                    status: 'running',
                },
                data: {
                    status: 'superseded',
                    disposition: 'superseded',
                    completedAt: params.completedAt,
                    authoritativeTerminal: false,
                },
            });
            return;
        }
        await updateMany({
            where: {
                tenantId: params.tenantId,
                taskId: params.taskId,
                authoritativeTerminal: true,
                status: 'running',
            },
            data: {
                status: params.status,
                completedAt: params.completedAt,
            },
        });
        await updateMany({
            where: {
                tenantId: params.tenantId,
                taskId: params.taskId,
                authoritativeTerminal: false,
                status: 'running',
            },
            data: {
                status: 'superseded',
                disposition: 'superseded',
                completedAt: params.completedAt,
                authoritativeTerminal: false,
            },
        });
    }

    private async convergePersistedTerminalTasks(tenantId: string, taskIds: string[]): Promise<void> {
        const uniqueTaskIds = [...new Set(taskIds)];
        if (uniqueTaskIds.length === 0) return;
        const rows = await this.prisma.agentRun!.findMany!({
            where: {
                tenantId,
                taskId: { in: uniqueTaskIds },
                status: { in: [...TERMINAL_AGENT_RUN_STATUSES] },
            },
        }) as SemanticRunRow[];
        for (const row of rows) {
            const status = normalizeStatus(row.status);
            if (!TERMINAL_AGENT_RUN_STATUSES.has(status)) continue;
            await this.convergeTerminalAttempts({
                tenantId,
                taskId: row.taskId,
                status: status as 'completed' | 'failed' | 'canceled',
                completedAt: new Date(row.terminalAt ?? row.updatedAt),
            });
        }
    }

    private async upsertEventTurn(params: {
        tenantId: string;
        taskId: string;
        rootTaskId: string;
        agentId?: string;
        turnSeq?: number;
        attemptKey: string;
        disposition?: string;
        claimId?: string;
        turnFence?: string;
        claimedGeneration?: string;
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
        authoritativeTerminal?: boolean;
    }): Promise<void> {
        await this.upsertTurnEvidence({
            ...params,
            attemptKey: canonicalTurnAttemptKey(params.claimId, params.attemptKey),
        });
    }

    private async upsertCognitiveTurn(
        event: OperatorProjectionEvent,
        params: {
            taskId: string;
            rootTaskId: string;
            agentId?: string;
            disposition: 'observed' | 'committed' | 'superseded';
            completedAt: Date;
        },
    ): Promise<void> {
        if (typeof this.prisma.cognitiveTurnRun?.upsert !== 'function') return;
        const cognitionTurnSeq = eventCognitionTurnSeq(event.payload);
        if (cognitionTurnSeq <= 0) return;
        const turnId = stringField(event.payload, 'turnId');
        const claimId = stringField(event.payload, 'claimId');
        const attemptKey = stringField(event.payload, 'attemptKey');
        const identityKey = turnId
            ? `turn:${turnId}`
            : `legacy:${claimId ?? attemptKey ?? 'unclaimed'}:${cognitionTurnSeq}`;
        const timings = recordValue(event.payload.timings);
        const usage = recordValue(event.payload.usage);
        const durationMs = numberField(timings, 'totalMs');
        const startedAt = durationMs > 0
            ? new Date(params.completedAt.getTime() - durationMs)
            : undefined;
        const llmCalls = arrayValue(event.payload.llmCalls);
        const toolCalls = arrayValue(event.payload.toolCalls);
        const childCalls = arrayValue(event.payload.childCalls);
        const llmCallCount = numberField(usage, 'llmCalls') || llmCalls.length;
        const data = stripUndefined({
            rootTaskId: params.rootTaskId,
            agentId: params.agentId,
            turnId,
            cognitionTurnSeq,
            segmentSeq: eventSegmentSeq(event.payload) || undefined,
            attemptKey,
            claimId,
            disposition: params.disposition,
            startedAt,
            startedAtEstimated: startedAt !== undefined,
            completedAt: params.completedAt,
            durationMs: durationMs || undefined,
            stageBefore: stringField(event.payload, 'stageBefore'),
            stageAfter: stringField(event.payload, 'stageAfter'),
            cognition: stripUndefined({
                stageTransition: event.payload.stageTransition,
                transition: event.payload.transition,
                intent: event.payload.intent,
                shield: event.payload.shield,
                perception: event.payload.perception,
                execAction: event.payload.execAction,
                execResult: event.payload.execResult,
                mentalStateBeforeHash: event.payload.mentalStateBeforeHash,
                mentalStateAfterHash: event.payload.mentalStateAfterHash,
                level: event.payload.level,
            }),
            timings,
            usage,
            llmCalls,
            toolCalls,
            childCalls,
            llmCallCount,
            toolCallCount: toolCalls.length,
            childCallCount: childCalls.length,
            inputTokens: numberField(usage, 'inputTokens'),
            outputTokens: numberField(usage, 'outputTokens'),
            knownCostUsd: costFromUsage(usage),
            traceId: stringField(event.payload, 'traceId'),
            spanId: stringField(event.payload, 'spanId'),
        });
        await this.prisma.cognitiveTurnRun.upsert({
            where: {
                tenantId_taskId_identityKey: {
                    tenantId: event.tenantId,
                    taskId: params.taskId,
                    identityKey,
                },
            },
            create: {
                tenantId: event.tenantId,
                taskId: params.taskId,
                identityKey,
                ...data,
            },
            update: data,
        });
        await this.recomputeCognitiveAggregates(event.tenantId, params.taskId);
    }

    private async recomputeCognitiveAggregates(tenantId: string, taskId: string): Promise<void> {
        if (typeof this.prisma.cognitiveTurnRun?.findMany !== 'function') return;
        const existingRun = await this.findRun(tenantId, taskId);
        const terminal = existingRun ? TERMINAL_AGENT_RUN_STATUSES.has(normalizeStatus(existingRun.status)) : false;
        const rows = await this.prisma.cognitiveTurnRun.findMany({
            where: terminal
                ? { tenantId, taskId, disposition: 'committed' }
                : { tenantId, taskId, disposition: { in: ['observed', 'committed'] } },
        }) as Array<{ llmCallCount?: number; memoryOpCount?: number; knownCostUsd?: unknown }>;
        const knownCosts = rows.map((row) => decimalToNumber(row.knownCostUsd)).filter((value) => Number.isFinite(value));
        await this.prisma.agentRun?.upsert?.({
            where: { tenantId_taskId: { tenantId, taskId } },
            create: {
                tenantId,
                taskId,
                rootTaskId: taskId,
                scope: 'root',
                status: 'running',
                turnCount: rows.length,
                llmCallCount: rows.reduce((sum, row) => sum + (row.llmCallCount ?? 0), 0),
                memoryOpCount: rows.reduce((sum, row) => sum + (row.memoryOpCount ?? 0), 0),
                knownCostUsd: knownCosts.length > 0 ? knownCosts.reduce((sum, value) => sum + value, 0) : undefined,
            },
            update: {
                turnCount: rows.length,
                llmCallCount: rows.reduce((sum, row) => sum + (row.llmCallCount ?? 0), 0),
                memoryOpCount: rows.reduce((sum, row) => sum + (row.memoryOpCount ?? 0), 0),
                knownCostUsd: knownCosts.length > 0 ? knownCosts.reduce((sum, value) => sum + value, 0) : undefined,
            },
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
        const cognitiveTurns = turns.flatMap((turn) => turn.cognitiveTurns ?? []);
        const visibleCognitiveTurns = cognitiveTurns.filter((turn) => turn.disposition !== 'superseded');
        const authoritativeCognitiveTurns = cognitiveTurns.filter((turn) => turn.disposition === 'committed');
        const terminalStatus = TERMINAL_AGENT_RUN_STATUSES.has(normalizeStatus(node.status));
        const aggregateCognitiveTurns = terminalStatus ? authoritativeCognitiveTurns : visibleCognitiveTurns;
        const aggregateTurnCount = cognitiveTurns.length > 0 ? aggregateCognitiveTurns.length : turns.length;
        const childCount = graph.edges.filter((edge) => edge.parentTaskId === node.taskId && edge.childTaskId !== undefined).length;
        const llmCallCount = cognitiveTurns.length > 0
            ? aggregateCognitiveTurns.reduce((count, turn) => count + turn.llmCalls.length, 0)
            : turns.reduce((count, turn) => count + (Array.isArray(turn.llmCalls) ? turn.llmCalls.length : 0), 0);
        const memoryOpCount = cognitiveTurns.length > 0
            ? aggregateCognitiveTurns.reduce((count, turn) => count + turn.memoryOps.length, 0)
            : turns.reduce((count, turn) => count + (Array.isArray(turn.memoryOps) ? turn.memoryOps.length : 0), 0);
        const terminalAt = node.finishedAt ? new Date(node.finishedAt) : undefined;
        const startedAt = node.startedAt ? new Date(node.startedAt) : undefined;
        const status = normalizeStatus(node.status);
        const existing = await this.findRun(node.tenantId, node.taskId);
        const preserveTerminal = shouldPreserveTerminal(existing?.status, status);
        const createData = stripUndefined({
            rootTaskId: node.rootTaskId,
            agentId: node.agentId,
            operation: 'agent.run',
            scope: isRoot ? 'root' : 'child',
            status,
            parentTaskId: node.parentTaskId,
            childCount,
            turnCount: aggregateTurnCount,
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
            originKind: node.origin?.kind,
            scheduleId: node.origin?.scheduleId,
            scheduleOccurrenceId: node.origin?.scheduleOccurrenceId,
            submittedByTaskId: node.origin?.submittedByTaskId,
            scheduledFor: node.origin?.scheduledFor ? new Date(node.origin.scheduledFor) : undefined,
        });
        const updateData = stripUndefined({
            rootTaskId: node.rootTaskId,
            agentId: node.agentId,
            operation: 'agent.run',
            scope: isRoot ? 'root' : 'child',
            status: preserveTerminal ? undefined : status,
            parentTaskId: node.parentTaskId,
            childCount,
            turnCount: aggregateTurnCount,
            llmCallCount,
            memoryOpCount,
            startedAt,
            terminalAt: preserveTerminal ? undefined : terminalAt,
            durationMs: preserveTerminal ? undefined : startedAt && terminalAt ? Math.max(0, terminalAt.getTime() - startedAt.getTime()) : undefined,
            terminalCode: preserveTerminal ? undefined : errorCode(node.error),
            terminalMessage: preserveTerminal ? undefined : errorMessage(node.error),
            cancelReason: node.cancellation?.reason,
            outputState: node.outputPreview === undefined ? 'not_captured' : 'available',
            traceId: node.traceId,
            providerRunId: node.providerRunId,
            originKind: node.origin?.kind,
            scheduleId: node.origin?.scheduleId,
            scheduleOccurrenceId: node.origin?.scheduleOccurrenceId,
            submittedByTaskId: node.origin?.submittedByTaskId,
            scheduledFor: node.origin?.scheduledFor ? new Date(node.origin.scheduledFor) : undefined,
        });
        await this.prisma.agentRun!.upsert!({
            where: { tenantId_taskId: { tenantId: node.tenantId, taskId: node.taskId } },
            create: {
                tenantId: node.tenantId,
                taskId: node.taskId,
                ...createData,
            },
            update: updateData,
        });
    }

    private async findRun(tenantId: string, taskId: string): Promise<SemanticRunRow | undefined> {
        const rows = await this.prisma.agentRun!.findMany!({
            where: { tenantId, taskId },
            take: 1,
        }) as SemanticRunRow[];
        return rows[0];
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

    private async upsertTurn(turn: TurnAttemptRun, nodesByTask: Map<string, AgentRunNode>, graph: AgentRunGraph): Promise<void> {
        const turnSeq = turn.turnSeq;
        const attemptKey = canonicalTurnAttemptKey(turn.claimId, turn.attemptKey ?? turn.id);
        const node = nodesByTask.get(turn.taskId);
        const transition = turn.cognition?.transition;
        await this.upsertTurnEvidence({
            tenantId: graph.tenantId,
            taskId: turn.taskId,
            rootTaskId: turn.rootTaskId,
            agentId: turn.agentId ?? node?.agentId,
            status: turn.status,
            startedAt: turn.startedAt ? new Date(turn.startedAt) : undefined,
            completedAt: turn.finishedAt ? new Date(turn.finishedAt) : undefined,
            transitionKind: transitionKind(transition),
            boundaryKind: turn.boundaryKind,
            outputProduced: outputProduced(turn),
            llmCallCount: Array.isArray(turn.llmCalls) ? turn.llmCalls.length : 0,
            memoryOpCount: Array.isArray(turn.memoryOps) ? turn.memoryOps.length : 0,
            terminalCode: errorCode(turn.error),
            terminalMessage: errorMessage(turn.error),
            turnTraceId: turn.turnTraceRef?.turnTraceId,
            turnSeq,
            attemptKey,
            attemptSeq: turn.attemptSeq,
            disposition: turn.disposition,
            claimId: turn.claimId,
            turnFence: turn.turnFence,
            claimedGeneration: turn.claimedGeneration,
            authoritativeTerminal: turn.authoritativeTerminal,
        });
    }

    private async upsertTurnEvidence(params: {
        tenantId: string;
        taskId: string;
        rootTaskId: string;
        agentId?: string;
        turnSeq?: number;
        attemptKey: string;
        attemptSeq?: number;
        disposition?: string;
        claimId?: string;
        turnFence?: string;
        claimedGeneration?: string;
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
        authoritativeTerminal?: boolean;
    }): Promise<void> {
        const attemptKey = canonicalTurnAttemptKey(params.claimId, params.attemptKey);
        const existing = await this.findTurn(params.tenantId, params.taskId, attemptKey);
        const status = normalizeTurnStatus(params.status);
        const startedAt = earliestDate(existing?.startedAt, params.startedAt);
        const completedAt = latestDate(existing?.completedAt, params.completedAt);
        const authoritativeTerminal = existing?.authoritativeTerminal === true || params.authoritativeTerminal === true;
        const disposition = mergePersistedDisposition(
            existing?.disposition,
            params.disposition,
            params.authoritativeTerminal === true
        );
        const data = stripUndefined({
            rootTaskId: params.rootTaskId,
            agentId: params.agentId ?? existing?.agentId ?? undefined,
            startedAt,
            completedAt,
            durationMs: startedAt && completedAt ? Math.max(0, completedAt.getTime() - startedAt.getTime()) : existing?.durationMs ?? undefined,
            transitionKind: params.transitionKind ?? existing?.transitionKind ?? undefined,
            boundaryKind: params.boundaryKind ?? existing?.boundaryKind ?? undefined,
            outputProduced: Boolean(existing?.outputProduced || params.outputProduced),
            llmCallCount: Math.max(existing?.llmCallCount ?? 0, params.llmCallCount ?? 0),
            memoryOpCount: Math.max(existing?.memoryOpCount ?? 0, params.memoryOpCount ?? 0),
            knownCostUsd: params.knownCostUsd,
            terminalCode: params.terminalCode ?? existing?.terminalCode ?? undefined,
            terminalMessage: params.terminalMessage ?? existing?.terminalMessage ?? undefined,
            turnTraceId: params.turnTraceId ?? existing?.turnTraceId ?? undefined,
            turnSeq: params.turnSeq ?? existing?.turnSeq ?? undefined,
            attemptKey,
            attemptSeq: params.attemptSeq ?? existing?.attemptSeq ?? undefined,
            disposition,
            claimId: params.claimId ?? existing?.claimId ?? undefined,
            turnFence: params.turnFence ?? existing?.turnFence ?? undefined,
            claimedGeneration: params.claimedGeneration ?? existing?.claimedGeneration ?? undefined,
        });
        const updateMany = this.prisma.turnRun?.updateMany;
        await this.prisma.turnRun!.upsert!({
            where: { tenantId_taskId_attemptKey: { tenantId: params.tenantId, taskId: params.taskId, attemptKey } },
            create: {
                tenantId: params.tenantId,
                taskId: params.taskId,
                ...data,
                status,
                authoritativeTerminal,
            },
            update: {
                ...data,
                ...(params.authoritativeTerminal === true ? { authoritativeTerminal: true, status } : {}),
                ...(typeof updateMany !== 'function' ? { status } : {}),
            },
        });
        if (typeof updateMany === 'function') {
            const statusWhere = turnStatusTransitionWhere(status, params.authoritativeTerminal === true);
            if (statusWhere !== undefined) {
                await updateMany({
                    where: {
                        tenantId: params.tenantId,
                        taskId: params.taskId,
                        attemptKey,
                        ...statusWhere,
                    },
                    data: {
                        status,
                        ...(params.authoritativeTerminal === true ? { authoritativeTerminal: true } : {}),
                    },
                });
            }
        }
    }

    private async findTurn(tenantId: string, taskId: string, attemptKey: string): Promise<SemanticTurnRow | undefined> {
        if (typeof this.prisma.turnRun?.findMany !== 'function') return undefined;
        const rows = await this.prisma.turnRun.findMany({
            where: { tenantId, taskId, attemptKey },
            take: 1,
        }) as SemanticTurnRow[];
        return rows[0];
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
    const status = semanticRunStatus(row);
    return {
        ...(row.agentId ? { agentId: row.agentId } : {}),
        taskId: row.taskId,
        rootTaskId: row.rootTaskId,
        status,
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
        ...(row.originKind === 'schedule' || row.originKind === 'agent'
            ? {
                origin: {
                    kind: row.originKind,
                    ...(row.scheduleId ? { scheduleId: row.scheduleId } : {}),
                    ...(row.scheduleOccurrenceId ? { scheduleOccurrenceId: row.scheduleOccurrenceId } : {}),
                    ...(row.submittedByTaskId ? { submittedByTaskId: row.submittedByTaskId } : {}),
                    ...(row.scheduledFor ? { scheduledFor: toIso(row.scheduledFor) } : {}),
                },
            }
            : {}),
    };
}

function buildSemanticAgentRunWhere(params: SemanticAgentRunListParams): Record<string, unknown> {
    const and: Record<string, unknown>[] = [{
        tenantId: params.tenantId,
        ...(params.scope === 'roots' ? { scope: 'root' } : {}),
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(params.status ? { status: params.status } : {}),
        ...(params.scheduleId ? { scheduleId: params.scheduleId } : {}),
    }];
    if (params.since) {
        const since = new Date(params.since);
        if (!Number.isNaN(since.getTime())) {
            and.push({ updatedAt: { gte: since } });
        }
    }
    if (params.taskId) {
        and.push({
            OR: [
                { taskId: { contains: params.taskId } },
                { rootTaskId: { contains: params.taskId } },
            ],
        });
    }
    if (params.hasLlm) {
        and.push({ llmCallCount: { gt: 0 } });
    }
    if (params.hasMemory) {
        and.push({ memoryOpCount: { gt: 0 } });
    }
    if (params.costState === 'captured') {
        and.push({ knownCostUsd: { not: null } });
    } else if (params.costState === 'missing') {
        and.push({ knownCostUsd: null });
    }
    return and.length === 1 ? and[0]! : { AND: and };
}

function normalizeStatusKey(status: string | undefined): string {
    return (status ?? 'unknown').toLowerCase();
}

function childCompletionOutputState(payload: Record<string, unknown>): string {
    const metadata = payload.executionMetadata;
    if (
        metadata &&
        typeof metadata === 'object' &&
        (metadata as Record<string, unknown>).origin === 'cache'
    ) {
        return 'cache';
    }
    return Object.prototype.hasOwnProperty.call(payload, 'result') ? 'available' : 'not_captured';
}

function rowToNode(row: SemanticRunRow): AgentRunNode {
    const status = semanticRunStatus(row);
    const executionOrigin = semanticExecutionOrigin(row, status);
    return {
        id: row.taskId,
        kind: 'agent',
        tenantId: row.tenantId,
        rootTaskId: row.rootTaskId,
        taskId: row.taskId,
        ...(row.agentId ? { agentId: row.agentId } : {}),
        ...(row.scope === 'child' ? { parentTaskId: row.parentTaskId ?? undefined } : {}),
        status,
        severity: severityForStatus(status, row.terminalCode || row.terminalMessage
            ? { code: row.terminalCode, message: row.terminalMessage }
            : undefined),
        ...(row.terminalCode || row.terminalMessage ? { error: { code: row.terminalCode, message: row.terminalMessage } } : {}),
        ...(status === 'canceled' || row.cancelReason ? { cancellation: { requested: true, reason: row.cancelReason ?? undefined } } : {}),
        ...(row.traceId ? { traceId: row.traceId } : {}),
        ...(row.providerRunId ? { providerRunId: row.providerRunId } : {}),
        ...(row.originKind === 'schedule' || row.originKind === 'agent'
            ? {
                origin: {
                    kind: row.originKind,
                    ...(row.scheduleId ? { scheduleId: row.scheduleId } : {}),
                    ...(row.scheduleOccurrenceId ? { scheduleOccurrenceId: row.scheduleOccurrenceId } : {}),
                    ...(row.submittedByTaskId ? { submittedByTaskId: row.submittedByTaskId } : {}),
                    ...(row.scheduledFor ? { scheduledFor: toIso(row.scheduledFor) } : {}),
                },
            }
            : {}),
        ...(executionOrigin ? { executionOrigin } : {}),
        ...(row.startedAt ? { startedAt: toIso(row.startedAt) } : {}),
        ...(row.terminalAt ? { finishedAt: toIso(row.terminalAt) } : {}),
    };
}

function semanticExecutionOrigin(row: SemanticRunRow, status: AgentRunStatus): AgentRunNode['executionOrigin'] {
    if (row.outputState === 'cache') return 'cache';
    if (row.providerRunId) return 'runtime';
    if (
        row.scope === 'child' &&
        status === 'completed' &&
        (row.turnCount ?? 0) === 0 &&
        row.outputState === 'available'
    ) {
        return 'cache';
    }
    if (row.scope === 'child' && status === 'completed' && (row.turnCount ?? 0) === 0) {
        return 'projected';
    }
    return undefined;
}

function semanticProjectionIsPartial(params: {
    rootTaskId: string;
    runs: SemanticRunRow[];
    edges: SemanticEdgeRow[];
    turns: TurnRun[];
    unassignedAttempts: TurnAttemptRun[];
    expectedTurnCount: number;
    expectedEdgeCount: number;
}): boolean {
    const projectedCognitiveTurnCount = params.turns.reduce(
        (count, turn) => count + (turn.cognitiveTurns?.filter((item) => item.disposition === 'committed').length ?? 0),
        0,
    );
    const projectedTurnCount = projectedCognitiveTurnCount > 0 ? projectedCognitiveTurnCount : params.turns.length;
    if (projectedTurnCount < params.expectedTurnCount || params.edges.length < params.expectedEdgeCount) {
        return true;
    }
    if (params.runs.some((run) => run.rootTaskId !== params.rootTaskId) ||
        params.edges.some((edge) => edge.rootTaskId !== params.rootTaskId) ||
        params.turns.some((turn) => turn.rootTaskId !== params.rootTaskId)) {
        return true;
    }

    const taskIds = new Set(params.runs.map((run) => run.taskId));
    if (params.edges.some((edge) => !taskIds.has(edge.parentTaskId) || !taskIds.has(edge.childTaskId))) {
        return true;
    }
    if (params.unassignedAttempts.some((attempt) =>
        attempt.claimId !== undefined || attempt.disposition === 'executed'
    )) {
        return true;
    }

    for (const turn of params.turns) {
        if (turn.status === 'unknown' || !turn.agentId || !isCanonicalAttemptIdentity(turn)) {
            return true;
        }
        if (turn.status === 'waiting' && !turn.boundaryKind) {
            return true;
        }
    }

    const turnsByTask = new Map<string, TurnRun[]>();
    for (const turn of params.turns) {
        const taskTurns = turnsByTask.get(turn.taskId) ?? [];
        taskTurns.push(turn);
        turnsByTask.set(turn.taskId, taskTurns);
    }
    for (const run of params.runs) {
        const status = normalizeStatus(run.status);
        if (!TERMINAL_AGENT_RUN_STATUSES.has(status) || (run.turnCount ?? 0) === 0) continue;
        const latest = [...(turnsByTask.get(run.taskId) ?? [])]
            .sort((a, b) => b.turnSeq - a.turnSeq)[0];
        if (!latest || latest.status === 'queued' || latest.status === 'running' || latest.status === 'unknown') {
            return true;
        }
    }
    return false;
}

function isCanonicalAttemptIdentity(attempt: TurnAttemptRun): boolean {
    const attemptKey = attempt.attemptKey;
    if (!attemptKey) return false;
    return attempt.claimId === undefined || attemptKey === `claim:${attempt.claimId}`;
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

function rowToCognitiveTurn(row: SemanticCognitiveTurnRow) {
    const cognition = recordValue(row.cognition);
    return {
        id: row.identityKey,
        rootTaskId: row.rootTaskId,
        taskId: row.taskId,
        ...(row.agentId ? { agentId: row.agentId } : {}),
        ...(row.turnId ? { turnId: row.turnId } : {}),
        cognitionTurnSeq: row.cognitionTurnSeq,
        ...(row.segmentSeq !== null && row.segmentSeq !== undefined ? { segmentSeq: row.segmentSeq } : {}),
        ...(row.attemptKey ? { attemptKey: row.attemptKey } : {}),
        ...(row.claimId ? { claimId: row.claimId } : {}),
        disposition: row.disposition === 'superseded'
            ? 'superseded' as const
            : row.disposition === 'committed' ? 'committed' as const : 'observed' as const,
        cognition: {
            ...cognition,
            ...(row.turnId ? { turnId: row.turnId } : {}),
        },
        llmCalls: arrayValue(row.llmCalls),
        toolCalls: arrayValue(row.toolCalls),
        childCalls: arrayValue(row.childCalls),
        memoryOps: [],
        ...(row.startedAt ? { startedAt: toIso(row.startedAt) } : {}),
        ...(row.startedAtEstimated ? { startedAtEstimated: true } : {}),
        ...(row.completedAt ? { finishedAt: toIso(row.completedAt) } : {}),
    };
}

function rowToTurnAttempt(row: SemanticTurnRow): TurnAttemptRun {
    return {
        id: row.id,
        rootTaskId: row.rootTaskId,
        taskId: row.taskId,
        ...(row.agentId ? { agentId: row.agentId } : {}),
        status: normalizeStatus(row.status),
        operation: 'turn.segment',
        ...(row.turnSeq !== null && row.turnSeq !== undefined ? { turnSeq: row.turnSeq } : {}),
        attemptKey: row.attemptKey,
        ...(row.attemptSeq !== null && row.attemptSeq !== undefined ? { attemptSeq: row.attemptSeq } : {}),
        ...(isDisposition(row.disposition) ? { disposition: row.disposition } : {}),
        ...(row.claimId ? { claimId: row.claimId } : {}),
        ...(row.turnFence ? { turnFence: row.turnFence } : {}),
        ...(row.claimedGeneration ? { claimedGeneration: row.claimedGeneration } : {}),
        ...(row.authoritativeTerminal ? { authoritativeTerminal: true } : {}),
        ...(row.boundaryKind ? { boundaryKind: row.boundaryKind } : {}),
        ...(row.startedAt ? { startedAt: toIso(row.startedAt) } : {}),
        ...(row.completedAt ? { finishedAt: toIso(row.completedAt) } : {}),
        ...(row.terminalCode || row.terminalMessage ? { error: { code: row.terminalCode, message: row.terminalMessage } } : {}),
        ...(row.turnTraceId ? { turnTraceRef: { turnTraceId: row.turnTraceId } } : {}),
    };
}

function isDisposition(value: unknown): value is NonNullable<TurnRun['disposition']> {
    return value === 'executed' || value === 'queued' || value === 'matching_replay' ||
        value === 'superseded' || value === 'terminal_replay';
}

function eventAttemptKey(event: OperatorProjectionEvent, suffix: string): string {
    const attempt = stringField(event.payload, 'attemptKey') ??
        event.eventId ?? `${event.type}:${event.seq ?? 'unknown'}`;
    return `${attempt}:${suffix}`;
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

function outputProduced(turn: TurnAttemptRun): boolean {
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

function eventTurnSeq(payload: Record<string, unknown>): number {
    return eventSegmentSeq(payload);
}

function eventSegmentSeq(payload: Record<string, unknown>): number {
    return numberField(payload, 'segmentSeq') || numberField(payload, 'logicalTurnSeq') || numberField(payload, 'turnSeq');
}

function eventCognitionTurnSeq(payload: Record<string, unknown>): number {
    return numberField(payload, 'cognitionTurnSeq') || numberField(payload, 'turnSeq');
}

function recordValue(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function arrayValue(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
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

function normalizeTurnStatus(status: string): AgentRunStatus {
    return status === 'superseded' ? 'completed' : normalizeStatus(status);
}

function mergePersistedDisposition(
    existing: string | null | undefined,
    incoming: string | undefined,
    incomingAuthoritative: boolean
): string | undefined {
    if (incomingAuthoritative) return incoming ?? existing ?? undefined;
    if (existing === 'superseded') return existing;
    if (incoming === 'superseded') return incoming;
    if (existing === 'executed' || incoming === 'executed') return 'executed';
    return incoming ?? existing ?? undefined;
}

function turnStatusTransitionWhere(
    incoming: AgentRunStatus,
    authoritative: boolean
): Record<string, unknown> | undefined {
    if (incoming === 'unknown') return undefined;
    if (authoritative && TERMINAL_AGENT_RUN_STATUSES.has(incoming)) return {};
    if (TERMINAL_AGENT_RUN_STATUSES.has(incoming)) {
        return {
            authoritativeTerminal: false,
            status: { notIn: [...TERMINAL_AGENT_RUN_STATUSES] },
        };
    }
    if (incoming === 'waiting') {
        return { authoritativeTerminal: false, status: { in: ['unknown', 'queued', 'running'] } };
    }
    if (incoming === 'running') {
        return { authoritativeTerminal: false, status: { in: ['unknown', 'queued', 'running'] } };
    }
    return { authoritativeTerminal: false, status: { in: ['unknown', 'queued'] } };
}

function earliestDate(
    existing: Date | string | null | undefined,
    incoming: Date | undefined
): Date | undefined {
    const existingDate = toValidDate(existing);
    if (!existingDate) return incoming;
    if (!incoming) return existingDate;
    return existingDate.getTime() <= incoming.getTime() ? existingDate : incoming;
}

function latestDate(
    existing: Date | string | null | undefined,
    incoming: Date | undefined
): Date | undefined {
    const existingDate = toValidDate(existing);
    if (!existingDate) return incoming;
    if (!incoming) return existingDate;
    return existingDate.getTime() >= incoming.getTime() ? existingDate : incoming;
}

function toValidDate(value: Date | string | null | undefined): Date | undefined {
    if (value === null || value === undefined) return undefined;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
}

function shouldPreserveTerminal(existingStatus: string | undefined, incomingStatus: AgentRunStatus): boolean {
    if (existingStatus === undefined) return false;
    const normalizedExisting = normalizeStatus(existingStatus);
    return TERMINAL_AGENT_RUN_STATUSES.has(normalizedExisting) && normalizedExisting !== incomingStatus;
}

function semanticRunStatus(row: SemanticRunRow): AgentRunStatus {
    const status = normalizeStatus(row.status);
    if (TERMINAL_AGENT_RUN_STATUSES.has(status)) {
        return status;
    }
    if (!row.terminalAt) {
        return status;
    }
    if (row.cancelReason) {
        return 'canceled';
    }
    if (row.terminalCode || row.terminalMessage) {
        return 'failed';
    }
    return 'completed';
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
