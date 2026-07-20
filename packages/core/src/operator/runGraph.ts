import type { SessionManager } from '../orchestration/SessionManager.js';
import { operatorPayloadEnvelope } from './payloadBudget.js';
import { readTaskTurnCoordinator } from '../orchestration/TaskTurnCoordinator.js';
import { readDurableTaskTerminal } from '../orchestration/TaskLifecycle.js';

export type AgentRunStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'canceled' | 'unknown';

export type AgentRunGraph = {
    schemaVersion: 2;
    tenantId: string;
    taskId: string;
    root: AgentRunNode;
    nodes: AgentRunNode[];
    edges: AgentRunEdge[];
    turns: TurnRun[];
    memoryOps: MemoryOperationRun[];
    effects: EffectRun[];
    events: AgentRunEvent[];
    coordination: TaskCoordinationView;
    debug: {
        driverRuns: DriverRunView[];
    };
    caps?: AgentRunGraphCaps;
    collapsedBranches?: CollapsedGraphBranch[];
    projection?: OperatorProjectionInfo;
};

export type TaskCoordinationView = {
    taskId: string;
    state: 'idle' | 'owned' | 'queued' | 'recovering' | 'terminal';
    health: 'healthy' | 'attention' | 'stuck';
    observedAt: string;
    requestedGeneration: string;
    completedGeneration: string;
    active?: {
        claimId: string;
        fence: string;
        ownerId: string;
        turnSeq: number;
        phase: 'claimed' | 'executing' | 'committing';
        acquiredAt: string;
        heartbeatAt: string;
        expiresAt: string;
        leaseState: 'live' | 'expiring' | 'expired';
    };
    dispatchIntent?: {
        generation: string;
        state: 'pending' | 'enqueued' | 'overdue';
        createdAt: string;
        enqueuedAt?: string;
    };
    issues: Array<'claim_expired' | 'runnable_without_owner' | 'dispatch_overdue' | 'terminal_projection_mismatch' | 'projection_partial'>;
};

export type AgentRunGraphCaps = {
    nodeLimit: number;
    edgeLimit: number;
    depthLimit: number;
    truncated: boolean;
};

export type CollapsedGraphBranch = {
    parentTaskId: string;
    hiddenChildCount: number;
    expandCursor: string;
    reason: 'node_limit' | 'depth_limit' | 'manual';
};

export type OperatorProjectionInfo = {
    source: 'bridge' | 'semantic';
    lagMs?: number;
    partial: boolean;
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
    error?: unknown;
    traceId?: string;
    providerRunId?: string;
    executionOrigin?: 'runtime' | 'cache' | 'projected';
    cancellation?: AgentRunCancellation;
    startedAt?: string;
    finishedAt?: string;
};

export type AgentRunCancellation = {
    requested: boolean;
    reason?: string;
    requestedAt?: string;
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
    executionOrigin?: 'runtime' | 'cache' | 'projected';
    inputPreview?: unknown;
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
    attemptKey?: string;
    attemptSeq?: number;
    disposition?: 'executed' | 'queued' | 'matching_replay' | 'superseded' | 'terminal_replay';
    claimId?: string;
    turnFence?: string;
    claimedGeneration?: string;
    authoritativeTerminal?: boolean;
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
    startedAt?: string;
    finishedAt?: string;
    error?: unknown;
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
    resultKeys?: string[];
    resultCount?: number;
    query?: unknown;
    status?: string;
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
    error?: unknown;
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
    claimId?: string | null;
    turnFence?: string | null;
    claimedGeneration?: string | null;
    turnDisposition?: string | null;
    attemptSeq?: number | null;
    rootRunKey?: string | null;
    error?: unknown;
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
    sessionId?: string;
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
    const events = [...loadedEvents].sort((a, b) => (a.createdAt === b.createdAt ? a.seq - b.seq : a.createdAt.localeCompare(b.createdAt)));
    const rootEvents = eventsForTask(events, params.taskId);
    const driverRuns = params.driverRuns ?? [];
    const rootDriverRuns = driverRuns.filter((run) => run.taskId === params.taskId);
    const rootRun = chooseRootRun(rootDriverRuns);
    const agentId = rootRun?.agentId ?? snapshot?.agentId ?? readSnapshotAgentId(snapshot?.snapshot);
    const rootStatus = deriveRootStatus(rootEvents, rootDriverRuns);
    const rootError = rootStatus === 'failed' ? rootRun?.error : undefined;
    const rootCancellation = readCancellation(snapshot?.snapshot);
    const rootStartedAt = firstEventTime(rootEvents) ?? rootRun?.createdAt;
    const rootFinishedAt =
        rootStatus === 'canceled'
            ? latestTerminalEventTime(rootEvents) ?? driverRunTime(rootRun)
            : isTerminalRunStatus(rootStatus)
            ? latestTerminalEventTime(rootEvents) ?? latestTerminalDriverRunTime(rootDriverRuns)
            : undefined;
    const root: AgentRunNode = {
        id: params.taskId,
        kind: 'agent',
        tenantId: params.tenantId,
        rootTaskId: params.taskId,
        taskId: params.taskId,
        ...(agentId ? { agentId } : {}),
        status: rootStatus,
        inputPreview: deriveInputPreview(rootEvents, snapshot?.snapshot),
        outputPreview: deriveOutputPreview(rootEvents),
        ...(rootError ? { error: rootError } : {}),
        ...(rootRun?.traceId ? { traceId: rootRun.traceId } : {}),
        ...(rootRun?.providerRunId ? { providerRunId: rootRun.providerRunId } : {}),
        ...(rootCancellation ? { cancellation: rootCancellation } : {}),
        ...(rootStartedAt ? { startedAt: toIso(rootStartedAt) } : {}),
        ...(rootFinishedAt ? { finishedAt: rootFinishedAt } : {}),
    };

    const rawEdges = buildChildEdges(params.taskId, agentId ?? undefined, events);
    const childNodes = rawEdges.map((edge) => edgeToNode(params.tenantId, edge, events, driverRuns));
    const childNodeByTaskId = new Map(childNodes.map((node) => [node.taskId, node]));
    const edges = rawEdges.map((edge) => {
        const childNode = edge.childTaskId ? childNodeByTaskId.get(edge.childTaskId) : undefined;
        if (edge.status !== 'unknown' || childNode === undefined || childNode.status === 'unknown') {
            return edge;
        }
        return {
            ...edge,
            status: childNode.status,
            ...(childNode.finishedAt ? { finishedAt: childNode.finishedAt } : {}),
            ...(childNode.error ? { error: childNode.error } : {}),
        };
    });
    const memoryOps = buildMemoryOps(params.taskId, events);
    const terminal = readDurableTaskTerminal(snapshot?.snapshot);
    const turns = buildTurnRuns(params.taskId, driverRuns, events, memoryOps, terminal?.turnClaim);
    const effects = buildEffectRuns(params.taskId, driverRuns, events);
    const graphEvents = buildGraphEvents(params.taskId, agentId ?? undefined, events, driverRuns);
    const coordination = buildTaskCoordinationView(params.taskId, snapshot?.snapshot);
    if (terminal?.turnClaim && !turns.some((turn) => turn.authoritativeTerminal === true)) {
        coordination.issues = [...coordination.issues, 'terminal_projection_mismatch'];
        coordination.health = 'attention';
    }

    return {
        schemaVersion: 2,
        tenantId: params.tenantId,
        taskId: params.taskId,
        root,
        nodes: [root, ...childNodes],
        edges,
        turns,
        memoryOps,
        effects,
        events: graphEvents,
        coordination,
        debug: {
            driverRuns,
        },
    };
}

function chooseRootRun(driverRuns: DriverRunView[]): DriverRunView | undefined {
    return driverRuns.find((run) => run.operation === 'agent.run') ??
        driverRuns.find((run) => run.operation === 'task.start');
}

export function buildTaskCoordinationView(
    taskId: string,
    snapshot: unknown,
    nowMs = Date.now()
): TaskCoordinationView {
    const observedAt = new Date(nowMs).toISOString();
    const terminal = readDurableTaskTerminal(snapshot);
    let coordinator;
    try {
        coordinator = readTaskTurnCoordinator(snapshot, { taskId });
    } catch {
        return {
            taskId,
            state: terminal ? 'terminal' : 'idle',
            health: terminal ? 'healthy' : 'attention',
            observedAt,
            requestedGeneration: '0',
            completedGeneration: '0',
            issues: terminal ? [] : ['projection_partial'],
        };
    }
    const issues: TaskCoordinationView['issues'] = [];
    const requested = BigInt(coordinator.requestedGeneration);
    const completed = BigInt(coordinator.completedGeneration);
    const activeExpiry = coordinator.active ? Date.parse(coordinator.active.expiresAt) : undefined;
    const leaseState = activeExpiry === undefined
        ? undefined
        : activeExpiry <= nowMs
            ? 'expired' as const
            : activeExpiry - nowMs <= 40_000
                ? 'expiring' as const
                : 'live' as const;
    if (leaseState === 'expired') issues.push('claim_expired');
    if (!terminal && requested > completed && coordinator.active === undefined) issues.push('runnable_without_owner');
    const intentAge = coordinator.dispatchIntent ? nowMs - Date.parse(coordinator.dispatchIntent.createdAt) : 0;
    if (coordinator.dispatchIntent && coordinator.dispatchIntent.enqueuedAt === undefined && intentAge > 30_000) {
        issues.push('dispatch_overdue');
    }
    const state: TaskCoordinationView['state'] = terminal
        ? 'terminal'
        : coordinator.active
            ? requested > BigInt(coordinator.active.claimedGeneration) ? 'queued' : 'owned'
            : coordinator.dispatchIntent ? 'recovering'
            : requested > completed ? 'queued' : 'idle';
    const health: TaskCoordinationView['health'] = issues.includes('claim_expired') || issues.includes('dispatch_overdue')
        ? 'stuck'
        : issues.length > 0 || leaseState === 'expiring' ? 'attention' : 'healthy';
    return {
        taskId,
        state,
        health,
        observedAt,
        requestedGeneration: coordinator.requestedGeneration,
        completedGeneration: coordinator.completedGeneration,
        ...(coordinator.active && leaseState ? {
            active: {
                claimId: coordinator.active.claimId,
                fence: coordinator.active.fence,
                ownerId: coordinator.active.ownerId,
                turnSeq: coordinator.active.turnSeq,
                phase: coordinator.active.phase,
                acquiredAt: coordinator.active.acquiredAt,
                heartbeatAt: coordinator.active.heartbeatAt,
                expiresAt: coordinator.active.expiresAt,
                leaseState,
            },
        } : {}),
        ...(coordinator.dispatchIntent ? {
            dispatchIntent: {
                generation: coordinator.dispatchIntent.generation,
                state: coordinator.dispatchIntent.enqueuedAt
                    ? 'enqueued'
                    : intentAge > 30_000 ? 'overdue' : 'pending',
                createdAt: coordinator.dispatchIntent.createdAt,
                ...(coordinator.dispatchIntent.enqueuedAt ? { enqueuedAt: coordinator.dispatchIntent.enqueuedAt } : {}),
            },
        } : {}),
        issues,
    };
}

function isTurnDisposition(value: unknown): value is NonNullable<TurnRun['disposition']> {
    return value === 'executed' || value === 'queued' || value === 'matching_replay' ||
        value === 'superseded' || value === 'terminal_replay';
}

function deriveRootStatus(events: AgentRunSourceEvent[], driverRuns: DriverRunView[]): AgentRunStatus {
    if (events.some((event) => event.type === 'task.failed')) {
        return 'failed';
    }
    if (events.some((event) => event.type === 'task.completed')) {
        return 'completed';
    }

    const latestTurnCompleted = [...events].reverse().find((event) => event.type === 'turn.completed');
    const root = chooseRootRun(driverRuns);
    const rootStatus = normalizeStatus(root?.status);
    if (rootStatus === 'canceled') {
        return 'canceled';
    }

    const latestSegment = [...driverRuns]
        .reverse()
        .find((run) => run.operation === 'turn.segment' || run.operation === 'segment');
    if (normalizeStatus(latestSegment?.status) === 'running') {
        return 'running';
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

    if (rootStatus === 'failed') {
        return 'failed';
    }

    const latestTurnBoundary = latestTurnCompleted ? turnTransitionKind(latestTurnCompleted.payload) : undefined;
    if (isAwaitBoundary(latestTurnBoundary)) {
        return 'running';
    }

    if (rootStatus === 'completed') {
        return 'completed';
    }

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

function readCancellation(snapshot: Record<string, unknown> | undefined): AgentRunCancellation | undefined {
    if (snapshot === undefined) {
        return undefined;
    }
    const meta = objectField(snapshot, 'meta');
    if (meta === undefined) {
        return undefined;
    }
    const cancellation = objectField(meta, 'cancellation');
    if (cancellation === undefined) {
        return undefined;
    }
    const requested = cancellation.requested === true;
    const reason = stringField(cancellation, 'reason');
    const requestedAt = stringField(cancellation, 'requestedAt');
    return {
        requested,
        ...(reason ? { reason } : {}),
        ...(requestedAt ? { requestedAt } : {}),
    };
}

function deriveOutputPreview(events: AgentRunSourceEvent[]): unknown {
    const completed = [...events].reverse().find((event) => event.type === 'task.completed');
    return completed?.payload;
}

function buildChildEdges(
    rootTaskId: string,
    rootAgentId: string | undefined,
    events: AgentRunSourceEvent[]
): AgentRunEdge[] {
    const byToken = new Map<string, AgentRunEdge>();
    for (const event of events) {
        if (!event.type.startsWith('task.child_')) {
            continue;
        }
        const parentTaskId = event.sessionId ?? rootTaskId;
        const token = stringField(event.payload, 'token') ?? `seq-${event.seq}`;
        const key = `${parentTaskId}:${token}`;
        const previous = byToken.get(key);
        const base: AgentRunEdge = previous ?? {
            id: key,
            kind: 'agent-child',
            rootTaskId,
            parentTaskId,
            ...(parentTaskId === rootTaskId && rootAgentId ? { parentAgentId: rootAgentId } : {}),
            token,
            edgeToken: token,
            edgeKind: 'delegates_to',
            status: 'running',
            startedAt: event.createdAt,
        };
        const childAgentId =
            stringField(event.payload, 'agentId') ?? stringField(event.payload, 'childAgentId');
        const childTaskId = stringField(event.payload, 'childTaskId');
        byToken.set(key, {
            ...base,
            ...(childAgentId ? { childAgentId } : {}),
            ...(childTaskId ? { childTaskId } : {}),
            status: childStatus(event.type, event.payload),
            ...(event.type === 'task.child_completed' || event.type === 'task.child_failed'
                ? { finishedAt: event.createdAt }
                : {}),
            ...(event.type === 'task.child_completed' && childCompletionOrigin(event.payload) === 'cache'
                ? { executionOrigin: 'cache' as const }
                : {}),
            ...(Object.prototype.hasOwnProperty.call(event.payload, 'inputPreview')
                ? { inputPreview: event.payload.inputPreview }
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

function edgeToNode(
    tenantId: string,
    edge: AgentRunEdge,
    events: AgentRunSourceEvent[],
    driverRuns: DriverRunView[]
): AgentRunNode {
    const taskId = edge.childTaskId ?? edge.id;
    const childEvents = eventsForTask(events, taskId);
    const childDriverRuns = driverRuns.filter((run) => run.taskId === taskId);
    const childRun = chooseRootRun(childDriverRuns);
    const status = deriveChildNodeStatus(edge.status, childEvents, childDriverRuns);
    const error = status === 'failed' ? childRun?.error ?? edge.error : undefined;
    const startedAt = firstEventTime(childEvents) ?? childRun?.createdAt ?? edge.startedAt;
    const finishedAt =
        isTerminalRunStatus(status)
            ? latestTerminalEventTime(childEvents) ?? latestTerminalDriverRunTime(childDriverRuns) ?? edge.finishedAt
            : undefined;
    return {
        id: taskId,
        kind: 'agent',
        tenantId,
        rootTaskId: edge.rootTaskId,
        taskId,
        parentTaskId: edge.parentTaskId,
        ...(edge.childAgentId ? { agentId: edge.childAgentId } : {}),
        status,
        inputPreview: deriveInputPreview(childEvents, undefined) ?? edge.inputPreview,
        outputPreview: deriveOutputPreview(childEvents) ?? edge.resultPreview,
        ...(error ? { error } : {}),
        ...(childRun?.traceId ? { traceId: childRun.traceId } : {}),
        ...(childRun?.providerRunId ? { providerRunId: childRun.providerRunId } : {}),
        executionOrigin: childExecutionOrigin(edge, childEvents, childDriverRuns),
        ...(startedAt ? { startedAt: toIso(startedAt) } : {}),
        ...(finishedAt ? { finishedAt } : {}),
    };
}

function childExecutionOrigin(
    edge: AgentRunEdge,
    events: AgentRunSourceEvent[],
    driverRuns: DriverRunView[]
): AgentRunNode['executionOrigin'] {
    if (edge.executionOrigin === 'cache') return 'cache';
    if (driverRuns.length > 0) return 'runtime';
    if (edge.status === 'completed' && events.length === 0) return 'projected';
    return undefined;
}

function childCompletionOrigin(payload: Record<string, unknown>): 'cache' | undefined {
    const metadata = payload.executionMetadata;
    if (
        metadata &&
        typeof metadata === 'object' &&
        (metadata as Record<string, unknown>).origin === 'cache'
    ) {
        return 'cache';
    }
    return undefined;
}

function eventsForTask(events: AgentRunSourceEvent[], taskId: string): AgentRunSourceEvent[] {
    return events.filter((event) => (event.sessionId ?? stringField(event.payload, 'taskId')) === taskId);
}

function deriveChildNodeStatus(
    edgeStatus: AgentRunStatus,
    events: AgentRunSourceEvent[],
    driverRuns: DriverRunView[]
): AgentRunStatus {
    if (events.some((event) => event.type === 'task.failed')) return 'failed';
    if (events.some((event) => event.type === 'task.completed')) return 'completed';
    const driverStatus = deriveRootStatus(events, driverRuns);
    if (driverStatus !== 'unknown' && driverStatus !== 'queued') return driverStatus;
    const latestTurnCompleted = [...events].reverse().find((event) => event.type === 'turn.completed');
    const latestTurnBoundary = latestTurnCompleted ? turnTransitionKind(latestTurnCompleted.payload) : undefined;
    if (isAwaitBoundary(latestTurnBoundary)) return 'running';
    return edgeStatus;
}

function buildTurnRuns(
    rootTaskId: string,
    driverRuns: DriverRunView[],
    events: AgentRunSourceEvent[],
    memoryOps: MemoryOperationRun[],
    terminalClaim?: { claimId: string; fence: string; generation: string; turnSeq: number }
): TurnRun[] {
    const turnEvents = events.filter((event) => event.type === 'turn.completed');
    const turnStartedEvents = events.filter((event) => event.type === 'turn.started');
    const turnStartedByTurn = new Map<string, AgentRunSourceEvent>();
    for (const event of turnStartedEvents) {
        const turnSeq = numberField(event.payload, 'turnSeq');
        if (turnSeq !== undefined) {
            turnStartedByTurn.set(turnKey(stringField(event.payload, 'taskId') ?? event.sessionId ?? rootTaskId, turnSeq), event);
        }
    }
    const cognitionByTurn = new Map<string, AgentRunSourceEvent>();
    for (const event of turnEvents) {
        const turnSeq = numberField(event.payload, 'turnSeq');
        if (turnSeq !== undefined) {
            cognitionByTurn.set(turnKey(stringField(event.payload, 'taskId') ?? event.sessionId ?? rootTaskId, turnSeq), event);
        }
    }

    const driverTurns = driverRuns
        .filter((run) => run.operation === 'turn.segment' || run.operation === 'segment')
        .map((run, index): TurnRun => {
            const turnSeq = run.turnSeq ?? undefined;
            const key = turnSeq === undefined ? undefined : turnKey(run.taskId ?? rootTaskId, turnSeq);
            const turnEvent = key === undefined ? undefined : cognitionByTurn.get(key);
            const startedEvent = key === undefined ? undefined : turnStartedByTurn.get(key);
            const status = deriveTurnStatus(run.status, turnEvent);
            const startedAt = run.createdAt ?? startedEvent?.createdAt;
            const terminalTimestamp = run.updatedAt ?? run.createdAt ?? turnEvent?.createdAt ?? startedEvent?.createdAt;
            const finishedAt = isTerminalRunStatus(status)
                ? terminalTimestamp
                : undefined;
            return {
                id: run.providerTaskRunId ?? run.providerRunId ?? `turn-${index}`,
                rootTaskId: run.rootTaskId ?? rootTaskId,
                taskId: run.taskId ?? 'unknown',
                ...(run.agentId ? { agentId: run.agentId } : {}),
                status,
                operation: 'turn.segment',
                ...(turnSeq !== undefined ? { turnSeq } : {}),
                attemptKey: run.id ?? run.providerTaskRunId ?? run.providerRunId ?? `attempt-${index}`,
                ...(run.attemptSeq !== null && run.attemptSeq !== undefined ? { attemptSeq: run.attemptSeq } : {}),
                ...(isTurnDisposition(run.turnDisposition) ? { disposition: run.turnDisposition } : {}),
                ...(run.claimId ? { claimId: run.claimId } : {}),
                ...(run.turnFence ? { turnFence: run.turnFence } : {}),
                ...(run.claimedGeneration ? { claimedGeneration: run.claimedGeneration } : {}),
                ...(run.claimId && terminalClaim?.claimId === run.claimId && terminalClaim.fence === run.turnFence
                    ? { authoritativeTerminal: true }
                    : {}),
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
                ...(startedAt ? { startedAt: toIso(startedAt) } : {}),
                ...(finishedAt ? { finishedAt: toIso(finishedAt) } : {}),
                ...(status === 'failed' && run.error ? { error: run.error } : {}),
            };
        });
    const existingTurns = new Set(driverTurns.flatMap((turn) => turn.turnSeq === undefined ? [] : [turnKey(turn.taskId, turn.turnSeq)]));
    const eventOnlyTurns = turnEvents
        .filter((event) => {
            const turnSeq = numberField(event.payload, 'turnSeq');
            const taskId = stringField(event.payload, 'taskId') ?? event.sessionId ?? rootTaskId;
            return turnSeq !== undefined && !existingTurns.has(turnKey(taskId, turnSeq));
        })
        .map((event, index): TurnRun => {
            const turnSeq = numberField(event.payload, 'turnSeq');
            const taskId = stringField(event.payload, 'taskId') ?? event.sessionId ?? rootTaskId;
            const startedEvent = turnSeq !== undefined ? turnStartedByTurn.get(turnKey(taskId, turnSeq)) : undefined;
            const traceId = stringField(event.payload, 'traceId');
            const spanId = stringField(event.payload, 'spanId');
            return {
                id: stringField(event.payload, 'turnId') ?? `turn-event-${event.seq}-${index}`,
                rootTaskId,
                taskId,
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
                startedAt: startedEvent?.createdAt ?? event.createdAt,
                finishedAt: event.createdAt,
            };
        });
    const existingCompletedOrDriverTurns = new Set([
        ...existingTurns,
        ...eventOnlyTurns.flatMap((turn) => turn.turnSeq === undefined ? [] : [turnKey(turn.taskId, turn.turnSeq)]),
    ]);
    const eventOnlyRunningTurns = turnStartedEvents
        .filter((event) => {
            const turnSeq = numberField(event.payload, 'turnSeq');
            const taskId = stringField(event.payload, 'taskId') ?? event.sessionId ?? rootTaskId;
            return turnSeq !== undefined && !existingCompletedOrDriverTurns.has(turnKey(taskId, turnSeq));
        })
        .map((event, index): TurnRun => {
            const turnSeq = numberField(event.payload, 'turnSeq');
            const taskId = stringField(event.payload, 'taskId') ?? event.sessionId ?? rootTaskId;
            const traceId = stringField(event.payload, 'traceId');
            const spanId = stringField(event.payload, 'spanId');
            return {
                id: stringField(event.payload, 'turnId') ?? `turn-started-${event.seq}-${index}`,
                rootTaskId,
                taskId,
                ...(stringField(event.payload, 'agentId') ? { agentId: stringField(event.payload, 'agentId') } : {}),
                status: 'running',
                operation: 'turn.segment',
                ...(turnSeq !== undefined ? { turnSeq } : {}),
                ...(traceId ? { traceId } : {}),
                ...(spanId ? { spanId } : {}),
                turnTraceRef: {
                    ...(traceId ? { traceId } : {}),
                    ...(spanId ? { spanId } : {}),
                },
                startedAt: event.createdAt,
                memoryOps: turnSeq !== undefined
                    ? memoryOps.filter((op) => op.taskId === taskId && op.turnSeq === turnSeq)
                    : [],
            };
        });
    return finalizeSupersededRunningTurns(
        [...driverTurns, ...eventOnlyTurns, ...eventOnlyRunningTurns]
            .sort((a, b) => {
                if (a.taskId !== b.taskId) return a.taskId.localeCompare(b.taskId);
                return (a.turnSeq ?? 0) - (b.turnSeq ?? 0);
            })
    );
}

function finalizeSupersededRunningTurns(turns: TurnRun[]): TurnRun[] {
    const maxTurnSeqByTask = new Map<string, number>();
    for (const turn of turns) {
        if (turn.turnSeq === undefined) continue;
        const current = maxTurnSeqByTask.get(turn.taskId) ?? Number.NEGATIVE_INFINITY;
        if (turn.turnSeq > current) {
            maxTurnSeqByTask.set(turn.taskId, turn.turnSeq);
        }
    }

    return turns.map((turn) => {
        if (turn.turnSeq === undefined || turn.error !== undefined) return turn;
        const maxTurnSeq = maxTurnSeqByTask.get(turn.taskId);
        if (maxTurnSeq === undefined || turn.turnSeq >= maxTurnSeq) return turn;
        if (turn.status !== 'running' && turn.status !== 'queued') return turn;
        return { ...turn, status: 'completed' };
    });
}

function turnKey(taskId: string, turnSeq: number): string {
    return `${taskId}:${turnSeq}`;
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
                ...(arrayField(event.payload, 'resultKeys').length > 0 ? { resultKeys: stringArrayField(event.payload, 'resultKeys') } : {}),
                ...(numberField(event.payload, 'resultCount') !== undefined ? { resultCount: numberField(event.payload, 'resultCount') } : {}),
                ...(Object.prototype.hasOwnProperty.call(event.payload, 'query') ? { query: event.payload.query } : {}),
                ...(stringField(event.payload, 'status') ? { status: stringField(event.payload, 'status') } : {}),
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

function buildEffectRuns(rootTaskId: string, driverRuns: DriverRunView[], events: AgentRunSourceEvent[]): EffectRun[] {
    const driverEffects = driverRuns
        .filter((run) =>
            run.operation.startsWith('effect.') ||
            run.operation === 'outbox.dispatch' ||
            run.operation === 'timer.schedule' ||
            run.operation === 'timer.fire'
        )
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
            ...(run.error ? { error: run.error } : {}),
        }));
    const budgetEffects = events
        .filter((event) => event.type === 'payload.budget_exceeded' || event.type === 'wm.snapshot_limit' || event.type === 'observability.incident')
        .map((event): EffectRun => {
            if (event.type === 'observability.incident') {
                const operation = stringField(event.payload, 'operation') ?? 'observability.incident';
                const message = stringField(event.payload, 'message') ?? 'Observability incident recorded.';
                return {
                    id: event.eventId,
                    rootTaskId,
                    taskId: event.sessionId ?? rootTaskId,
                    operation,
                    status: 'failed',
                    hiddenByDefault: false,
                    traceId: stringField(event.payload, 'traceId'),
                    providerRunId: stringField(event.payload, 'providerRunId'),
                    error: {
                        code: stringField(event.payload, 'errorCode') ?? 'OBSERVABILITY_INCIDENT',
                        message,
                        eventType: stringField(event.payload, 'eventType'),
                        surface: stringField(event.payload, 'surface'),
                        providerTaskRunId: stringField(event.payload, 'providerTaskRunId'),
                    },
                };
            }
            const code = stringField(event.payload, 'code') ?? (event.type === 'wm.snapshot_limit' ? 'LIMIT_WM_SNAPSHOT_TOO_LARGE' : 'LIMIT_OPERATOR_RESPONSE_TOO_LARGE');
            const message = stringField(event.payload, 'message') ?? 'Payload budget exceeded.';
            return {
                id: event.eventId,
                rootTaskId,
                taskId: event.sessionId ?? rootTaskId,
                operation: event.type === 'wm.snapshot_limit' ? 'wm.snapshot_budget' : 'payload.budget',
                status: 'failed',
                hiddenByDefault: false,
                error: {
                    code,
                    message,
                    limitBytes: numberField(event.payload, 'limitBytes'),
                    actualBytes: numberField(event.payload, 'actualBytes'),
                    fieldPath: stringField(event.payload, 'fieldPath'),
                    eventType: stringField(event.payload, 'eventType'),
                },
            };
        });
    return [...driverEffects, ...budgetEffects];
}

function buildGraphEvents(
    rootTaskId: string,
    rootAgentId: string | undefined,
    events: AgentRunSourceEvent[],
    driverRuns: DriverRunView[]
): AgentRunEvent[] {
    const firstTraceId = driverRuns.find((run) => run.traceId)?.traceId ?? undefined;
    const agentIdByTaskId = new Map(
        driverRuns
            .filter((run) => typeof run.taskId === 'string' && typeof run.agentId === 'string')
            .map((run) => [run.taskId as string, run.agentId as string])
    );
    return events.map((event) => {
        const token = stringField(event.payload, 'token');
        const eventTaskId = event.sessionId ?? rootTaskId;
        const agentId =
            stringField(event.payload, 'agentId') ??
            stringField(event.payload, 'childAgentId') ??
            agentIdByTaskId.get(eventTaskId) ??
            rootAgentId;
        const traceId = stringField(event.payload, 'traceId') ?? firstTraceId ?? undefined;
        const spanId = stringField(event.payload, 'spanId');
        return {
            id: event.eventId,
            source: 'wm_event',
            type: event.type,
            taskId: eventTaskId,
            seq: event.seq,
            timestamp: event.createdAt,
            visibility: event.type.startsWith('task.child_') || event.type.startsWith('task.tool_') ? 'operator' : 'debug',
            group: {
                taskId: eventTaskId,
                ...(agentId ? { agentId } : {}),
                ...(traceId ? { traceId } : {}),
                ...(spanId ? { spanId } : {}),
                ...(spanId ? { turnId: spanId } : {}),
                ...(token ? { token } : {}),
            },
            payload: { envelope: operatorPayloadEnvelope(event.payload) },
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
    const driverStatus = normalizeStatus(status);
    if (driverStatus === 'failed') {
        return 'failed';
    }
    if (driverStatus === 'completed') {
        return 'completed';
    }
    if (event !== undefined) {
        const boundaryKind = turnTransitionKind(event.payload);
        if (isAwaitBoundary(boundaryKind)) {
            return 'running';
        }
        if (boundaryKind === 'complete') {
            return 'completed';
        }
        if (boundaryKind === 'fail') {
            return 'failed';
        }
    }
    return driverStatus;
}

function turnTransitionKind(payload: Record<string, unknown>): string | undefined {
    const transition = objectField(payload, 'transition');
    return transition ? stringField(transition, 'kind') : undefined;
}

function isAwaitBoundary(value: string | undefined): boolean {
    return value === 'await_input' || value === 'await_tool' || value === 'await_child' || value === 'await_event';
}

function normalizeStatus(status: string | undefined | null): AgentRunStatus {
    if (status === 'completed' || status === 'succeeded' || status === 'success') {
        return 'completed';
    }
    if (status === 'failed' || status === 'error') {
        return 'failed';
    }
    if (status === 'canceled' || status === 'cancelled') {
        return 'canceled';
    }
    if (status === 'running' || status === 'queued' || status === 'waiting') {
        return status;
    }
    return 'unknown';
}

function isTerminalRunStatus(status: AgentRunStatus): boolean {
    return status === 'completed' || status === 'failed' || status === 'canceled';
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
        .find((event) => event.type === 'task.completed' || event.type === 'task.failed' || event.type === 'task.canceled');
    return terminal?.createdAt;
}

function latestTerminalDriverRunTime(driverRuns: DriverRunView[]): string | undefined {
    const terminalTimes = driverRuns
        .filter((run) => isTerminalRunStatus(normalizeStatus(run.status)))
        .flatMap((run) => {
            const timestamp = run.updatedAt ?? run.createdAt;
            return timestamp !== undefined ? [toIso(timestamp)] : [];
        })
        .sort();
    return terminalTimes.at(-1);
}

function driverRunTime(run: DriverRunView | undefined): string | undefined {
    const timestamp = run?.updatedAt ?? run?.createdAt;
    return timestamp !== undefined ? toIso(timestamp) : undefined;
}

function toIso(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : value;
}
