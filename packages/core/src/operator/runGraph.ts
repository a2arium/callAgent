import type { SessionManager } from '../orchestration/SessionManager.js';
import { operatorPayloadEnvelope } from './payloadBudget.js';
import { readTaskTurnCoordinator, readTaskTurnRecoveryProvenance, type TaskTurnRecoveryProvenance } from '../orchestration/TaskTurnCoordinator.js';
import { readDurableTaskTerminal } from '../orchestration/TaskLifecycle.js';
import { readTaskSubmissionMetadata, type TaskSubmissionOrigin } from '../orchestration/TaskSubmission.js';

export type AgentRunStatus = 'queued' | 'running' | 'waiting' | 'recovering' | 'completed' | 'failed' | 'canceled' | 'unknown';
export type RunSeverity = 'success' | 'info' | 'warning' | 'error' | 'neutral';

export type AgentRunGraph = {
    /** v4 adds bounded-response summary and omission metadata. */
    schemaVersion: 3 | 4;
    tenantId: string;
    taskId: string;
    root: AgentRunNode;
    nodes: AgentRunNode[];
    edges: AgentRunEdge[];
    turns: TurnRun[];
    unassignedAttempts: TurnAttemptRun[];
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
    summary?: AgentRunGraphSummary;
    omissions?: AgentRunGraphOmission[];
    responseBudget?: OperatorResponseBudget;
};

export type AgentRunGraphSummary = {
    turns: GraphCollectionSummary;
    cognition: GraphCollectionSummary;
    attempts: GraphCollectionSummary;
    memoryOps: GraphCollectionSummary;
    events: GraphCollectionSummary;
    effects: GraphCollectionSummary;
    driverRuns: GraphCollectionSummary;
};

export type GraphCollectionSummary = {
    total: number;
    returned: number;
    running?: number;
    completed?: number;
    failed?: number;
    latestTurnSeq?: number;
    nextCursor?: string;
};

export type AgentRunGraphOmission = {
    collection: 'turns' | 'cognition' | 'attempts' | 'memoryOps' | 'events' | 'effects' | 'driverRuns' | 'previews';
    reason: 'collection_limit' | 'response_budget' | 'projection_unavailable';
    omitted: number;
};

export type OperatorResponseBudget = {
    limitBytes: number;
    actualBytes: number;
    truncated: boolean;
};

export type OperatorPage<T> = {
    items: T[];
    pageInfo: { limit: number; hasMore: boolean; nextCursor?: string };
    summary: GraphCollectionSummary;
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
        claimedGeneration: string;
        phase: 'claimed' | 'executing' | 'committing';
        acquiredAt: string;
        heartbeatAt: string;
        expiresAt: string;
        leaseState: 'live' | 'expiring' | 'expired';
    };
    dispatchIntent?: {
        generation: string;
        state: 'pending' | 'enqueued' | 'overdue';
        recoveryReason?: 'lease_expired' | 'worker_lifetime_lost';
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
    severity: RunSeverity;
    inputPreview?: unknown;
    outputPreview?: unknown;
    error?: unknown;
    traceId?: string;
    providerRunId?: string;
    executionOrigin?: 'runtime' | 'cache' | 'projected';
    cancellation?: AgentRunCancellation;
    startedAt?: string;
    finishedAt?: string;
    origin?: TaskSubmissionOrigin;
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

export type TurnAttemptRun = {
    id: string;
    rootTaskId: string;
    taskId: string;
    agentId?: string;
    status: AgentRunStatus;
    operation: 'turn.segment';
    turnSeq?: number;
    attemptKey?: string;
    attemptSeq?: number;
    disposition?: 'executed' | 'queued' | 'matching_replay' | 'superseded' |
        'terminal_replay' | 'lease_expired_recovery_staged' | 'worker_lifetime_lost_recovery_staged';
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
    supersededReason?: 'lease_expired' | 'worker_lifetime_lost' | 'replaced';
};

export type TurnRecoveryRun = {
    id: string;
    reason: 'lease_expired' | 'worker_lifetime_lost';
    state: 'staged' | 'consumed';
    generation: string;
    turnSeq: number;
    deliveryKey: string;
    sourceClaimId: string;
    sourceFence: string;
    replacementClaimId?: string;
    replacementFence?: string;
    sourceWorkerName?: string;
    replacementWorkerName?: string;
    stagedAt: string;
    consumedAt?: string;
};

export type TurnRun = TurnAttemptRun & {
    turnSeq: number;
    severity: RunSeverity;
    attempts: TurnAttemptRun[];
    recoveries?: TurnRecoveryRun[];
    cognitiveTurns?: CognitiveTurnRun[];
};

export type CognitiveTurnRun = {
    id: string;
    rootTaskId: string;
    taskId: string;
    agentId?: string;
    turnId?: string;
    cognitionTurnSeq: number;
    segmentSeq?: number;
    attemptKey?: string;
    claimId?: string;
    disposition: 'running' | 'observed' | 'committed' | 'superseded';
    cognition: TurnCognition;
    llmCalls: unknown[];
    toolCalls: unknown[];
    childCalls: unknown[];
    memoryOps: MemoryOperationRun[];
    startedAt?: string;
    startedAtEstimated?: boolean;
    finishedAt?: string;
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
    const rootError = rootStatus === 'failed' || rootStatus === 'canceled' ? rootRun?.error : undefined;
    const rootCancellation = readCancellation(snapshot?.snapshot);
    const rootStartedAt = firstEventTime(rootEvents) ?? rootRun?.createdAt;
    const rootFinishedAt =
        rootStatus === 'canceled'
            ? latestTerminalEventTime(rootEvents) ?? driverRunTime(rootRun)
            : isTerminalRunStatus(rootStatus)
            ? latestTerminalEventTime(rootEvents) ?? latestTerminalDriverRunTime(rootDriverRuns)
            : undefined;
    const submissionOrigin = snapshot?.snapshot
        ? readTaskSubmissionMetadata(snapshot.snapshot)?.origin
        : undefined;
    const root: AgentRunNode = {
        id: params.taskId,
        kind: 'agent',
        tenantId: params.tenantId,
        rootTaskId: params.taskId,
        taskId: params.taskId,
        ...(agentId ? { agentId } : {}),
        status: rootStatus,
        severity: severityForStatus(rootStatus, rootError),
        inputPreview: deriveInputPreview(rootEvents, snapshot?.snapshot),
        outputPreview: deriveOutputPreview(rootEvents),
        ...(rootError ? { error: rootError } : {}),
        ...(rootRun?.traceId ? { traceId: rootRun.traceId } : {}),
        ...(rootRun?.providerRunId ? { providerRunId: rootRun.providerRunId } : {}),
        ...(rootCancellation ? { cancellation: rootCancellation } : {}),
        ...(rootStartedAt ? { startedAt: toIso(rootStartedAt) } : {}),
        ...(rootFinishedAt ? { finishedAt: rootFinishedAt } : {}),
        ...(submissionOrigin ? { origin: submissionOrigin } : {}),
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
    const turnProjection = buildTurnRuns(params.taskId, driverRuns, events, memoryOps, terminal?.turnClaim);
    const coordination = buildTaskCoordinationView(params.taskId, snapshot?.snapshot);
    const turns = applyTaskTurnAuthority(
        applyAgentTerminalStatusToTurns(turnProjection.turns, [root, ...childNodes]),
        coordination,
        readTaskTurnRecoveryProvenance((snapshot?.snapshot ?? {}) as Record<string, unknown>),
    );
    const effects = buildEffectRuns(params.taskId, driverRuns, events);
    const graphEvents = buildGraphEvents(params.taskId, agentId ?? undefined, events, driverRuns);
    if (terminal?.turnClaim && !turns.some((turn) => turn.authoritativeTerminal === true)) {
        coordination.issues = [...coordination.issues, 'terminal_projection_mismatch'];
        coordination.health = 'attention';
    }

    return {
        schemaVersion: 3,
        tenantId: params.tenantId,
        taskId: params.taskId,
        root,
        nodes: [root, ...childNodes],
        edges,
        turns,
        unassignedAttempts: turnProjection.unassignedAttempts,
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
        : coordinator.active && leaseState === 'expired'
            ? 'recovering'
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
                claimedGeneration: coordinator.active.claimedGeneration,
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
                ...(coordinator.dispatchIntent.recovery !== undefined
                    ? { recoveryReason: coordinator.dispatchIntent.recovery.reason }
                    : {}),
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
        value === 'superseded' || value === 'terminal_replay' ||
        value === 'lease_expired_recovery_staged' || value === 'worker_lifetime_lost_recovery_staged';
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
    const status = deriveChildNodeStatus(edge.status, edge.executionOrigin, childEvents, childDriverRuns);
    const error = status === 'failed' || status === 'canceled' ? childRun?.error ?? edge.error : undefined;
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
        severity: severityForStatus(status, error),
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
    edgeExecutionOrigin: AgentRunEdge['executionOrigin'],
    events: AgentRunSourceEvent[],
    driverRuns: DriverRunView[]
): AgentRunStatus {
    if (events.some((event) => event.type === 'task.detached')) return 'canceled';
    if (events.some((event) => event.type === 'task.failed')) return 'failed';
    if (events.some((event) => event.type === 'task.completed')) return 'completed';
    const driverStatus = deriveRootStatus(events, driverRuns);
    const hasExecutedTurn = events.some((event) => event.type === 'turn.started' || event.type === 'turn.completed') ||
        driverRuns.some((run) =>
            (run.operation === 'turn.segment' || run.operation === 'segment') &&
            (run.turnDisposition === undefined || run.turnDisposition === 'executed')
        );
    if (driverStatus === 'completed' && edgeStatus !== 'completed' && edgeExecutionOrigin !== 'cache' && !hasExecutedTurn) {
        return 'unknown';
    }
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
): { turns: TurnRun[]; unassignedAttempts: TurnAttemptRun[] } {
    const turnEvents = events.filter((event) => event.type === 'turn.completed' || event.type === 'turn.observed');
    const cognitiveTurns = buildCognitiveTurns(rootTaskId, events, memoryOps);
    const turnStartedEvents = events.filter((event) => event.type === 'turn.started');
    const turnStartedByTurn = new Map<string, AgentRunSourceEvent>();
    for (const event of turnStartedEvents) {
        const turnSeq = eventTurnSeq(event);
        if (turnSeq !== undefined) {
            turnStartedByTurn.set(turnKey(stringField(event.payload, 'taskId') ?? event.sessionId ?? rootTaskId, turnSeq), event);
        }
    }
    const cognitionByTurn = new Map<string, AgentRunSourceEvent>();
    for (const event of turnEvents) {
        const turnSeq = eventTurnSeq(event);
        if (turnSeq !== undefined) {
            cognitionByTurn.set(turnKey(stringField(event.payload, 'taskId') ?? event.sessionId ?? rootTaskId, turnSeq), event);
        }
    }

    const driverTurns = driverRuns
        .filter((run) => run.operation === 'turn.segment' || run.operation === 'segment')
        .map((run, index): TurnAttemptRun => {
            const turnSeq = run.turnSeq ?? undefined;
            const key = turnSeq === undefined ? undefined : turnKey(run.taskId ?? rootTaskId, turnSeq);
            const turnEvent = key === undefined ? undefined : cognitionByTurn.get(key);
            const startedEvent = key === undefined ? undefined : turnStartedByTurn.get(key);
            const ownsTurn = run.turnDisposition === 'executed' || Boolean(run.claimId) || run.turnDisposition === null || run.turnDisposition === undefined;
            const status = deriveTurnStatus(run.status, ownsTurn ? turnEvent : undefined);
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
                attemptKey: canonicalTurnAttemptKey(run.claimId, driverAttemptKey(run, index)),
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
                ...turnEventProjection(ownsTurn ? turnEvent : undefined, memoryOps),
                ...(run.providerRunId ? { providerRunId: run.providerRunId } : {}),
                ...(startedAt ? { startedAt: toIso(startedAt) } : {}),
                ...(finishedAt ? { finishedAt: toIso(finishedAt) } : {}),
                ...(status === 'failed' && run.error ? { error: run.error } : {}),
            };
        });
    const existingTurns = new Set(driverTurns.flatMap((turn) => turn.turnSeq === undefined ? [] : [turnKey(turn.taskId, turn.turnSeq)]));
    const eventOnlyTurns = turnEvents
        .filter((event) => {
            const turnSeq = eventTurnSeq(event);
            const taskId = stringField(event.payload, 'taskId') ?? event.sessionId ?? rootTaskId;
            return turnSeq !== undefined && !existingTurns.has(turnKey(taskId, turnSeq));
        })
        .map((event, index): TurnAttemptRun => {
            const turnSeq = eventTurnSeq(event);
            const taskId = stringField(event.payload, 'taskId') ?? event.sessionId ?? rootTaskId;
            const startedEvent = turnSeq !== undefined ? turnStartedByTurn.get(turnKey(taskId, turnSeq)) : undefined;
            const traceId = stringField(event.payload, 'traceId');
            const spanId = stringField(event.payload, 'spanId');
            const claimId = stringField(event.payload, 'claimId');
            const fallbackAttemptKey = stringField(event.payload, 'attemptKey') ??
                stringField(event.payload, 'turnId') ?? `turn-event-${event.seq}-${index}`;
            return {
                id: stringField(event.payload, 'turnId') ?? `turn-event-${event.seq}-${index}`,
                rootTaskId,
                taskId,
                ...(stringField(event.payload, 'agentId') ? { agentId: stringField(event.payload, 'agentId') } : {}),
                status: deriveTurnStatus('completed', event),
                operation: 'turn.segment',
                ...(turnSeq !== undefined ? { turnSeq } : {}),
                attemptKey: canonicalTurnAttemptKey(claimId, fallbackAttemptKey),
                ...(claimId ? { claimId, disposition: 'executed' as const } : {}),
                ...(stringField(event.payload, 'fence') ? { turnFence: stringField(event.payload, 'fence') } : {}),
                ...(stringField(event.payload, 'claimedGeneration') ? { claimedGeneration: stringField(event.payload, 'claimedGeneration') } : {}),
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
            const turnSeq = eventTurnSeq(event);
            const taskId = stringField(event.payload, 'taskId') ?? event.sessionId ?? rootTaskId;
            return turnSeq !== undefined && !existingCompletedOrDriverTurns.has(turnKey(taskId, turnSeq));
        })
        .map((event, index): TurnAttemptRun => {
            const turnSeq = eventTurnSeq(event);
            const taskId = stringField(event.payload, 'taskId') ?? event.sessionId ?? rootTaskId;
            const traceId = stringField(event.payload, 'traceId');
            const spanId = stringField(event.payload, 'spanId');
            const claimId = stringField(event.payload, 'claimId');
            const fallbackAttemptKey = stringField(event.payload, 'attemptKey') ??
                stringField(event.payload, 'turnId') ?? `turn-started-${event.seq}-${index}`;
            return {
                id: stringField(event.payload, 'turnId') ?? `turn-started-${event.seq}-${index}`,
                rootTaskId,
                taskId,
                ...(stringField(event.payload, 'agentId') ? { agentId: stringField(event.payload, 'agentId') } : {}),
                status: 'running',
                operation: 'turn.segment',
                ...(turnSeq !== undefined ? { turnSeq } : {}),
                attemptKey: canonicalTurnAttemptKey(claimId, fallbackAttemptKey),
                ...(claimId ? { claimId, disposition: 'executed' as const } : {}),
                ...(stringField(event.payload, 'fence') ? { turnFence: stringField(event.payload, 'fence') } : {}),
                ...(stringField(event.payload, 'claimedGeneration') ? { claimedGeneration: stringField(event.payload, 'claimedGeneration') } : {}),
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
    const attempts = finalizeSupersededRunningTurns(
        coalesceAttemptEvidence([...driverTurns, ...eventOnlyTurns, ...eventOnlyRunningTurns])
            .sort((a, b) => {
                if (a.taskId !== b.taskId) return a.taskId.localeCompare(b.taskId);
                return (a.turnSeq ?? 0) - (b.turnSeq ?? 0);
            })
    );
    const grouped = groupTurnAttempts(attempts);
    return {
        ...grouped,
        turns: grouped.turns.map((turn) => ({
            ...turn,
            cognitiveTurns: cognitiveTurns.filter((cognition) =>
                cognition.taskId === turn.taskId && cognition.segmentSeq === turn.turnSeq
            ),
        })),
    };
}

function buildCognitiveTurns(
    rootTaskId: string,
    events: AgentRunSourceEvent[],
    memoryOps: MemoryOperationRun[],
): CognitiveTurnRun[] {
    const startedByIdentity = new Map<string, AgentRunSourceEvent>();
    for (const event of events.filter((item) => item.type === 'turn.started')) {
        startedByIdentity.set(cognitiveEventIdentity(event), event);
    }
    const finalized = events
        .filter((event) => event.type === 'turn.observed' || event.type === 'turn.completed' || event.type === 'turn.superseded')
        .map((event): CognitiveTurnRun | undefined => {
            const cognitionTurnSeq = eventCognitionTurnSeq(event);
            if (cognitionTurnSeq === undefined) return undefined;
            const taskId = stringField(event.payload, 'taskId') ?? event.sessionId ?? rootTaskId;
            const segmentSeq = eventSegmentSeq(event);
            const started = startedByIdentity.get(cognitiveEventIdentity(event));
            const timings = recordField(event.payload, 'timings');
            const durationMs = numberField(timings, 'totalMs');
            const derivedStartedAt = durationMs === undefined
                ? undefined
                : new Date(new Date(event.createdAt).getTime() - durationMs).toISOString();
            return {
                id: cognitiveEventIdentity(event),
                rootTaskId,
                taskId,
                ...(stringField(event.payload, 'agentId') ? { agentId: stringField(event.payload, 'agentId') } : {}),
                ...(stringField(event.payload, 'turnId') ? { turnId: stringField(event.payload, 'turnId') } : {}),
                cognitionTurnSeq,
                ...(segmentSeq !== undefined ? { segmentSeq } : {}),
                ...(stringField(event.payload, 'attemptKey') ? { attemptKey: stringField(event.payload, 'attemptKey') } : {}),
                ...(stringField(event.payload, 'claimId') ? { claimId: stringField(event.payload, 'claimId') } : {}),
                disposition: event.type === 'turn.superseded' ? 'superseded' : event.type === 'turn.completed' ? 'committed' : 'observed',
                cognition: turnEventProjection(event, memoryOps).cognition!,
                llmCalls: arrayField(event.payload, 'llmCalls'),
                toolCalls: arrayField(event.payload, 'toolCalls'),
                childCalls: arrayField(event.payload, 'childCalls'),
                memoryOps: memoryOps.filter((op) => op.taskId === taskId && op.turnSeq === cognitionTurnSeq),
                ...(started?.createdAt || derivedStartedAt ? { startedAt: started?.createdAt ?? derivedStartedAt } : {}),
                ...(!started && derivedStartedAt ? { startedAtEstimated: true } : {}),
                finishedAt: event.createdAt,
            };
        })
        .filter((turn): turn is CognitiveTurnRun => turn !== undefined);
    // `turn.observed` is an immediate, provisional copy of a turn. The later
    // committed/superseded event has the same identity and must replace it,
    // never create a second visual or aggregate turn.
    const finalizedByIdentity = new Map<string, CognitiveTurnRun>();
    for (const turn of finalized) {
        const existing = finalizedByIdentity.get(turn.id);
        if (!existing || cognitiveDispositionRank(turn.disposition) >= cognitiveDispositionRank(existing.disposition)) {
            finalizedByIdentity.set(turn.id, turn);
        }
    }
    const canonicalFinalized = [...finalizedByIdentity.values()];
    const finalizedIdentities = new Set(canonicalFinalized.map((turn) => turn.id));
    const running = events
        .filter((event) => event.type === 'turn.started' && !finalizedIdentities.has(cognitiveEventIdentity(event)))
        .map((event): CognitiveTurnRun | undefined => {
            const cognitionTurnSeq = eventCognitionTurnSeq(event);
            if (cognitionTurnSeq === undefined) return undefined;
            const taskId = stringField(event.payload, 'taskId') ?? event.sessionId ?? rootTaskId;
            const segmentSeq = eventSegmentSeq(event);
            return {
                id: cognitiveEventIdentity(event),
                rootTaskId,
                taskId,
                ...(stringField(event.payload, 'agentId') ? { agentId: stringField(event.payload, 'agentId') } : {}),
                ...(stringField(event.payload, 'turnId') ? { turnId: stringField(event.payload, 'turnId') } : {}),
                cognitionTurnSeq,
                ...(segmentSeq !== undefined ? { segmentSeq } : {}),
                disposition: 'running',
                cognition: turnEventProjection(event, memoryOps).cognition!,
                llmCalls: [], toolCalls: [], childCalls: [],
                memoryOps: memoryOps.filter((op) => op.taskId === taskId && op.turnSeq === cognitionTurnSeq),
                startedAt: event.createdAt,
            };
        })
        .filter((turn): turn is CognitiveTurnRun => turn !== undefined);
    return [...canonicalFinalized, ...running]
        .sort((a, b) => a.taskId === b.taskId
            ? a.cognitionTurnSeq - b.cognitionTurnSeq
            : a.taskId.localeCompare(b.taskId));
}

function cognitiveDispositionRank(disposition: CognitiveTurnRun['disposition']): number {
    switch (disposition) {
        case 'committed': return 3;
        case 'superseded': return 2;
        case 'observed': return 1;
        case 'running': return 0;
    }
}

function cognitiveEventIdentity(event: AgentRunSourceEvent): string {
    const taskId = stringField(event.payload, 'taskId') ?? event.sessionId ?? 'unknown';
    const turnId = stringField(event.payload, 'turnId');
    if (turnId) return `${taskId}:turn:${turnId}`;
    const owner = stringField(event.payload, 'claimId') ?? stringField(event.payload, 'attemptKey') ?? 'unclaimed';
    return `${taskId}:legacy:${owner}:${eventCognitionTurnSeq(event) ?? event.seq}`;
}

function finalizeSupersededRunningTurns(turns: TurnAttemptRun[]): TurnAttemptRun[] {
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

export function groupTurnAttempts(attempts: TurnAttemptRun[]): {
    turns: TurnRun[];
    unassignedAttempts: TurnAttemptRun[];
} {
    const canonicalAttempts = coalesceAttemptEvidence(attempts);
    const assigned = canonicalAttempts.filter((attempt) => attempt.turnSeq !== undefined);
    const unassigned: TurnAttemptRun[] = [];
    for (const attempt of canonicalAttempts.filter((item) => item.turnSeq === undefined)) {
        const associatedTurnSeq = inferHistoricalTurnAssociation(attempt, assigned);
        if (associatedTurnSeq === undefined) {
            unassigned.push(attempt);
            continue;
        }
        assigned.push({ ...attempt, turnSeq: associatedTurnSeq });
    }

    const groups = new Map<string, TurnAttemptRun[]>();
    for (const attempt of assigned) {
        if (attempt.turnSeq === undefined) continue;
        const key = turnKey(attempt.taskId, attempt.turnSeq);
        const group = groups.get(key) ?? [];
        group.push(attempt);
        groups.set(key, group);
    }

    const turns = [...groups.values()].map((group): TurnRun => {
        const sorted = [...group].sort(compareAttempts);
        const primary = selectPrimaryAttempt(sorted);
        const turnSeq = primary.turnSeq!;
        const status = logicalTurnStatus(sorted, primary);
        const error = sorted.find((attempt) => attempt.error !== undefined)?.error;
        return {
            ...primary,
            id: `turn:${primary.taskId}:${turnSeq}`,
            turnSeq,
            status,
            severity: severityForStatus(status, error),
            attempts: sorted,
            recoveries: [],
            cognitiveTurns: [],
            ...(sorted.some((attempt) => attempt.authoritativeTerminal) ? { authoritativeTerminal: true } : {}),
            ...(earliestTimestamp(sorted.map((attempt) => attempt.startedAt)) ? {
                startedAt: earliestTimestamp(sorted.map((attempt) => attempt.startedAt)),
            } : {}),
            ...(latestTimestamp(sorted.map((attempt) => attempt.finishedAt)) ? {
                finishedAt: latestTimestamp(sorted.map((attempt) => attempt.finishedAt)),
            } : {}),
            ...(error !== undefined ? { error } : {}),
        };
    }).sort((a, b) => a.taskId === b.taskId
        ? a.turnSeq - b.turnSeq
        : a.taskId.localeCompare(b.taskId));

    return { turns, unassignedAttempts: unassigned.sort(compareAttempts) };
}

function inferHistoricalTurnAssociation(
    attempt: TurnAttemptRun,
    assigned: TurnAttemptRun[]
): number | undefined {
    const sameTask = assigned.filter((candidate) => candidate.taskId === attempt.taskId && candidate.turnSeq !== undefined);
    if (attempt.idempotencyKey) {
        const exact = sameTask.filter((candidate) => candidate.idempotencyKey === attempt.idempotencyKey);
        const turnSeqs = [...new Set(exact.map((candidate) => candidate.turnSeq!))];
        if (turnSeqs.length === 1) return turnSeqs[0];
    }
    const attemptTime = timestampMs(attempt.startedAt ?? attempt.finishedAt);
    if (attemptTime === undefined) return undefined;
    const active = sameTask
        .filter((candidate) => candidate.status === 'running' || candidate.status === 'waiting' || candidate.finishedAt === undefined)
        .filter((candidate) => {
            const startedAt = timestampMs(candidate.startedAt);
            return startedAt === undefined || startedAt <= attemptTime;
        })
        .sort((a, b) => (timestampMs(b.startedAt) ?? 0) - (timestampMs(a.startedAt) ?? 0));
    return active[0]?.turnSeq;
}

function selectPrimaryAttempt(attempts: TurnAttemptRun[]): TurnAttemptRun {
    return attempts.find((attempt) => attempt.disposition === 'executed' && attempt.cognition !== undefined)
        ?? attempts.find((attempt) => attempt.disposition === 'executed' || attempt.claimId !== undefined)
        ?? attempts.find((attempt) => attempt.cognition !== undefined)
        ?? attempts[0]!;
}

function logicalTurnStatus(attempts: TurnAttemptRun[], primary: TurnAttemptRun): AgentRunStatus {
    const owningAttempts = attempts.filter((attempt) =>
        attempt.disposition === 'executed' || attempt.claimId !== undefined || attempt.cognition !== undefined
    );
    if (owningAttempts.some((attempt) => attempt.status === 'failed')) return 'failed';
    if (owningAttempts.some((attempt) => attempt.status === 'running')) return 'running';
    if (owningAttempts.some((attempt) => attempt.status === 'waiting')) return 'waiting';
    if (owningAttempts.some((attempt) => attempt.status === 'canceled')) return 'canceled';
    if (owningAttempts.some((attempt) => attempt.status === 'completed')) return 'completed';
    if (attempts.every((attempt) => attempt.disposition === 'queued')) return 'queued';
    return primary.status;
}

export function applyTaskTurnAuthority(
    turns: TurnRun[],
    coordination: TaskCoordinationView,
    recoveryProvenance: TaskTurnRecoveryProvenance[] = [],
): TurnRun[] {
    const recoveryByTurn = new Map<number, TurnRecoveryRun[]>();
    for (const recovery of recoveryProvenance) {
        const projected: TurnRecoveryRun = {
            id: recovery.deliveryKey,
            reason: recovery.reason,
            state: recovery.replacementClaim ? 'consumed' : 'staged',
            generation: recovery.generation,
            turnSeq: recovery.turnSeq,
            deliveryKey: recovery.deliveryKey,
            sourceClaimId: recovery.sourceClaim.claimId,
            sourceFence: recovery.sourceClaim.fence,
            ...(recovery.replacementClaim ? {
                replacementClaimId: recovery.replacementClaim.claimId,
                replacementFence: recovery.replacementClaim.fence,
                ...(recovery.replacementClaim.runtimeOwner?.workerName ? { replacementWorkerName: recovery.replacementClaim.runtimeOwner.workerName } : {}),
            } : {}),
            ...(recovery.sourceClaim.runtimeOwner?.workerName ? { sourceWorkerName: recovery.sourceClaim.runtimeOwner.workerName } : {}),
            stagedAt: recovery.stagedAt,
            ...(recovery.consumedAt ? { consumedAt: recovery.consumedAt } : {}),
        };
        recoveryByTurn.set(recovery.turnSeq, [...(recoveryByTurn.get(recovery.turnSeq) ?? []), projected]);
    }
    return turns.map((turn) => {
        const recoveries = recoveryByTurn.get(turn.turnSeq) ?? [];
        const active = coordination.active?.turnSeq === turn.turnSeq ? coordination.active : undefined;
        if (turn.authoritativeTerminal) return { ...turn, recoveries };
        if (active?.leaseState === 'live' || active?.leaseState === 'expiring') {
            const attempts = turn.attempts.map((attempt) => {
                if (attempt.claimId === active.claimId && attempt.turnFence === active.fence &&
                    attempt.claimedGeneration === active.claimedGeneration) {
                    const { finishedAt: _finishedAt, ...rest } = attempt;
                    return { ...rest, status: 'running' as const, disposition: 'executed' as const };
                }
                if (attempt.claimedGeneration === active.claimedGeneration && compareFence(attempt.turnFence, active.fence) < 0 && !attempt.authoritativeTerminal) {
                    return {
                        ...attempt,
                        status: 'completed' as const,
                        disposition: 'superseded' as const,
                        supersededReason: recoveryReasonForSource(recoveries, attempt.claimId, attempt.turnFence) ?? 'replaced' as const,
                    };
                }
                return attempt;
            });
            const primary = attempts.find((attempt) => attempt.claimId === active.claimId && attempt.turnFence === active.fence) ?? turn;
            return { ...turn, ...primary, id: turn.id, turnSeq: turn.turnSeq, status: 'running', severity: 'info', attempts, recoveries };
        }
        const recovering = coordination.state === 'recovering' &&
            (active?.leaseState === 'expired' || coordination.dispatchIntent?.generation === turn.claimedGeneration ||
                recoveries.some((item) => item.state === 'staged'));
        return recovering
            ? { ...turn, status: 'recovering', severity: 'warning', recoveries }
            : { ...turn, recoveries };
    });
}

function compareFence(left: string | undefined, right: string): number {
    if (left === undefined || !/^\d+$/.test(left) || !/^\d+$/.test(right)) return -1;
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
}

function recoveryReasonForSource(
    recoveries: TurnRecoveryRun[], claimId: string | undefined, fence: string | undefined,
): TurnAttemptRun['supersededReason'] | undefined {
    return recoveries.find((item) => item.sourceClaimId === claimId && item.sourceFence === fence)?.reason;
}

function applyAgentTerminalStatusToTurns(turns: TurnRun[], nodes: AgentRunNode[]): TurnRun[] {
    const latestByTask = new Map<string, number>();
    for (const turn of turns) {
        latestByTask.set(turn.taskId, Math.max(latestByTask.get(turn.taskId) ?? 0, turn.turnSeq));
    }
    const nodesByTask = new Map(nodes.map((node) => [node.taskId, node]));
    return turns.map((turn) => {
        const node = nodesByTask.get(turn.taskId);
        if (!node || latestByTask.get(turn.taskId) !== turn.turnSeq) return turn;
        if (node.status !== 'canceled' && node.status !== 'failed') return turn;
        if (turn.status === 'completed') return turn;
        const status = node.status;
        const error = turn.error ?? node.error;
        return {
            ...turn,
            status,
            severity: severityForStatus(status, error),
            ...(error !== undefined ? { error } : {}),
            ...(node.finishedAt ? { finishedAt: node.finishedAt } : {}),
        };
    });
}

function compareAttempts(a: TurnAttemptRun, b: TurnAttemptRun): number {
    const seq = (a.attemptSeq ?? Number.MAX_SAFE_INTEGER) - (b.attemptSeq ?? Number.MAX_SAFE_INTEGER);
    if (seq !== 0) return seq;
    return (timestampMs(a.startedAt ?? a.finishedAt) ?? 0) - (timestampMs(b.startedAt ?? b.finishedAt) ?? 0);
}

function earliestTimestamp(values: Array<string | undefined>): string | undefined {
    return values.filter((value): value is string => value !== undefined)
        .sort((a, b) => (timestampMs(a) ?? 0) - (timestampMs(b) ?? 0))[0];
}

function latestTimestamp(values: Array<string | undefined>): string | undefined {
    return values.filter((value): value is string => value !== undefined)
        .sort((a, b) => (timestampMs(b) ?? 0) - (timestampMs(a) ?? 0))[0];
}

function timestampMs(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

export function severityForStatus(status: AgentRunStatus, error?: unknown): RunSeverity {
    if (error !== undefined || status === 'failed') return 'error';
    if (status === 'completed') return 'success';
    if (status === 'running') return 'info';
    if (status === 'waiting' || status === 'recovering') return 'warning';
    return 'neutral';
}

function turnKey(taskId: string, turnSeq: number): string {
    return `${taskId}:${turnSeq}`;
}

function driverAttemptKey(run: DriverRunView, index: number): string {
    if (run.provider === 'hatchet' && run.providerRunId && run.providerTaskRunId) {
        return `hatchet:${run.providerRunId}:${run.providerTaskRunId}`;
    }
    return run.id ?? run.providerTaskRunId ?? run.providerRunId ?? `attempt-${index}`;
}

/** One physical execution is owned by its durable claim when one exists. */
export function canonicalTurnAttemptKey(
    claimId: string | null | undefined,
    fallbackAttemptKey: string
): string {
    return claimId ? `claim:${claimId}` : fallbackAttemptKey;
}

function coalesceAttemptEvidence(attempts: TurnAttemptRun[]): TurnAttemptRun[] {
    const byIdentity = new Map<string, TurnAttemptRun>();
    for (const attempt of attempts) {
        const fallback = attempt.attemptKey ?? attempt.id;
        const attemptKey = canonicalTurnAttemptKey(attempt.claimId, fallback);
        const identity = `${attempt.taskId}\u001f${attemptKey}`;
        const normalized = { ...attempt, attemptKey };
        const existing = byIdentity.get(identity);
        byIdentity.set(identity, existing ? mergeAttemptEvidence(existing, normalized) : normalized);
    }
    return [...byIdentity.values()];
}

function mergeAttemptEvidence(existing: TurnAttemptRun, incoming: TurnAttemptRun): TurnAttemptRun {
    const authoritative = incoming.authoritativeTerminal === true
        ? incoming
        : existing.authoritativeTerminal === true
          ? existing
          : undefined;
    const preferred = attemptEvidenceScore(incoming) >= attemptEvidenceScore(existing) ? incoming : existing;
    const secondary = preferred === incoming ? existing : incoming;
    const status = authoritative?.status ?? mergeAttemptStatus(existing.status, incoming.status);
    const disposition = mergeAttemptDisposition(existing.disposition, incoming.disposition, authoritative === incoming);
    return {
        ...secondary,
        ...preferred,
        id: preferred.id,
        attemptKey: preferred.attemptKey ?? secondary.attemptKey,
        status,
        ...(disposition ? { disposition } : {}),
        ...(existing.authoritativeTerminal || incoming.authoritativeTerminal ? { authoritativeTerminal: true } : {}),
        ...(existing.agentId ?? incoming.agentId ? { agentId: existing.agentId ?? incoming.agentId } : {}),
        ...(existing.claimId ?? incoming.claimId ? { claimId: existing.claimId ?? incoming.claimId } : {}),
        ...(existing.turnFence ?? incoming.turnFence ? { turnFence: existing.turnFence ?? incoming.turnFence } : {}),
        ...(existing.claimedGeneration ?? incoming.claimedGeneration ? { claimedGeneration: existing.claimedGeneration ?? incoming.claimedGeneration } : {}),
        ...(existing.boundaryKind ?? incoming.boundaryKind ? { boundaryKind: existing.boundaryKind ?? incoming.boundaryKind } : {}),
        ...(existing.providerRunId ?? incoming.providerRunId ? { providerRunId: existing.providerRunId ?? incoming.providerRunId } : {}),
        ...(existing.cognition ?? incoming.cognition ? { cognition: existing.cognition ?? incoming.cognition } : {}),
        ...(existing.llmCalls ?? incoming.llmCalls ? { llmCalls: existing.llmCalls ?? incoming.llmCalls } : {}),
        ...(existing.memoryOps ?? incoming.memoryOps ? { memoryOps: existing.memoryOps ?? incoming.memoryOps } : {}),
        ...(earliestTimestamp([existing.startedAt, incoming.startedAt]) ? { startedAt: earliestTimestamp([existing.startedAt, incoming.startedAt]) } : {}),
        ...(latestTimestamp([existing.finishedAt, incoming.finishedAt]) ? { finishedAt: latestTimestamp([existing.finishedAt, incoming.finishedAt]) } : {}),
        ...(existing.error ?? incoming.error ? { error: existing.error ?? incoming.error } : {}),
    };
}

function attemptEvidenceScore(attempt: TurnAttemptRun): number {
    return (attempt.authoritativeTerminal ? 32 : 0) +
        (attempt.claimId ? 16 : 0) +
        (attempt.disposition === 'executed' ? 8 : 0) +
        (attempt.providerRunId ? 4 : 0) +
        (attempt.cognition ? 2 : 0) +
        (attempt.boundaryKind ? 1 : 0);
}

function mergeAttemptStatus(a: AgentRunStatus, b: AgentRunStatus): AgentRunStatus {
    if (isTerminalRunStatus(a)) return a;
    if (isTerminalRunStatus(b)) return b;
    const rank: Record<AgentRunStatus, number> = {
        unknown: 0,
        queued: 1,
        running: 2,
        recovering: 2,
        waiting: 2,
        completed: 3,
        failed: 3,
        canceled: 3,
    };
    return rank[b] > rank[a] ? b : a;
}

function mergeAttemptDisposition(
    existing: TurnAttemptRun['disposition'],
    incoming: TurnAttemptRun['disposition'],
    incomingAuthoritative: boolean
): TurnAttemptRun['disposition'] {
    if (incomingAuthoritative) return incoming ?? existing;
    if (existing === 'superseded') return existing;
    if (incoming === 'superseded') return incoming;
    if (existing === 'executed' || incoming === 'executed') return 'executed';
    return incoming ?? existing;
}

function turnEventProjection(
    event: AgentRunSourceEvent | undefined,
    memoryOps: MemoryOperationRun[]
): Pick<TurnAttemptRun, 'cognition' | 'llmCalls' | 'memoryOps'> {
    if (event === undefined) {
        return {};
    }
    const turnSeq = eventTurnSeq(event);
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
                ...(eventTurnSeq(event) !== undefined ? { turnSeq: eventTurnSeq(event) } : {}),
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
    if (status === 'running' || status === 'queued' || status === 'waiting' || status === 'recovering') {
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

function eventTurnSeq(event: Pick<AgentRunSourceEvent, 'payload'>): number | undefined {
    return eventSegmentSeq(event);
}

function eventSegmentSeq(event: Pick<AgentRunSourceEvent, 'payload'>): number | undefined {
    return numberField(event.payload, 'segmentSeq')
        ?? numberField(event.payload, 'logicalTurnSeq')
        ?? numberField(event.payload, 'turnSeq');
}

function eventCognitionTurnSeq(event: Pick<AgentRunSourceEvent, 'payload'>): number | undefined {
    return numberField(event.payload, 'cognitionTurnSeq') ?? numberField(event.payload, 'turnSeq');
}

function recordField(payload: Record<string, unknown>, key: string): Record<string, unknown> {
    const value = payload[key];
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
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
