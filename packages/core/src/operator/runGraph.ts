import type { SessionManager } from '../orchestration/SessionManager.js';

export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'unknown';

export type AgentRunGraph = {
    schemaVersion: 1;
    tenantId: string;
    taskId: string;
    root: AgentRunNode;
    nodes: AgentRunNode[];
    edges: AgentRunEdge[];
    turns: TurnRun[];
    memoryOps: MemoryOperationRun[];
    effects: EffectRun[];
    events: AgentRunEvent[];
    debug: {
        driverRuns: DriverRunView[];
    };
};

export type AgentRunNode = {
    id: string;
    kind: 'agent';
    tenantId: string;
    rootTaskId: string;
    taskId: string;
    parentTaskId?: string;
    agentId?: string;
    status: AgentRunStatus;
    inputPreview?: unknown;
    outputPreview?: unknown;
    traceId?: string;
    providerRunId?: string;
    startedAt?: string;
    finishedAt?: string;
};

export type AgentRunEdge = {
    id: string;
    kind: 'agent-child';
    rootTaskId: string;
    parentTaskId: string;
    childTaskId?: string;
    parentAgentId?: string;
    childAgentId?: string;
    token?: string;
    edgeToken?: string;
    edgeKind: 'delegates_to';
    status: AgentRunStatus;
    resultPreview?: unknown;
    error?: unknown;
    startedAt?: string;
    finishedAt?: string;
};

export type TurnRun = {
    id: string;
    rootTaskId: string;
    taskId: string;
    agentId?: string;
    status: AgentRunStatus;
    operation: 'turn.segment';
    turnSeq?: number;
    boundaryKind?: string;
    token?: string;
    traceId?: string;
    spanId?: string;
    idempotencyKey?: string;
    turnTraceRef?: {
        traceId?: string;
        spanId?: string;
        turnTraceId?: string;
    };
    cognition?: TurnCognition;
    llmCalls?: unknown[];
    memoryOps?: MemoryOperationRun[];
    providerRunId?: string;
};

export type TurnCognition = {
    turnId?: string;
    stageBefore?: string;
    stageAfter?: string;
    stageTransition?: unknown;
    transition?: unknown;
    intent?: unknown;
    shield?: unknown;
    perception?: unknown;
    execAction?: unknown;
    execResult?: unknown;
    timings?: unknown;
    usage?: unknown;
    mentalStateBeforeHash?: string;
    mentalStateAfterHash?: string;
    level?: 'summary' | 'full';
};

export type MemoryOperationRun = {
    id: string;
    taskId: string;
    seq: number;
    timestamp: string;
    op: 'read' | 'write' | 'delete';
    keys: string[];
    keyCount: number;
    backend?: string;
    source?: string;
    turnSeq?: number;
    agentId?: string;
    traceId?: string;
    spanId?: string;
};

export type EffectRun = {
    id: string;
    rootTaskId: string;
    taskId?: string;
    agentId?: string;
    operation: string;
    status: AgentRunStatus;
    token?: string;
    traceId?: string;
    providerRunId?: string;
    outboxRowId?: string;
    hiddenByDefault: boolean;
};

export type AgentRunEvent = {
    id: string;
    source: 'wm_event';
    type: string;
    taskId: string;
    seq: number;
    timestamp: string;
    visibility: 'operator' | 'debug';
    group: {
        taskId: string;
        agentId?: string;
        traceId?: string;
        spanId?: string;
        turnId?: string;
        token?: string;
    };
    payload: Record<string, unknown>;
};

export type DriverRunView = {
    id?: string;
    provider?: string;
    providerRunId?: string | null;
    providerTaskRunId?: string | null;
    tenantId: string;
    agentId?: string | null;
    taskId?: string | null;
    token?: string | null;
    traceId?: string | null;
    spanId?: string | null;
    idempotencyKey?: string | null;
    operation: string;
    status: string;
    outboxRowId?: string | null;
    rootTaskId?: string | null;
    parentTaskId?: string | null;
    parentAgentId?: string | null;
    childTaskId?: string | null;
    childAgentId?: string | null;
    edgeToken?: string | null;
    edgeKind?: string | null;
    turnSeq?: number | null;
    boundaryKind?: string | null;
    turnTraceId?: string | null;
    createdAt?: Date | string;
    updatedAt?: Date | string;
};

export type BuildAgentRunGraphParams = {
    tenantId: string;
    taskId: string;
    sessionManager: SessionManager;
    driverRuns?: DriverRunView[];
    events?: AgentRunSourceEvent[];
};

export type AgentRunSourceEvent = {
    eventId: string;
    seq: number;
    type: string;
    payload: Record<string, unknown>;
    createdAt: string;
};

export async function buildAgentRunGraph(
    params: BuildAgentRunGraphParams
): Promise<AgentRunGraph> {
    const [snapshot, loadedEvents] = await Promise.all([
        params.sessionManager.load(params.tenantId, params.taskId),
        params.events !== undefined
            ? Promise.resolve(params.events)
            : params.sessionManager.listEventsSince({
                  tenantId: params.tenantId,
                  sessionId: params.taskId,
                  sinceSeq: -1,
              }),
    ]);
    const events = [...loadedEvents].sort((a, b) => a.seq - b.seq);
    const driverRuns = params.driverRuns ?? [];
    const rootRun = chooseRootRun(driverRuns);
    const agentId = rootRun?.agentId ?? snapshot?.agentId ?? readSnapshotAgentId(snapshot?.snapshot);
    const rootStatus = deriveRootStatus(events, driverRuns);
    const rootStartedAt = firstEventTime(events) ?? rootRun?.createdAt;
    const rootFinishedAt =
        rootStatus === 'completed' || rootStatus === 'failed'
            ? latestTerminalEventTime(events) ?? latestTerminalDriverRunTime(driverRuns)
            : undefined;
    const root: AgentRunNode = {
        id: params.taskId,
        kind: 'agent',
        tenantId: params.tenantId,
        rootTaskId: params.taskId,
        taskId: params.taskId,
        ...(agentId ? { agentId } : {}),
        status: rootStatus,
        inputPreview: deriveInputPreview(events, snapshot?.snapshot),
        outputPreview: deriveOutputPreview(events),
        ...(rootRun?.traceId ? { traceId: rootRun.traceId } : {}),
        ...(rootRun?.providerRunId ? { providerRunId: rootRun.providerRunId } : {}),
        ...(rootStartedAt ? { startedAt: toIso(rootStartedAt) } : {}),
        ...(rootFinishedAt ? { finishedAt: rootFinishedAt } : {}),
    };

    const edges = buildChildEdges(params.taskId, agentId ?? undefined, events);
    const childNodes = edges.map((edge) => edgeToNode(params.tenantId, edge));
    const memoryOps = buildMemoryOps(params.taskId, events);
    const turns = buildTurnRuns(params.taskId, driverRuns, events, memoryOps);
    const effects = buildEffectRuns(params.taskId, driverRuns);
    const graphEvents = buildGraphEvents(params.taskId, agentId ?? undefined, events, driverRuns);

    return {
        schemaVersion: 1,
        tenantId: params.tenantId,
        taskId: params.taskId,
        root,
        nodes: [root, ...childNodes],
        edges,
        turns,
        memoryOps,
        effects,
        events: graphEvents,
        debug: {
            driverRuns,
        },
    };
}

function chooseRootRun(driverRuns: DriverRunView[]): DriverRunView | undefined {
    return driverRuns.find((run) => run.operation === 'agent.run') ??
        driverRuns.find((run) => run.operation === 'task.start');
}

function deriveRootStatus(events: AgentRunSourceEvent[], driverRuns: DriverRunView[]): AgentRunStatus {
    if (events.some((event) => event.type === 'task.failed')) {
        return 'failed';
    }
    if (events.some((event) => event.type === 'task.completed')) {
        return 'completed';
    }

    const latestTurnCompleted = [...events].reverse().find((event) => event.type === 'turn.completed');
    if (latestTurnCompleted !== undefined && eventHasSemanticFailure(latestTurnCompleted)) {
        return 'failed';
    }

    const terminalSegment = [...driverRuns]
        .reverse()
        .find((run) => run.operation === 'turn.segment' && run.boundaryKind !== null && run.boundaryKind !== undefined);
    if (terminalSegment?.boundaryKind === 'fail' || normalizeStatus(terminalSegment?.status) === 'failed') {
        return 'failed';
    }
    if (terminalSegment?.boundaryKind === 'complete') {
        return 'completed';
    }

    const root = chooseRootRun(driverRuns);
    const rootStatus = normalizeStatus(root?.status);
    if (rootStatus !== 'unknown' && rootStatus !== 'queued') {
        return rootStatus;
    }
    if (events.some((event) => event.type === 'task.started')) {
        return 'running';
    }
    return rootStatus;
}

function deriveInputPreview(
    events: AgentRunSourceEvent[],
    snapshot: Record<string, unknown> | undefined
): unknown {
    const started = events.find((event) => event.type === 'task.started');
    if (started !== undefined && Object.prototype.hasOwnProperty.call(started.payload, 'inputPreview')) {
        return started.payload.inputPreview;
    }
    const task = snapshot?.task;
    if (task !== undefined) {
        return task;
    }
    if (started !== undefined) {
        return started.payload;
    }
    return undefined;
}

function deriveOutputPreview(events: AgentRunSourceEvent[]): unknown {
    const completed = [...events].reverse().find((event) => event.type === 'task.completed');
    return completed?.payload;
}

function buildChildEdges(
    parentTaskId: string,
    parentAgentId: string | undefined,
    events: AgentRunSourceEvent[]
): AgentRunEdge[] {
    const byToken = new Map<string, AgentRunEdge>();
    for (const event of events) {
        if (!event.type.startsWith('task.child_')) {
            continue;
        }
        const token = stringField(event.payload, 'token') ?? `seq-${event.seq}`;
        const previous = byToken.get(token);
        const base: AgentRunEdge = previous ?? {
            id: `${parentTaskId}:${token}`,
            kind: 'agent-child',
            rootTaskId: parentTaskId,
            parentTaskId,
            ...(parentAgentId ? { parentAgentId } : {}),
            token,
            edgeToken: token,
            edgeKind: 'delegates_to',
            status: 'running',
            startedAt: event.createdAt,
        };
        const childAgentId =
            stringField(event.payload, 'agentId') ?? stringField(event.payload, 'childAgentId');
        const childTaskId = stringField(event.payload, 'childTaskId');
        byToken.set(token, {
            ...base,
            ...(childAgentId ? { childAgentId } : {}),
            ...(childTaskId ? { childTaskId } : {}),
            status: childStatus(event.type, event.payload),
            ...(event.type === 'task.child_completed' || event.type === 'task.child_failed'
                ? { finishedAt: event.createdAt }
                : {}),
            ...(Object.prototype.hasOwnProperty.call(event.payload, 'resultPreview')
                ? { resultPreview: event.payload.resultPreview }
                : {}),
            ...(Object.prototype.hasOwnProperty.call(event.payload, 'error')
                ? { error: event.payload.error }
                : {}),
        });
    }
    return [...byToken.values()];
}

function edgeToNode(tenantId: string, edge: AgentRunEdge): AgentRunNode {
    return {
        id: edge.childTaskId ?? edge.id,
        kind: 'agent',
        tenantId,
        rootTaskId: edge.rootTaskId,
        taskId: edge.childTaskId ?? edge.id,
        parentTaskId: edge.parentTaskId,
        ...(edge.childAgentId ? { agentId: edge.childAgentId } : {}),
        status: edge.status,
        outputPreview: edge.resultPreview,
    };
}

function buildTurnRuns(
    rootTaskId: string,
    driverRuns: DriverRunView[],
    events: AgentRunSourceEvent[],
    memoryOps: MemoryOperationRun[]
): TurnRun[] {
    const turnEvents = events.filter((event) => event.type === 'turn.completed');
    const cognitionByTurnSeq = new Map<number, AgentRunSourceEvent>();
    for (const event of turnEvents) {
        const turnSeq = numberField(event.payload, 'turnSeq');
        if (turnSeq !== undefined) {
            cognitionByTurnSeq.set(turnSeq, event);
        }
    }

    const driverTurns = driverRuns
        .filter((run) => run.operation === 'turn.segment' || run.operation === 'segment')
        .map((run, index): TurnRun => {
            const turnEvent = cognitionByTurnSeq.get(run.turnSeq ?? index + 1);
            return {
                id: run.providerTaskRunId ?? run.providerRunId ?? `turn-${index}`,
                rootTaskId: run.rootTaskId ?? rootTaskId,
                taskId: run.taskId ?? 'unknown',
                ...(run.agentId ? { agentId: run.agentId } : {}),
                status: deriveTurnStatus(run.status, turnEvent),
                operation: 'turn.segment',
                turnSeq: run.turnSeq ?? index + 1,
                ...(run.boundaryKind ? { boundaryKind: run.boundaryKind } : {}),
                ...(run.token ? { token: run.token } : {}),
                ...(run.traceId ? { traceId: run.traceId } : {}),
                ...(run.spanId ? { spanId: run.spanId } : {}),
                ...(run.idempotencyKey ? { idempotencyKey: run.idempotencyKey } : {}),
                turnTraceRef: {
                    ...(run.traceId ? { traceId: run.traceId } : {}),
                    ...(run.spanId ? { spanId: run.spanId } : {}),
                    ...(run.turnTraceId ? { turnTraceId: run.turnTraceId } : {}),
                },
                ...turnEventProjection(turnEvent, memoryOps),
                ...(run.providerRunId ? { providerRunId: run.providerRunId } : {}),
            };
        });
    const existingTurnSeqs = new Set(driverTurns.map((turn) => turn.turnSeq).filter((turnSeq): turnSeq is number => turnSeq !== undefined));
    const eventOnlyTurns = turnEvents
        .filter((event) => {
            const turnSeq = numberField(event.payload, 'turnSeq');
            return turnSeq !== undefined && !existingTurnSeqs.has(turnSeq);
        })
        .map((event, index): TurnRun => {
            const turnSeq = numberField(event.payload, 'turnSeq');
            const traceId = stringField(event.payload, 'traceId');
            const spanId = stringField(event.payload, 'spanId');
            return {
                id: stringField(event.payload, 'turnId') ?? `turn-event-${event.seq}-${index}`,
                rootTaskId,
                taskId: stringField(event.payload, 'taskId') ?? rootTaskId,
                ...(stringField(event.payload, 'agentId') ? { agentId: stringField(event.payload, 'agentId') } : {}),
                status: deriveTurnStatus('completed', event),
                operation: 'turn.segment',
                ...(turnSeq !== undefined ? { turnSeq } : {}),
                ...(traceId ? { traceId } : {}),
                ...(spanId ? { spanId } : {}),
                turnTraceRef: {
                    ...(traceId ? { traceId } : {}),
                    ...(spanId ? { spanId } : {}),
                },
                ...turnEventProjection(event, memoryOps),
            };
        });
    return [...driverTurns, ...eventOnlyTurns].sort((a, b) => (a.turnSeq ?? 0) - (b.turnSeq ?? 0));
}

function turnEventProjection(
    event: AgentRunSourceEvent | undefined,
    memoryOps: MemoryOperationRun[]
): Pick<TurnRun, 'cognition' | 'llmCalls' | 'memoryOps'> {
    if (event === undefined) {
        return {};
    }
    const turnSeq = numberField(event.payload, 'turnSeq');
    const level = event.payload.level === 'full' ? 'full' : event.payload.level === 'summary' ? 'summary' : undefined;
    return {
        cognition: {
            ...(stringField(event.payload, 'turnId') ? { turnId: stringField(event.payload, 'turnId') } : {}),
            ...(stringField(event.payload, 'stageBefore') ? { stageBefore: stringField(event.payload, 'stageBefore') } : {}),
            ...(stringField(event.payload, 'stageAfter') ? { stageAfter: stringField(event.payload, 'stageAfter') } : {}),
            ...(Object.prototype.hasOwnProperty.call(event.payload, 'stageTransition') ? { stageTransition: event.payload.stageTransition } : {}),
            ...(Object.prototype.hasOwnProperty.call(event.payload, 'transition') ? { transition: event.payload.transition } : {}),
            ...(Object.prototype.hasOwnProperty.call(event.payload, 'intent') ? { intent: event.payload.intent } : {}),
            ...(Object.prototype.hasOwnProperty.call(event.payload, 'shield') ? { shield: event.payload.shield } : {}),
            ...(Object.prototype.hasOwnProperty.call(event.payload, 'perception') ? { perception: event.payload.perception } : {}),
            ...(Object.prototype.hasOwnProperty.call(event.payload, 'execAction') ? { execAction: event.payload.execAction } : {}),
            ...(Object.prototype.hasOwnProperty.call(event.payload, 'execResult') ? { execResult: event.payload.execResult } : {}),
            ...(Object.prototype.hasOwnProperty.call(event.payload, 'timings') ? { timings: event.payload.timings } : {}),
            ...(Object.prototype.hasOwnProperty.call(event.payload, 'usage') ? { usage: event.payload.usage } : {}),
            ...(stringField(event.payload, 'mentalStateBeforeHash') ? { mentalStateBeforeHash: stringField(event.payload, 'mentalStateBeforeHash') } : {}),
            ...(stringField(event.payload, 'mentalStateAfterHash') ? { mentalStateAfterHash: stringField(event.payload, 'mentalStateAfterHash') } : {}),
            ...(level ? { level } : {}),
        },
        llmCalls: arrayField(event.payload, 'llmCalls'),
        memoryOps: turnSeq !== undefined
            ? memoryOps.filter((op) => op.turnSeq === turnSeq)
            : [],
    };
}

function buildMemoryOps(rootTaskId: string, events: AgentRunSourceEvent[]): MemoryOperationRun[] {
    return events
        .filter((event) => event.type === 'memory.read' || event.type === 'memory.write' || event.type === 'memory.delete')
        .map((event): MemoryOperationRun | undefined => {
            const op = event.type === 'memory.write' ? 'write' : event.type === 'memory.delete' ? 'delete' : 'read';
            const keys = stringArrayField(event.payload, 'keys');
            const keyCount = numberField(event.payload, 'keyCount') ?? keys.length;
            return {
                id: event.eventId,
                taskId: stringField(event.payload, 'taskId') ?? rootTaskId,
                seq: event.seq,
                timestamp: event.createdAt,
                op,
                keys,
                keyCount,
                ...(stringField(event.payload, 'backend') ? { backend: stringField(event.payload, 'backend') } : {}),
                ...(stringField(event.payload, 'source') ? { source: stringField(event.payload, 'source') } : {}),
                ...(numberField(event.payload, 'turnSeq') !== undefined ? { turnSeq: numberField(event.payload, 'turnSeq') } : {}),
                ...(stringField(event.payload, 'agentId') ? { agentId: stringField(event.payload, 'agentId') } : {}),
                ...(stringField(event.payload, 'traceId') ? { traceId: stringField(event.payload, 'traceId') } : {}),
                ...(stringField(event.payload, 'spanId') ? { spanId: stringField(event.payload, 'spanId') } : {}),
            };
        })
        .filter((event): event is MemoryOperationRun => event !== undefined);
}

function buildEffectRuns(rootTaskId: string, driverRuns: DriverRunView[]): EffectRun[] {
    return driverRuns
        .filter((run) => run.operation.startsWith('effect.') || run.operation === 'outbox.dispatch')
        .map((run, index) => ({
            id: run.providerTaskRunId ?? run.providerRunId ?? run.outboxRowId ?? `effect-${index}`,
            rootTaskId: run.rootTaskId ?? rootTaskId,
            ...(run.taskId ? { taskId: run.taskId } : {}),
            ...(run.agentId ? { agentId: run.agentId } : {}),
            operation: run.operation === 'outbox.dispatch' ? 'effect.outbox.dispatch' : run.operation,
            status: normalizeStatus(run.status),
            ...(run.token ? { token: run.token } : {}),
            ...(run.traceId ? { traceId: run.traceId } : {}),
            ...(run.providerRunId ? { providerRunId: run.providerRunId } : {}),
            ...(run.outboxRowId ? { outboxRowId: run.outboxRowId } : {}),
            hiddenByDefault: true,
        }));
}

function buildGraphEvents(
    rootTaskId: string,
    rootAgentId: string | undefined,
    events: AgentRunSourceEvent[],
    driverRuns: DriverRunView[]
): AgentRunEvent[] {
    const firstTraceId = driverRuns.find((run) => run.traceId)?.traceId ?? undefined;
    return events.map((event) => {
        const token = stringField(event.payload, 'token');
        const agentId =
            stringField(event.payload, 'agentId') ??
            stringField(event.payload, 'childAgentId') ??
            rootAgentId;
        const traceId = stringField(event.payload, 'traceId') ?? firstTraceId ?? undefined;
        const spanId = stringField(event.payload, 'spanId');
        return {
            id: event.eventId,
            source: 'wm_event',
            type: event.type,
            taskId: rootTaskId,
            seq: event.seq,
            timestamp: event.createdAt,
            visibility: event.type.startsWith('task.child_') ? 'operator' : 'debug',
            group: {
                taskId: rootTaskId,
                ...(agentId ? { agentId } : {}),
                ...(traceId ? { traceId } : {}),
                ...(spanId ? { spanId } : {}),
                ...(spanId ? { turnId: spanId } : {}),
                ...(token ? { token } : {}),
            },
            payload: event.payload,
        };
    });
}

function childStatus(type: string, payload: Record<string, unknown>): AgentRunStatus {
    if (type === 'task.child_failed') {
        return 'failed';
    }
    if (type === 'task.child_completed') {
        return 'completed';
    }
    if (type === 'task.child_input_required') {
        return 'running';
    }
    const status = stringField(payload, 'status');
    return normalizeStatus(status);
}

function deriveTurnStatus(status: string | undefined | null, event: AgentRunSourceEvent | undefined): AgentRunStatus {
    if (event !== undefined && eventHasSemanticFailure(event)) {
        return 'failed';
    }
    return normalizeStatus(status);
}

function eventHasSemanticFailure(event: AgentRunSourceEvent): boolean {
    return transitionResultOk(event.payload) === false;
}

function transitionResultOk(payload: Record<string, unknown>): boolean | undefined {
    const transition = objectField(payload, 'transition');
    const result = transition ? objectField(transition, 'result') : undefined;
    const ok = result?.ok;
    return typeof ok === 'boolean' ? ok : undefined;
}

function normalizeStatus(status: string | undefined | null): AgentRunStatus {
    if (status === 'completed' || status === 'succeeded' || status === 'success') {
        return 'completed';
    }
    if (status === 'failed' || status === 'error') {
        return 'failed';
    }
    if (status === 'running' || status === 'queued') {
        return status;
    }
    return 'unknown';
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
    const value = payload[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(payload: Record<string, unknown>, key: string): number | undefined {
    const value = payload[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function arrayField(payload: Record<string, unknown>, key: string): unknown[] {
    const value = payload[key];
    return Array.isArray(value) ? value : [];
}

function stringArrayField(payload: Record<string, unknown>, key: string): string[] {
    const value = payload[key];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function objectField(payload: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
    const value = payload[key];
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function readSnapshotAgentId(snapshot: Record<string, unknown> | undefined): string | undefined {
    const meta = snapshot?.meta;
    if (meta === undefined || meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
        return undefined;
    }
    const agentId = (meta as Record<string, unknown>).agentId;
    return typeof agentId === 'string' ? agentId : undefined;
}

function firstEventTime(events: AgentRunSourceEvent[]): string | undefined {
    return events.length > 0 ? events[0]?.createdAt : undefined;
}


function latestTerminalEventTime(events: AgentRunSourceEvent[]): string | undefined {
    const terminal = [...events]
        .reverse()
        .find((event) => event.type === 'task.completed' || event.type === 'task.failed');
    return terminal?.createdAt;
}

function latestTerminalDriverRunTime(driverRuns: DriverRunView[]): string | undefined {
    const terminal = [...driverRuns]
        .reverse()
        .find((run) => normalizeStatus(run.status) === 'completed' || normalizeStatus(run.status) === 'failed');
    const timestamp = terminal?.updatedAt ?? terminal?.createdAt;
    return timestamp !== undefined ? toIso(timestamp) : undefined;
}

function toIso(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : value;
}
