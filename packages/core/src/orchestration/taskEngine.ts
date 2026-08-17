import type { TaskContext, TaskInput } from '../shared/types/index.js';
import { LoopRegistry } from './LoopRegistry.js';
import type { TaskState, TaskStatus } from '../shared/types/StreamingEvents.js';
import { Artifact } from '../shared/types/index.js'; // Explicitly import Memory Artifact for usage
import { createInMemoryEventBus } from '../eventbus/inMemoryEventBus.js';
import type { IEventBus } from '../public-types/eventbus/types.js';
import { createDbMessageLog } from '../eventbus/dbMessageLog.js';
import type { DurableSubscriptionPersistence } from '../eventbus/inProcessDurableSubscription.js';
import { wrapMessageLogWithTopicStream } from '../eventbus/messageLogTopicStream.js';
import type { MessageLog } from '../public-types/messageLog/types.js';
import type { DurableSubscription } from '../public-types/messageLog/durableSubscription.types.js';
import { createBusEvent } from '../eventbus/busEventHelpers.js';
import { taskChannel } from '../eventbus/taskEventEmitter.js';
import {
    extendContextWithStreaming,
    TaskReplyCapabilityUnavailableError,
} from '../context/StreamingContext.js';
import {
    ensureTaskReplyDeliveryMode,
    taskReplyDeliveryModeFromStreaming,
} from '../context/taskReplyDelivery.js';
import { SessionManager } from './SessionManager.js';
import { InMemorySessionManager } from './InMemorySessionManager.js';
import type { IWorkingMemorySessionStore, WMSessionSnapshot } from '@a2arium/callagent-memory-engine';
import { decide } from './reducer.js';
import { applyInputProvided, getPendingInputs, setPendingInputs, tombstonePendingInput } from './DurableHandlerRegistry.js';
import type { DurableHandlerInvoker } from './DurableHandlerInvoker.js';
import { DurableHandlerInvokerCore } from './DurableHandlerInvoker.js';
import { InputHandle, createTaskHandle, createGroupHandle, type GroupHandle } from './Handles.js';
import { getPendingTasks, setPendingTasks } from './Handles.js';
import { globalA2AService } from './A2AService.js';
import * as uuid from 'uuid';
const uuidv7 = uuid.v7;

import { OutboxPublisher } from '../eventbus/outboxPublisher.js';
import {
    claimOutboxRow,
    deleteClaimedOutboxRow,
    dispatchOutboxRow,
    isHatchetOutboxTopic,
    releaseClaimedOutboxRow,
} from '../eventbus/outboxDispatch.js';
import { BackpressureManager } from '../internal/conversation/BackpressureManager.js';
import { createTraceparent } from '../tracing/Tracing.js';
import { mapWorkingMemoryEventToRuntimeStream } from '../streaming/sessionEventMapper.js';
import { bindRuntimeCognitionStream } from '../streaming/cognitionRuntimePublisher.js';
import { createArtifactFactory } from '../context/artifactFactory.js';
import { makeSafeEventPreview } from './safeEventPreview.js';
import type {
    GoalId,
    GoalNode,
    MentalState,
    TaskContextGoalAddInput,
    TaskContextGoalUpdatePatch,
    TaskContextGoalsReadFilter,
} from '../loop/types.js';
import { initialM } from '../loop/init.js';
import { telemetry } from '../telemetry/TelemetryCollector.js';
import { AgentNode } from '../telemetry/nodes/AgentNode.js';
import { WorkflowNode } from '../telemetry/nodes/WorkflowNode.js';
import type { NodeStatus } from '../telemetry/nodes/TelemetryNode.js';


import { logger } from '@a2arium/callagent-utils';

import { normalizeObservationInbox, type EnvironmentState, type ObservationInbox, type Snapshot } from '../loop/types.js';
import { writeControlVar } from '../loop/controlVarAccessors.js';
import type { Observation } from '../loop/oneTurn.js';
import { getPendingTools, setPendingTools, type PendingToolTerminal } from './ToolsRegistry.js';
import { getPendingExternalEvents, setPendingExternalEvents } from './ExternalEventsRegistry.js';
import { PluginManager } from '../plugin/pluginManager.js';
import { validateTenantId } from '../plugin/tenantValidator.js';
import type { AgentPlugin } from '../plugin/types.js';
import { resolveManifestProvenance } from '../telemetry/manifestProvenance.js';
import type { ManifestProvenance, ManifestSource } from '../types/turnTrace.js';
import type { InternalTaskContext, OperatorTurnTraceCapture } from '../loop/internalContext.js';
import { extendContextWithMemory } from '@a2arium/callagent-memory-engine';
import { createMemoryRegistry } from '@a2arium/callagent-memory-engine';
import { isArtifactMarker, type ArtifactMarker } from '@a2arium/callagent-memory-engine';
import { AgentResultCache } from '@a2arium/callagent-memory-engine';
import { hydrateArtifacts } from '@a2arium/callagent-memory-engine';
import { offloadArtifacts } from '@a2arium/callagent-memory-engine';
import { pruneSnapshot } from '../loop/hygiene.js';
import { ArtifactHydrationService, HYDRATED_ARTIFACT_HANDLE_SYMBOL } from './ArtifactHydrationService.js';
import { InboxManager, type EngineObservation, type EngineObservationInbox } from './InboxManager.js';
import {
    buildInProcessRuntimeStack,
    InProcessRuntimeDriver,
    isSyncRuntimeDriver,
    type InProcessRuntimeStack,
    type PreparedTurnInvocation,
    type RuntimeDriver,
    type RuntimeWakeEvent,
    type RuntimeContextBinding,
    type SegmentResult,
    type TaskRunTimeoutDisposition,
    type TurnExecutor,
} from '../runtime/index.js';
import { currentTaskTurnClaim } from '../runtime/segmentProcessedKeys.js';
import {
    markSegmentCancellationRequested,
    readSegmentCancellation,
} from '../runtime/segmentCancellation.js';





import {
    TaskEntity,
    StartTaskParams,
    CleanChildResult
} from './types.js';
import {
    buildAgentRunGraph,
    buildTaskCoordinationView,
    type AgentRunGraph,
    type AgentRunSourceEvent,
    type DriverRunView,
} from '../operator/runGraph.js';
import {
    OperatorProjectionRepository,
    readProjectionMode,
    readProjectionWriteMode,
} from '../operator/semanticProjection.js';
import {
    budgetEnvelope,
    measureJsonBytes,
    readOperatorRawPayloadMaxBytes,
} from '../operator/payloadBudget.js';
import {
    prepareChildResultForPersistence,
    prepareChildResultsInInboxForPersistence,
} from './childResultPersistence.js';
import { readA2aResultTelemetry } from './api/a2aResultTelemetry.js';
import { coordinateChildTerminal, type ChildTerminalIdentity } from './ChildTerminalCoordinator.js';
import { coordinateToolTerminal } from './ToolTerminalCoordinator.js';
import { detachPendingToolsInSnapshot } from './ToolTerminalCoordinator.js';
import { synthesizeOwnerDetachedChildTerminal } from '../plans/planStepCorrelation.js';
import {
    claimTaskTerminalInSnapshot,
    isTaskLifecycleTerminal,
    markDurableTaskTerminalEnqueued,
    markTaskLifecycle,
    readDurableTaskTerminal,
    readRootRunDeadline,
    readTaskLifecycle,
    writeRootRunDeadline,
    type RootRunDeadline,
    type TaskTerminalDisposition,
} from './TaskLifecycle.js';
import { defaultMetricsRegistry } from '../observability/metrics.js';
import { isWorkingMemoryVersionConflict } from '@a2arium/callagent-types/working-memory-version-conflict';
import {
    TaskLifecycleTerminalError,
    isTaskLifecycleTerminalError,
} from '@a2arium/callagent-types/task-lifecycle-terminal';
import {
    isSnapshotReconciliationError,
    reconcileSnapshotMutation,
} from './persistence/SnapshotRepository.js';
import { assertTaskEffectActive } from './TaskEffectRegistration.js';
import {
    assertCurrentTaskTurn,
    markTaskTurnDispatchEnqueued,
    readTaskTurnCoordinator,
} from './TaskTurnCoordinator.js';
import {
    buildAdmittedTaskSnapshot,
    canonicalizeTaskSubmissionInput,
    classifyTaskSubmission,
    normalizeTaskSubmissionMaxTurns,
    normalizeTaskSubmissionOrigin,
    normalizeTaskSubmissionRunTimeout,
    readTaskSubmissionMetadata,
    TaskSubmissionError,
    taskSubmissionRequestDigest,
    type SubmitTaskParams,
    type SubmitTaskResult,
    type TaskSubmissionOrigin,
} from './TaskSubmission.js';

export type {
    TaskEntity,
    StartTaskParams,
    CleanChildResult,
    SubmitTaskParams,
    SubmitTaskResult,
    TaskSubmissionOrigin,
};
export { TaskSubmissionError } from './TaskSubmission.js';
export type { TaskSubmissionErrorCode } from './TaskSubmission.js';

export type CancelTaskParams = {
    tenantId: string;
    taskId: string;
    agentId?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
};

export type AwaitTaskTerminalParams = {
    tenantId: string;
    taskId: string;
    agentId?: string;
    timeoutMs: number;
    timeoutSource: string;
    startedAtMs?: number;
    pollIntervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
};

export type AwaitTaskTerminalResult = {
    status: TaskStatus;
    lifecycle: 'terminal' | 'input-required';
    deadline?: RootRunDeadline;
};

type RootDeadlineInspection =
    | { disposition: 'none' | 'claimed' | 'missing' | 'stale' | 'terminal' | 'canceled' }
    | { disposition: 'pending' | 'due'; deadline: RootRunDeadline };







/**
 * A minimal task engine that handles task execution
 * This is a simplified implementation that would use XState in a full framework
 */

const log = logger.createLogger({ prefix: 'TaskEngine' });

function taskEntityFromSegmentResult(segment: SegmentResult, input: unknown): TaskEntity {
    if (segment.taskEntity !== undefined) return segment.taskEntity;

    if (segment.turnDisposition === undefined || segment.turnDisposition === 'executed') {
        throw new Error(
            `TASK_TURN_PROTOCOL_STATE_UNKNOWN: ${segment.taskId} returned ${segment.turnDisposition ?? 'no disposition'} without a committed task entity`
        );
    }
    if (segment.turnDisposition === 'terminal_replay' &&
        segment.boundary.kind !== 'complete' &&
        segment.boundary.kind !== 'fail' &&
        segment.boundary.kind !== 'canceled') {
        throw new Error(
            `TASK_TURN_PROTOCOL_STATE_UNKNOWN: ${segment.taskId} returned terminal_replay with ${segment.boundary.kind}`
        );
    }

    const timestamp = new Date().toISOString();
    let status: TaskStatus;
    switch (segment.boundary.kind) {
        case 'complete':
            status = {
                state: 'completed',
                timestamp,
                metadata: { result: segment.boundary.result },
            };
            break;
        case 'fail':
            status = {
                state: 'failed',
                timestamp,
                metadata: { error: segment.boundary.error },
            };
            break;
        case 'canceled':
            status = {
                state: 'canceled',
                timestamp,
                ...(segment.boundary.reason !== undefined
                    ? { metadata: { reason: segment.boundary.reason } }
                    : {}),
            };
            break;
        case 'await_input':
            status = {
                state: 'input-required',
                timestamp,
                metadata: { token: segment.boundary.token },
            };
            break;
        default:
            status = {
                state: 'working',
                timestamp,
                metadata: {
                    disposition: segment.turnDisposition,
                    boundary: segment.boundary.kind,
                },
            };
    }
    return { id: segment.taskId, input: input as TaskInput, status } as TaskEntity;
}

function resolveChildToken(
    snapshot: Record<string, unknown>,
    tasks: ReturnType<typeof getPendingTasks>,
    childToken?: string,
    childTaskId?: string
): string | undefined {
    if (childToken !== undefined) return childToken;
    const pendingToken = Object.keys(tasks).find((token) => tasks[token]?.childTaskId === childTaskId);
    if (pendingToken !== undefined) return pendingToken;
    const terminals = (snapshot as {
        pending?: { childTerminals?: Record<string, { childTaskId?: string }> };
    }).pending?.childTerminals ?? {};
    return Object.keys(terminals).find((token) => terminals[token]?.childTaskId === childTaskId);
}

const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

function awaitTaskSubmissionPublish(
    promise: Promise<void>,
    timeoutMs = 5_000
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new TaskSubmissionError(
                'TASK_SUBMISSION_PUBLISH_TIMEOUT',
                'initial provider publication exceeded the bounded admission nudge'
            ));
        }, timeoutMs);
        timeout.unref?.();
        promise.then(
            () => {
                clearTimeout(timeout);
                resolve();
            },
            (error) => {
                clearTimeout(timeout);
                reject(error);
            }
        );
    });
}

function awaitingFromSnapshot(snapshot: Record<string, unknown>): { kind?: string; token?: string } {
    const meta = isRecordValue(snapshot.meta) ? snapshot.meta : undefined;
    const awaiting = isRecordValue(meta?.awaiting) ? meta.awaiting : undefined;
    const pending = isRecordValue(snapshot.pending) ? snapshot.pending : undefined;
    const inputs = isRecordValue(pending?.inputs) ? pending.inputs : undefined;
    const pendingInputToken = inputs !== undefined ? Object.keys(inputs)[0] : undefined;
    if (pendingInputToken !== undefined && awaiting?.kind === undefined) {
        return { kind: 'await_input', token: pendingInputToken };
    }
    return {
        ...(typeof awaiting?.kind === 'string' ? { kind: awaiting.kind } : {}),
        ...(typeof awaiting?.token === 'string' ? { token: awaiting.token } : {}),
    };
}

function terminalStatusFromSnapshot(snapshot: Record<string, unknown>, taskId: string): TaskStatus | undefined {
    const terminal = readDurableTaskTerminal(snapshot);
    if (terminal !== undefined) return terminal.status as TaskStatus;
    const lifecycle = readTaskLifecycle(snapshot, taskId);
    if (!isTaskLifecycleTerminal(lifecycle)) return undefined;
    const state = lifecycle?.state === 'detached' ? 'canceled' : lifecycle?.state;
    if (state !== 'completed' && state !== 'failed' && state !== 'canceled') return undefined;
    return {
        state,
        timestamp: lifecycle?.changedAt ?? new Date().toISOString(),
        ...(lifecycle?.reason !== undefined ? { metadata: { reason: lifecycle.reason } } : {}),
    };
}

type A2AParentLink = {
    parentTenantId: string;
    parentTaskId: string;
    parentChildToken: string;
};

type BackgroundTaskMetadata = {
    kind: string;
    label?: string;
    tenantId?: string;
    taskId?: string;
    agentId?: string;
    token?: string;
    toolName?: string;
    childAgent?: string;
    childTaskId?: string;
    source?: string;
    rootTaskId?: string;
    ancestorTaskIds?: string[];
    abort?: () => void | Promise<void>;
    state: 'registering' | 'active' | 'detached';
    pendingKind?: 'tools' | 'tasks';
    detachedAt?: number;
    detachReason?: string;
    abortStatus?: 'requested' | 'completed' | 'failed' | 'unsupported';
    startedAt: number;
};

type BackgroundTaskSummary = {
    index: number;
    kind: string;
    label: string;
    ageMs?: number;
    tenantId?: string;
    taskId?: string;
    agentId?: string;
    token?: string;
    toolName?: string;
    childAgent?: string;
    childTaskId?: string;
    source?: string;
    rootTaskId?: string;
    ancestorTaskIds?: string[];
    state?: 'registering' | 'active' | 'detached';
    detachReason?: string;
    abortStatus?: 'requested' | 'completed' | 'failed' | 'unsupported';
};

type A2AChildContext = TaskContext & {
    __a2aParent?: A2AParentLink;
    __a2aParentNotified?: boolean;
};

const A2A_TERMINAL_STATES: ReadonlySet<TaskState> = new Set(['completed', 'failed', 'canceled']);

function isA2ATerminalTaskState(state: TaskState | undefined): boolean {
    return state !== undefined && A2A_TERMINAL_STATES.has(state);
}

function readA2AParentLink(value: unknown): A2AParentLink | undefined {
    if (value === null || typeof value !== 'object') {
        return undefined;
    }
    const candidate = value as Record<string, unknown>;
    const parentTenantId = candidate.parentTenantId;
    const parentTaskId = candidate.parentTaskId;
    const parentChildToken = candidate.parentChildToken;
    if (
        typeof parentTenantId === 'string' &&
        typeof parentTaskId === 'string' &&
        typeof parentChildToken === 'string'
    ) {
        return { parentTenantId, parentTaskId, parentChildToken };
    }
    return undefined;
}

function encodeAgentRunCursor(cursor: AgentRunCursor): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeAgentRunCursor(value: string | undefined): AgentRunCursor | undefined {
    if (value === undefined || value.length === 0) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return undefined;
        }
        const record = parsed as Record<string, unknown>;
        return typeof record.createdAt === 'string' && typeof record.id === 'string'
            ? { createdAt: record.createdAt, id: record.id }
            : undefined;
    } catch {
        return undefined;
    }
}

function clampAgentRunLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit)) {
        return 50;
    }
    return Math.max(1, Math.min(100, Math.trunc(limit)));
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numberFromPayload(payload: Record<string, unknown>, key: string): number | undefined {
    const value = payload[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function childTaskIdFromEvent(event: WMEventRow): string | undefined {
    const childTaskId = event.payload.childTaskId;
    return typeof childTaskId === 'string' && childTaskId.length > 0 ? childTaskId : undefined;
}

function taskIdForRun(row: DriverRunView): string | undefined {
    return row.rootTaskId ?? row.taskId ?? undefined;
}

function isRootDriverRun(row: DriverRunView, childTaskIds: Set<string>): boolean {
    if (row.parentTaskId !== null && row.parentTaskId !== undefined && row.parentTaskId.length > 0) {
        return false;
    }
    const taskId = row.taskId ?? undefined;
    if (taskId !== undefined && childTaskIds.has(taskId)) {
        return false;
    }
    return row.rootTaskId === null || row.rootTaskId === undefined || row.rootTaskId === taskId;
}

function deriveListRunStatus(
    rootRun: DriverRunListRow,
    relatedRuns: DriverRunListRow[],
    turnEvents: WMEventRow[]
): string {
    if (turnEvents.some((event) => event.type === 'task.canceled')) {
        return 'canceled';
    }
    if (turnEvents.some((event) => event.type === 'task.failed')) {
        return 'failed';
    }
    if (turnEvents.some((event) => event.type === 'task.completed')) {
        return 'completed';
    }

    const latestTurnCompleted = [...turnEvents].reverse().find((event) => event.type === 'turn.completed');
    const latestSegment = [...relatedRuns]
        .reverse()
        .find((run) => run.operation === 'turn.segment' || run.operation === 'segment');
    if (normalizeListRunStatus(latestSegment?.status) === 'running') {
        return 'running';
    }

    const terminalSegment = [...relatedRuns]
        .reverse()
        .find((run) => run.operation === 'turn.segment' && run.boundaryKind !== null && run.boundaryKind !== undefined);
    if (terminalSegment?.boundaryKind === 'fail' || normalizeListRunStatus(terminalSegment?.status) === 'failed') {
        return 'failed';
    }
    if (terminalSegment?.boundaryKind === 'complete') {
        return 'completed';
    }
    if (terminalSegment?.boundaryKind === 'canceled') {
        return 'canceled';
    }

    const rootStatus = normalizeListRunStatus(rootRun.status);
    if (rootStatus === 'canceled' || rootStatus === 'completed') {
        return rootStatus;
    }
    if (rootStatus === 'failed') {
        return 'failed';
    }

    const latestTurnBoundary = latestTurnCompleted ? eventTransitionKind(latestTurnCompleted.payload) : undefined;
    if (isAwaitBoundaryKind(latestTurnBoundary)) {
        return 'running';
    }

    if (rootStatus !== 'unknown' && rootStatus !== 'queued') {
        return rootStatus;
    }
    if (turnEvents.some((event) => event.type === 'task.started')) {
        return 'running';
    }
    return rootStatus;
}

function normalizeListRunStatus(status: string | null | undefined): string {
    switch ((status ?? '').toLowerCase()) {
        case 'canceled':
        case 'cancelled':
            return 'canceled';
        case 'success':
        case 'succeeded':
        case 'complete':
        case 'completed':
            return 'completed';
        case 'error':
        case 'failed':
        case 'failure':
            return 'failed';
        case 'running':
        case 'active':
            return 'running';
        case 'queued':
        case 'pending':
            return 'queued';
        default:
            return 'unknown';
    }
}

function eventTransitionKind(payload: unknown): string | undefined {
    if (!isRecordValue(payload)) {
        return undefined;
    }
    const transition = payload.transition;
    if (!isRecordValue(transition)) {
        return undefined;
    }
    const kind = transition.kind;
    return typeof kind === 'string' && kind.length > 0 ? kind : undefined;
}

function isAwaitBoundaryKind(value: string | undefined): boolean {
    return value === 'await_input' || value === 'await_tool' || value === 'await_child' || value === 'await_event';
}

const GRAPH_NODE_LIMIT = 250;
const GRAPH_EDGE_LIMIT = 350;
const GRAPH_DEPTH_LIMIT = 4;

function withGraphCaps(graph: AgentRunGraph, source: 'bridge' | 'semantic'): AgentRunGraph {
    const adjacency = new Map<string, string[]>();
    for (const edge of graph.edges) {
        if (!edge.childTaskId) continue;
        const current = adjacency.get(edge.parentTaskId) ?? [];
        current.push(edge.childTaskId);
        adjacency.set(edge.parentTaskId, current);
    }

    const keptTaskIds = new Set<string>([graph.root.taskId]);
    const depthByTaskId = new Map<string, number>([[graph.root.taskId, 0]]);
    const queue = [graph.root.taskId];
    let truncatedByDepth = false;
    let truncatedByNodeLimit = false;

    while (queue.length > 0) {
        const parentTaskId = queue.shift()!;
        const depth = depthByTaskId.get(parentTaskId) ?? 0;
        const children = adjacency.get(parentTaskId) ?? [];
        if (depth >= GRAPH_DEPTH_LIMIT && children.length > 0) {
            truncatedByDepth = true;
            continue;
        }
        for (const childTaskId of children) {
            if (keptTaskIds.has(childTaskId)) continue;
            if (keptTaskIds.size >= GRAPH_NODE_LIMIT) {
                truncatedByNodeLimit = true;
                break;
            }
            keptTaskIds.add(childTaskId);
            depthByTaskId.set(childTaskId, depth + 1);
            queue.push(childTaskId);
        }
    }

    const filteredEdges = graph.edges.filter((edge) =>
        keptTaskIds.has(edge.parentTaskId) &&
        (edge.childTaskId === undefined || keptTaskIds.has(edge.childTaskId))
    );
    const truncatedByEdgeLimit = filteredEdges.length > GRAPH_EDGE_LIMIT;
    const truncated = truncatedByDepth || truncatedByNodeLimit || truncatedByEdgeLimit || keptTaskIds.size < graph.nodes.length;

    if (!truncated) {
        return withOperatorResponseBudget({
            ...graph,
            projection: graph.projection ?? { source, partial: false },
            caps: graph.caps ?? {
                nodeLimit: GRAPH_NODE_LIMIT,
                edgeLimit: GRAPH_EDGE_LIMIT,
                depthLimit: GRAPH_DEPTH_LIMIT,
                truncated: false,
            },
        }, source);
    }
    const nodes = graph.nodes.filter((node) => keptTaskIds.has(node.taskId));
    const edges = filteredEdges.slice(0, GRAPH_EDGE_LIMIT);
    const hiddenByParent = new Map<string, number>();
    const hiddenReasonByParent = new Map<string, 'node_limit' | 'depth_limit' | 'manual'>();
    for (const edge of graph.edges) {
        if (edge.childTaskId !== undefined && keptTaskIds.has(edge.parentTaskId) && !keptTaskIds.has(edge.childTaskId)) {
            hiddenByParent.set(edge.parentTaskId, (hiddenByParent.get(edge.parentTaskId) ?? 0) + 1);
            const parentDepth = depthByTaskId.get(edge.parentTaskId) ?? 0;
            hiddenReasonByParent.set(edge.parentTaskId, parentDepth >= GRAPH_DEPTH_LIMIT ? 'depth_limit' : 'node_limit');
        }
    }
    return withOperatorResponseBudget({
        ...graph,
        nodes,
        edges,
        turns: graph.turns.filter((turn) => keptTaskIds.has(turn.taskId)),
        effects: graph.effects.filter((effect) => effect.taskId === undefined || keptTaskIds.has(effect.taskId)),
        events: graph.events.filter((event) => keptTaskIds.has(event.taskId)),
        collapsedBranches: [...hiddenByParent.entries()].map(([parentTaskId, hiddenChildCount]) => ({
            parentTaskId,
            hiddenChildCount,
            expandCursor: Buffer.from(JSON.stringify({ parentTaskId }), 'utf8').toString('base64url'),
            reason: hiddenReasonByParent.get(parentTaskId) ?? 'manual',
        })),
        projection: graph.projection ?? { source, partial: true },
        caps: {
            nodeLimit: GRAPH_NODE_LIMIT,
            edgeLimit: GRAPH_EDGE_LIMIT,
            depthLimit: GRAPH_DEPTH_LIMIT,
            truncated: true,
        },
    }, source);
}

function withOperatorResponseBudget(graph: AgentRunGraph, source: 'bridge' | 'semantic'): AgentRunGraph {
    const limitBytes = readOperatorRawPayloadMaxBytes();
    const initialBytes = measureJsonBytes(graph);
    if (initialBytes <= limitBytes) {
        return graph;
    }
    const budgetEffect = {
        id: `${graph.taskId}:operator-response-budget`,
        rootTaskId: graph.taskId,
        taskId: graph.taskId,
        operation: 'operator.response_budget',
        status: 'failed' as const,
        hiddenByDefault: false,
        error: {
            code: 'LIMIT_OPERATOR_RESPONSE_TOO_LARGE',
            message: 'Operator graph response exceeded the configured size limit. Raw debug events were omitted.',
            limitBytes,
            actualBytes: initialBytes,
        },
    };
    const compacted: AgentRunGraph = {
        ...graph,
        events: graph.events.slice(0, 25).map((event) => ({
            ...event,
            payload: {
                envelope: budgetEnvelope(
                    'LIMIT_OPERATOR_RESPONSE_TOO_LARGE',
                    limitBytes,
                    initialBytes,
                    'Raw event payload omitted because the operator response exceeded the configured size limit.'
                ),
            },
        })),
        debug: { driverRuns: [] },
        effects: [...graph.effects, budgetEffect],
        projection: {
            source,
            partial: true,
        },
        caps: {
            nodeLimit: graph.caps?.nodeLimit ?? GRAPH_NODE_LIMIT,
            edgeLimit: graph.caps?.edgeLimit ?? GRAPH_EDGE_LIMIT,
            depthLimit: graph.caps?.depthLimit ?? GRAPH_DEPTH_LIMIT,
            truncated: true,
        },
    };
    if (measureJsonBytes(compacted) <= limitBytes || compacted.events.length === 0) {
        return compacted;
    }
    const withoutEvents: AgentRunGraph = {
        ...compacted,
        events: [],
    };
    if (measureJsonBytes(withoutEvents) <= limitBytes) return withoutEvents;
    return {
        schemaVersion: 3,
        tenantId: withoutEvents.tenantId,
        taskId: withoutEvents.taskId,
        root: withoutEvents.root,
        coordination: withoutEvents.coordination,
        nodes: [],
        edges: [],
        turns: [],
        unassignedAttempts: [],
        memoryOps: [],
        effects: [budgetEffect],
        events: [],
        debug: { driverRuns: [] },
        projection: { source, partial: true },
    };
}

function compareGraphShape(bridge: AgentRunGraph, semantic: AgentRunGraph): string | undefined {
    const parts: string[] = [];
    if (bridge.nodes.length !== semantic.nodes.length) parts.push(`nodes ${bridge.nodes.length}/${semantic.nodes.length}`);
    if (bridge.edges.length !== semantic.edges.length) parts.push(`edges ${bridge.edges.length}/${semantic.edges.length}`);
    if (bridge.turns.length !== semantic.turns.length) parts.push(`turns ${bridge.turns.length}/${semantic.turns.length}`);
    if (bridge.root.status !== semantic.root.status) parts.push(`root status ${bridge.root.status}/${semantic.root.status}`);
    return parts.length > 0 ? parts.join(', ') : undefined;
}

function compareListShape(bridge: AgentRunListPage, semantic: AgentRunListPage | undefined): string | undefined {
    if (semantic === undefined) return 'semantic unavailable';
    const parts: string[] = [];
    if (bridge.items.length !== semantic.items.length) parts.push(`items ${bridge.items.length}/${semantic.items.length}`);
    const bridgeIds = new Set(bridge.items.map((item) => item.taskId));
    const missing = semantic.items.filter((item) => !bridgeIds.has(item.taskId)).slice(0, 5).map((item) => item.taskId);
    if (missing.length > 0) parts.push(`semantic-only ${missing.join(',')}`);
    return parts.length > 0 ? parts.join(', ') : undefined;
}

function artifactMetadataForOperator(artifacts: unknown): unknown[] {
    if (!Array.isArray(artifacts)) {
        return [];
    }
    return artifacts
        .map((artifact) => makeSafeEventPreview(artifact))
        .filter((artifact) => artifact !== undefined);
}

function cloneJsonLike<T>(value: T): T {
    return JSON.parse(JSON.stringify(value, (_key, nested) => typeof nested === 'bigint' ? nested.toString() : nested)) as T;
}

function summarizeAgentRunItems(items: AgentRunListItem[]): AgentRunListSummary {
    return items.reduce<AgentRunListSummary>(
        (summary, item) => {
            const status = item.status.toLowerCase();
            summary.total += 1;
            if (status === 'failed' || status === 'error') summary.failed += 1;
            if (status === 'running' || status === 'queued' || status === 'waiting') summary.waiting += 1;
            if (status === 'completed' || status === 'succeeded' || status === 'success') summary.completed += 1;
            if (typeof item.costUsd === 'number') summary.costCaptured += 1;
            else summary.costUnavailable += 1;
            return summary;
        },
        { total: 0, failed: 0, waiting: 0, stuck: 0, completed: 0, costCaptured: 0, costUnavailable: 0 },
    );
}

function buildBridgeAgentRunWhere(params: AgentRunListParams): Record<string, unknown> {
    const and: Record<string, unknown>[] = [{
        tenantId: params.tenantId,
        operation: { in: ['agent.run', 'task.start'] },
        ...(params.agentId !== undefined && params.agentId.length > 0 ? { agentId: params.agentId } : {}),
        ...(params.status !== undefined && params.status.length > 0 ? { status: params.status } : {}),
    }];
    if (params.taskId !== undefined && params.taskId.length > 0) {
        and.push({
            OR: [
                { taskId: { contains: params.taskId } },
                { rootTaskId: { contains: params.taskId } },
            ],
        });
    }
    if (params.since !== undefined && params.since.length > 0) {
        const sinceDate = new Date(params.since);
        if (!Number.isNaN(sinceDate.getTime())) {
            and.push({ createdAt: { gte: sinceDate } });
        }
    }
    return and.length === 1 ? and[0]! : { AND: and };
}

function withBridgeCursor(where: Record<string, unknown>, cursor: AgentRunCursor | undefined): Record<string, unknown> {
    if (cursor === undefined) {
        return where;
    }
    const cursorDate = new Date(cursor.createdAt);
    if (Number.isNaN(cursorDate.getTime())) {
        return where;
    }
    return {
        AND: [
            where,
            {
                OR: [
                    { createdAt: { lt: cursorDate } },
                    { createdAt: cursorDate, id: { lt: cursor.id } },
                ],
            },
        ],
    };
}

async function summarizeBridgeAgentRuns(
    prisma: OperatorPrismaClient,
    params: AgentRunListParams,
    baseWhere: Record<string, unknown>,
    childTaskIds: Set<string>
): Promise<AgentRunListSummary> {
    const summary: AgentRunListSummary = { total: 0, failed: 0, waiting: 0, stuck: 0, completed: 0, costCaptured: 0, costUnavailable: 0 };
    const batchSize = 1000;
    let cursor: AgentRunCursor | undefined;
    for (let guard = 0; guard < 100; guard += 1) {
        const rows = await prisma.driverRun!.findMany({
            where: withBridgeCursor(baseWhere, cursor),
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: batchSize,
        });
        if (rows.length === 0) {
            break;
        }
        for (const row of rows) {
            if ((params.scope ?? 'roots') === 'roots' && !isRootDriverRun(row, childTaskIds)) {
                continue;
            }
            summary.total += 1;
            const status = String(row.status ?? 'unknown').toLowerCase();
            if (status === 'failed' || status === 'error') summary.failed += 1;
            if (status === 'running' || status === 'queued' || status === 'waiting') summary.waiting += 1;
            if (status === 'completed' || status === 'succeeded' || status === 'success') summary.completed += 1;
        }
        const last = rows[rows.length - 1];
        if (rows.length < batchSize || last === undefined) {
            break;
        }
        cursor = {
            createdAt: last.createdAt instanceof Date ? last.createdAt.toISOString() : last.createdAt,
            id: last.id,
        };
    }
    summary.costUnavailable = summary.total;
    return summary;
}

type PendingConversationActivation = {
    params: ConversationActivateParams;
    waiters: Array<{
        resolve: (value: ConversationActivateResult) => void;
        reject: (reason?: unknown) => void;
    }>;
};

type WaitForBackgroundTasksOptions = {
    throwOnTimeout?: boolean;
    rootTaskId?: string;
};

export type BackgroundTaskDrainReport = {
    elapsedMs: number;
    activeCount: number;
    detachedCount: number;
    remainingTasks: BackgroundTaskSummary[];
    activeConversationActivations: string[];
    pendingConversationActivations: string[];
};

export class BackgroundTaskDrainError extends Error {
    public readonly code = 'BACKGROUND_TASK_DRAIN_INCOMPLETE';
    public readonly report: BackgroundTaskDrainReport;

    constructor(report: BackgroundTaskDrainReport) {
        super(
            `Background task drain incomplete after ${report.elapsedMs}ms: ` +
            `remainingPromises=${report.activeCount}, ` +
            `activeConversationActivations=${report.activeConversationActivations.length}, ` +
            `pendingConversationActivations=${report.pendingConversationActivations.length}, ` +
            `remainingTasks=${JSON.stringify(report.remainingTasks)}`
        );
        this.name = 'BackgroundTaskDrainError';
        this.report = report;
        Object.setPrototypeOf(this, BackgroundTaskDrainError.prototype);
    }
}

export type AgentRunListItem = {
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

export type AgentRunListPage = {
    items: AgentRunListItem[];
    nextCursor?: string;
    summary?: AgentRunListSummary;
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

export type AgentRunListSummary = {
    total: number;
    failed: number;
    waiting: number;
    stuck: number;
    completed: number;
    costCaptured: number;
    costUnavailable: number;
};

type AgentRunListParams = {
    tenantId: string;
    agentId?: string;
    status?: string;
    since?: string;
    cursor?: string;
    limit?: number;
    scope?: 'roots' | 'all';
    taskId?: string;
    hasLlm?: boolean;
    hasMemory?: boolean;
    costState?: 'captured' | 'missing';
    scheduleId?: string;
};

type DriverRunListRow = DriverRunView & {
    id: string;
    createdAt: Date | string;
    updatedAt: Date | string;
};

type WMEventRow = {
    eventId: string;
    sessionId: string;
    seq: number;
    type: string;
    payload: Record<string, unknown>;
    createdAt: Date | string;
};

type OperatorPrismaClient = {
    driverRun?: {
        findMany: (args: Record<string, unknown>) => Promise<DriverRunListRow[]>;
        count?: (args: { where?: Record<string, unknown> }) => Promise<number>;
        groupBy?: (args: {
            by: string[];
            where?: Record<string, unknown>;
            _count: { _all: true };
        }) => Promise<Array<{ status: string; _count: { _all: number } }>>;
    };
    wMEvent?: {
        findMany: (args: Record<string, unknown>) => Promise<WMEventRow[]>;
    };
    agentRun?: unknown;
    agentRunEdge?: unknown;
    turnRun?: unknown;
    runEffect?: unknown;
};

type AgentRunCursor = {
    createdAt: string;
    id: string;
};

/**
 * Merge ctx.telemetry into snapshot meta on every persist path (not only TaskExecutor.saveSnapshot).
 * Without this, a flush before tool await can drop meta.telemetry; tool resume then loses trace continuity.
 */
function mergeSnapshotMetaWithCtxTelemetry(
    baseSnap: Record<string, unknown>,
    ctx: TaskContext
): Record<string, unknown> {
    const prevMeta =
        baseSnap.meta != null && typeof baseSnap.meta === 'object' && !Array.isArray(baseSnap.meta)
            ? ({ ...(baseSnap.meta as Record<string, unknown>) } as Record<string, unknown>)
            : {};
    const nextMeta: Record<string, unknown> = { ...prevMeta };
    const tel = ctx.telemetry;
    if (tel != null && (tel.nodeId !== undefined || tel.traceId !== undefined)) {
        const prevTel =
            prevMeta.telemetry != null &&
            typeof prevMeta.telemetry === 'object' &&
            !Array.isArray(prevMeta.telemetry)
                ? ({ ...(prevMeta.telemetry as Record<string, unknown>) } as Record<string, unknown>)
                : {};
        nextMeta.telemetry = { ...prevTel, ...tel };
    }
    return nextMeta;
}

export type TaskEngineTestOverrides = {
    attachAndRestoreLLM?: (ctx: TaskContext, agentName: string | undefined, M: MentalState | undefined, baseSnap?: Record<string, unknown>) => Promise<void>;
};
// Re-export or use the extracted class
// Re-export or use the extracted class
import { FlushScheduler } from './engine/FlushScheduler.js';
import { PathUtils } from './utils/PathUtils.js';
import { SnapshotRepository } from './persistence/SnapshotRepository.js';
import { ApiBinder } from './api/ApiBinder.js';
import { TaskStateUtils } from './utils/TaskStateUtils.js';
import { TurnRunner, type TurnExecutionParams } from './TurnRunner.js';
import { readLoopBudgetsFromSnapshotMeta } from './loopOptsFromSnapshotMeta.js';
import { throwInvariantError } from '../utils/invariantError.js';
import type { InvariantErrorCode, InvariantErrorDetail } from '../types/invariantError.js';
import { ConversationService } from '../internal/conversation/ConversationService.js';
import { ensureBuiltinTopicProjectionsRegistered } from '../internal/conversation/builtinTopicProjections.js';
import { ConversationRouter } from '../internal/conversation/ConversationRouter.js';
import { InviteDeliveryCoordinator } from '../internal/conversation/InviteDeliveryCoordinator.js';
import { InviteSweeper } from '../internal/conversation/InviteSweeper.js';
import { ThreadLifecycleSweeper } from '../internal/conversation/ThreadLifecycleSweeper.js';
import { TopicLifecycleSweeper } from '../internal/conversation/TopicLifecycleSweeper.js';
import { wallClock } from '../internal/conversation/Clock.js';
import type {
    ConversationActivateParams,
    ConversationActivateResult,
} from '../internal/conversation/types.js';

// Legacy adapters to maintain internal calls if needed, or replace usages.

// FlushScheduler extracted to ./engine/FlushScheduler.ts

class KeyedMutex {
    private mutexes = new Map<string, Promise<void>>();

    async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const previous = this.mutexes.get(key) || Promise.resolve();
        let release: () => void;
        const currentTaskComplete = new Promise<void>(resolve => { release = resolve; });
        const chainPromise = previous.then(() => currentTaskComplete);
        this.mutexes.set(key, chainPromise);

        try {
            log.debug(`[KeyedMutex] Waiting for lock on key ${key}`);
            await previous;
            log.debug(`[KeyedMutex] Acquired lock on key ${key}`);
        } catch { /* ignore previous failure */ }

        try {
            return await fn();
        } finally {
            log.debug(`[KeyedMutex] Releasing lock on key ${key}`);
            release!();
            if (this.mutexes.get(key) === chainPromise) {
                this.mutexes.delete(key);
            }
        }
    }
}

export class TaskEngine {
    static testOverrides?: TaskEngineTestOverrides;
    readonly eventBus: IEventBus;
    private readonly runtimeInstanceId = uuidv7();
    private readonly backpressureManager = new BackpressureManager();
    private outboxPublisherInstance?: OutboxPublisher;
    private sessionManager?: SessionManager;
    private snapshotRepo?: SnapshotRepository;
    private taskExecutorInitialized = false;
    private flushScheduler = new FlushScheduler();
    private taskCreationMutex = new KeyedMutex();
    private handlerInvoker?: DurableHandlerInvoker;
    // Track background task promises for cleanup (especially in tests)
    private readonly backgroundTaskPromises = new Set<Promise<void>>();
    private readonly backgroundTaskMetadata = new Map<Promise<void>, BackgroundTaskMetadata>();
    private readonly terminalBranchCache = new Map<string, {
        state: 'completed' | 'failed' | 'canceled' | 'detached';
        reason?: string;
        recordedAt: number;
    }>();
    private apiBinder: ApiBinder;
    private turnRunner: TurnRunner;
    /** Phase 0.3: scheduling seam; default is in-process (ADR 0001). */
    private readonly runtimeDriver: RuntimeDriver;
    /** In-process turn executor retained even when an outer driver wraps scheduling. */
    private readonly compositionTurnExecutor: TurnExecutor;
    private conversationService: ConversationService;
    private inviteDeliveryCoordinator: InviteDeliveryCoordinator;
    private inviteSweeper: InviteSweeper;
    private threadLifecycleSweeper: ThreadLifecycleSweeper;
    private topicLifecycleSweeper: TopicLifecycleSweeper;
    private readonly activeConversationActivations = new Set<string>();
    private readonly pendingConversationActivations = new Map<string, PendingConversationActivation>();
    private readonly recentConversationActivationTargets = new Map<string, ConversationActivateParams>();
    private transportClose?: () => Promise<void>;
    /** When adapters are resolved via `resolveTransportAdapters`, wired here for projections / extensions. */
    readonly createDurableSubscription?: (ctx: {
        tenantId: string;
        persistence: DurableSubscriptionPersistence;
    }) => DurableSubscription;

    constructor(opts?: {
        sessionStore?: IWorkingMemorySessionStore;
        handlerInvoker?: DurableHandlerInvoker;
        eventBus?: IEventBus;
        /** Inner `MessageLog` (before `wrapMessageLogWithTopicStream`). Defaults to `createDbMessageLog(sessionManager)`. */
        messageLog?: MessageLog;
        createDurableSubscription?: (ctx: {
            tenantId: string;
            persistence: DurableSubscriptionPersistence;
        }) => DurableSubscription;
        transportClose?: () => Promise<void>;
        /** Override the default in-process runtime driver (tests / future Hatchet adapter). */
        runtimeDriver?: RuntimeDriver;
        /** Wrap the default in-process stack driver (e.g. Hatchet outbox delegation). */
        runtimeDriverFactory?: (stack: InProcessRuntimeStack) => RuntimeDriver;
    }) {
        this.transportClose = opts?.transportClose;
        this.createDurableSubscription = opts?.createDurableSubscription;
        this.eventBus = opts?.eventBus ?? createInMemoryEventBus();
        if (opts?.sessionStore) {
            this.sessionManager = new SessionManager(opts.sessionStore);
        } else {
            // Default to in-memory session manager for testing/CLI
            log.warn('No SessionStore configured - using IN-MEMORY mode');
            log.warn('⚠️  IN-MEMORY MODE IS NOT SUITABLE FOR PRODUCTION');
            log.warn('For production, configure a database-backed SessionStore');
            this.sessionManager = new SessionManager(new InMemorySessionManager());
        }
        const deliveryScope = this.eventBus.deliveryScope ?? 'process';
        this.sessionManager.configureOutboxDelivery({
            scope: deliveryScope,
            ...(deliveryScope === 'process' ? { ownerId: this.runtimeInstanceId } : {}),
        });
        ensureBuiltinTopicProjectionsRegistered();
        this.snapshotRepo = new SnapshotRepository(this.sessionManager);
        this.conversationService = new ConversationService(this.sessionManager, {
            routeTargetForThread: ({ threadId, recipientAgentId, tenantId }) => ({
                tenantId,
                agentId: recipientAgentId,
                sessionId: `${threadId}:${recipientAgentId}`,
            }),
            activateConversationRecipient: (p) =>
                this.trackBackgroundTask(this.ensureConversationActivation(p), {
                    kind: 'conversation.activation',
                    label: `conversation.activation ${p.kind}:${p.recipientAgentId}`,
                    tenantId: p.tenantId,
                    taskId: p.routingSessionId,
                    agentId: p.recipientAgentId,
                    token: p.kind === 'invite' ? p.token : undefined,
                    source: 'ConversationService.activateConversationRecipient',
                }),
            publishConversationEvent: async (channel, event) => {
                await this.eventBus.publish(
                    createBusEvent({
                        channel,
                        cloud: {
                            id: uuidv7(),
                            type: channel,
                            source: '/conversation/events',
                            time: new Date().toISOString(),
                            datacontenttype: 'application/json',
                            data: event,
                        },
                    })
                );
            },
            publishRuntimeEvent: async ({ sessionId, event }) => {
                await this.eventBus.publish(
                    createBusEvent({
                        channel: taskChannel(sessionId),
                        partitionKey: sessionId,
                        cloud: {
                            id: event.id,
                            type: event.type,
                            source: `/tasks/${sessionId}`,
                            time: event.ts,
                            datacontenttype: 'application/json',
                            data: event,
                        },
                    })
                );
            },
            clock: wallClock,
            messageLog: wrapMessageLogWithTopicStream({
                inner: opts?.messageLog ?? createDbMessageLog(this.sessionManager),
                eventBus: this.eventBus,
            }),
            backpressureManager: this.backpressureManager,
            resolveThreadTtlMs: (agentId: string) => {
                const plugin = PluginManager.findAgent(agentId);
                const raw = plugin?.resolved.runtimeManifest.communication?.threadTtlMs;
                if (raw === null) {
                    return null;
                }
                if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
                    return raw;
                }
                return 3600000;
            },
            resolveAgentCommunication: (agentId: string) =>
                PluginManager.findAgent(agentId)?.resolved.runtimeManifest.communication,
            resolveWakeOnTopicMessage: (agentId: string) =>
                PluginManager.findAgent(agentId)?.resolved.runtimeManifest.communication?.wakeOnTopicMessage ===
                true,
        });
        this.threadLifecycleSweeper = new ThreadLifecycleSweeper(
            this.sessionManager,
            ({ threadId, recipientAgentId, tenantId }) => ({
                tenantId,
                agentId: recipientAgentId,
                sessionId: `${threadId}:${recipientAgentId}`,
            }),
            wallClock
        );
        this.topicLifecycleSweeper = new TopicLifecycleSweeper(this.sessionManager, wallClock);
        this.inviteDeliveryCoordinator = new InviteDeliveryCoordinator(
            this.sessionManager,
            this.eventBus,
            (params) => this.ensureConversationActivation(params),
            wallClock
        );
        void this.inviteDeliveryCoordinator.start().catch((err) => {
            log.warn('InviteDeliveryCoordinator.start failed', err as { message?: string });
        });
        this.inviteSweeper = new InviteSweeper(this.sessionManager, wallClock);

        this.apiBinder = new ApiBinder({
            sessionManager: this.sessionManager,
            snapshotRepo: this.snapshotRepo,
            getTraceContext: () => ({}), // Dummy for now, or fetch from context if generic
            getSessionStorePrisma: () => this.getSessionStorePrisma(),
            taskCreationMutex: this.taskCreationMutex,
            backgroundTaskPromises: this.backgroundTaskPromises,
            trackBackgroundTask: (promise, metadata) => this.trackBackgroundTask(promise, metadata),
            runOwnedEffect: (factory, metadata) => this.runOwnedEffect(factory, metadata),
            handleToolCompleted: (p) => this.handleToolCompleted(p),
            conversationService: this.conversationService,
            eventBus: this.eventBus,
            enqueueChildStart: (p) => this.runtimeDriver.enqueueStart(p),
            scheduleChildTimeout: (p) => this.runtimeDriver.scheduleTimer(p),
            cancelTimer: (p) => this.runtimeDriver.cancelTimer?.(p) ?? Promise.resolve(),
            detachTaskBranch: (p) => this.detachTaskBranch(p),
            getRuntimeSurface: () => this.runtimeDriver.surface ?? 'in_process',
            submitRootTask: async ({ tenantId, sourceTaskId, sourceAgentId, targetAgentId, input, options }) => {
                const sourcePlugin = PluginManager.findAgent(sourceAgentId);
                const allowAgents = sourcePlugin?.resolved.runtimeManifest.orchestration
                    ?.rootTaskSubmission?.allowAgents ?? [];
                if (!allowAgents.includes(targetAgentId)) {
                    const error = new Error(`Agent ${sourceAgentId} may not submit root tasks to ${targetAgentId}`);
                    error.name = 'ROOT_TASK_SUBMISSION_TARGET_NOT_ALLOWED';
                    throw error;
                }
                const source = await this.sessionManager!.load(tenantId, sourceTaskId);
                if (source === null) {
                    const error = new Error(`Source task ${sourceTaskId} is unavailable`);
                    error.name = 'ROOT_TASK_SUBMISSION_SOURCE_UNAVAILABLE';
                    throw error;
                }
                const inherited = readTaskSubmissionMetadata(source.snapshot)?.origin;
                return this.submitTask({
                    tenantId,
                    taskId: options.taskId,
                    agentId: targetAgentId,
                    input,
                    ...(options.maxTurns !== undefined || options.taskRunTimeoutMs !== undefined
                        ? {
                              options: {
                                  ...(options.maxTurns !== undefined
                                      ? { maxTurns: options.maxTurns }
                                      : {}),
                                  ...(options.taskRunTimeoutMs !== undefined
                                      ? { taskRunTimeoutMs: options.taskRunTimeoutMs }
                                      : {}),
                              },
                          }
                        : {}),
                    origin: {
                        kind: 'agent',
                        submittedByTaskId: sourceTaskId,
                        ...(inherited?.scheduleId ? { scheduleId: inherited.scheduleId } : {}),
                        ...(inherited?.scheduleOccurrenceId
                            ? { scheduleOccurrenceId: inherited.scheduleOccurrenceId }
                            : {}),
                        ...(inherited?.scheduledFor ? { scheduledFor: inherited.scheduledFor } : {}),
                    },
                });
            },
        });

        this.turnRunner = new TurnRunner(
            this.sessionManager!,
            this.apiBinder,
            () => this.getSessionStorePrisma(),
            this.eventBus
        );

        const inProcessStack = buildInProcessRuntimeStack({
            turnRunner: this.turnRunner,
            sessionManager: this.sessionManager!,
            createContext: (task, binding) =>
                this.createContext(
                    { id: task.id, input: task.input as TaskInput },
                    binding
                ),
            onChildTimeout: async (params) => {
                await this.detachTaskBranch({
                    tenantId: params.tenantId,
                    taskId: params.childTaskId,
                    reason: 'child_timeout',
                });
            },
            onTaskTerminal: async (params) => {
                try {
                    await this.runtimeDriver.cancelTimer?.({
                        tenantId: params.tenantId,
                        taskId: params.taskId,
                        token: 'root-run-timeout',
                    });
                } catch (error) {
                    log.warn('Root run deadline timer cancellation failed after terminal convergence', {
                        tenantId: params.tenantId,
                        taskId: params.taskId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
                // Hatchet parent delivery is owned exclusively by the keyed
                // aplret.task-state terminal projection. The shared segment
                // executor still performs local branch cleanup, but must not
                // become a second asynchronous completion producer.
                if (params.runtimeSurface !== 'hatchet') {
                    await this.notifyPersistedA2AParentIfTerminal({
                        tenantId: params.tenantId,
                        taskId: params.taskId,
                    });
                }
                await this.detachTaskBranch({
                    tenantId: params.tenantId,
                    taskId: params.taskId,
                    reason: `task_${params.state}`,
                });
            },
            ensureInitialRootDeadline: async (params) => {
                const disposition = await this.ensureAdmittedRootDeadline({
                    ...params,
                    phase: 'initial_segment',
                });
                if (disposition === 'unavailable') {
                    const error = new Error(
                        `Durable root deadline timer is unavailable for ${params.tenantId}/${params.taskId}`
                    );
                    error.name = 'TASK_RUN_DEADLINE_UNAVAILABLE';
                    throw error;
                }
                if (disposition === 'canceled') return 'canceled';
                if (disposition === 'terminal') return 'terminal';
                return 'ready';
            },
            onTaskRunTimeout: (params) => this.handleTaskRunTimeout(params),
            enableTurnRecovery: opts?.runtimeDriver === undefined && opts?.runtimeDriverFactory === undefined,
        });
        this.compositionTurnExecutor = inProcessStack.turnExecutor;
        this.runtimeDriver =
            opts?.runtimeDriver ??
            opts?.runtimeDriverFactory?.(inProcessStack) ??
            inProcessStack.runtimeDriver;

        this.sessionManager.setOnOutboxEnqueued(async (ref) => {
            if (ref.deliveryScope === 'process') {
                if (ref.deliveryOwnerId !== this.runtimeInstanceId) {
                    defaultMetricsRegistry.increment('runtime.outbox_dispatch_total', {
                        status: 'foreign_owner',
                        type: ref.eventType,
                    });
                    return;
                }
                const prisma = this.getSessionStorePrisma();
                if (prisma) {
                    const leaseId = uuidv7();
                    const claim = await claimOutboxRow({
                        prisma: prisma as unknown as Parameters<typeof claimOutboxRow>[0]['prisma'],
                        id: ref.outboxRowId,
                        leaseId,
                        scope: 'process',
                        ownerId: this.runtimeInstanceId,
                    });
                    if (claim.disposition !== 'claimed' || !claim.row) return;
                    try {
                        await dispatchOutboxRow({ eventBus: this.eventBus, row: claim.row });
                        await deleteClaimedOutboxRow({
                            prisma: prisma as unknown as Parameters<typeof deleteClaimedOutboxRow>[0]['prisma'],
                            id: ref.outboxRowId,
                            leaseId,
                        });
                    } catch (error) {
                        await releaseClaimedOutboxRow({
                            prisma: prisma as unknown as Parameters<typeof releaseClaimedOutboxRow>[0]['prisma'],
                            id: ref.outboxRowId,
                            leaseId,
                        }).catch(() => false);
                        throw error;
                    }
                    return;
                }
                await dispatchOutboxRow({
                    eventBus: this.eventBus,
                    row: {
                        id: ref.outboxRowId,
                        tenantId: ref.tenantId,
                        topic: ref.eventType,
                        key: ref.key,
                        payload: ref.payload,
                        retryCount: 0,
                        createdAt: new Date(),
                        deliveryScope: 'process',
                        deliveryOwnerId: this.runtimeInstanceId,
                    },
                });
                return;
            }
            if (isHatchetOutboxTopic(ref.eventType)) {
                await this.runtimeDriver.dispatchOutbox({
                    outboxRowId: ref.outboxRowId,
                    eventType: ref.eventType,
                    tenantId: ref.tenantId,
                    taskId: ref.key,
                    agentId: ref.agentId,
                    traceId: ref.traceId,
                    token: ref.token,
                });
            }
        });

        if (opts?.handlerInvoker) {
            this.handlerInvoker = opts.handlerInvoker;
        } else {
            // Default basic invoker using local restoreCtx
            this.handlerInvoker = new DurableHandlerInvokerCore(this.restoreCtx.bind(this));
        }

        // Ensure outbox publisher is running (unless disabled for tests)
        // In test environments, we don't want background services running
        if (!process.env.DISABLE_OUTBOX_PUBLISHER && deliveryScope === 'shared') {
            this.outboxPublisherInstance = new OutboxPublisher({
                eventBus: this.eventBus,
                getPrisma: () => this.getSessionStorePrisma() ?? null,
            });
            try {
                this.outboxPublisherInstance.start();
            } catch {
                /* noop */
            }
        }
    }

    /**
     * Cold-start one turn on the thread-bound recipient session after inbox delivery.
     * Always schedules work in a microtask so nested ctx.conversation.send (B→A→B) does not deadlock
     * the caller's synchronous activation stack.
     */
    async ensureConversationActivation(
        params: ConversationActivateParams
    ): Promise<ConversationActivateResult> {
        this.rememberConversationActivationTarget(params);
        return new Promise<ConversationActivateResult>((resolve, reject) => {
            queueMicrotask(() => {
                this.runConversationActivationSerial(params).then(resolve).catch(reject);
            });
        });
    }

    private async runConversationActivationSerial(
        params: ConversationActivateParams
    ): Promise<ConversationActivateResult> {
        const activationKey = `${params.tenantId}:${params.routingSessionId}`;
        if (this.activeConversationActivations.has(activationKey)) {
            return new Promise<ConversationActivateResult>((resolve, reject) => {
                const existing = this.pendingConversationActivations.get(activationKey);
                if (existing !== undefined) {
                    existing.params = params;
                    existing.waiters.push({ resolve, reject });
                    return;
                }
                this.pendingConversationActivations.set(activationKey, {
                    params,
                    waiters: [{ resolve, reject }],
                });
            });
        }

        this.activeConversationActivations.add(activationKey);
        let result: ConversationActivateResult = { ok: true };
        try {
            result = await this.drainConversationActivations(activationKey, {
                params,
                waiters: [],
            });
        } finally {
            result = (await this.releaseConversationActivation(activationKey)) ?? result;
        }
        return result;
    }

    /**
     * Phase 0.3: route a prepared turn through the runtime driver while preserving
     * today's synchronous await semantics and TaskEngine-prepared ctx/snapshot.
     */
    private async runPreparedTurnThroughDriver(params: {
        operation: 'start' | 'resume';
        tenantId: string;
        taskId: string;
        agentId?: string;
        idempotencyKey: string;
        input?: unknown;
        resumeEvent?: RuntimeWakeEvent;
        ctx: TaskContext;
        turnParams: TurnExecutionParams;
        initialM?: MentalState;
        snapshot?: Record<string, unknown>;
    }): Promise<TaskEntity> {
        const prepared: PreparedTurnInvocation = {
            ctx: params.ctx,
            turnParams: params.turnParams,
            initialM: params.initialM,
            snapshot: params.snapshot,
        };

        if (isSyncRuntimeDriver(this.runtimeDriver)) {
            const segmentResult =
                params.operation === 'start'
                    ? await this.runtimeDriver.enqueueStartSync({
                          tenantId: params.tenantId,
                          taskId: params.taskId,
                          agentId: params.agentId,
                          idempotencyKey: params.idempotencyKey,
                          input: params.input ?? {},
                          prepared,
                      })
                    : await this.runtimeDriver.enqueueResumeSync({
                          tenantId: params.tenantId,
                          taskId: params.taskId,
                          agentId: params.agentId,
                          idempotencyKey: params.idempotencyKey,
                          event: params.resumeEvent!,
                          prepared,
                      });
            return taskEntityFromSegmentResult(segmentResult, params.input ?? {});
        }

        if (params.operation === 'start') {
            await this.runtimeDriver.enqueueStart({
                tenantId: params.tenantId,
                taskId: params.taskId,
                agentId: params.agentId,
                idempotencyKey: params.idempotencyKey,
                input: params.input ?? {},
            });
        } else {
            await this.runtimeDriver.enqueueResume({
                tenantId: params.tenantId,
                taskId: params.taskId,
                agentId: params.agentId,
                idempotencyKey: params.idempotencyKey,
                event: params.resumeEvent!,
            });
        }

        return {
            id: params.taskId,
            input: params.input ?? {},
            status: {
                state: 'working',
                timestamp: new Date().toISOString(),
            },
        } as TaskEntity;
    }

    private async notifyA2AParentIfTerminal(
        ctx: TaskContext,
        task: TaskEntity,
        childAgentId?: string
    ): Promise<void> {
        const childCtx = ctx as A2AChildContext;
        const parent = childCtx.__a2aParent;
        if (!parent || childCtx.__a2aParentNotified) {
            return;
        }

        // A runtime surface may retain a stale process-local TaskEntity after the
        // fenced turn has already committed its terminal snapshot. Parent delivery
        // must follow the durable winner, never that local object.
        const persisted = await this.sessionManager?.load(ctx.tenantId, task.id);
        const durableTerminal = readDurableTaskTerminal(
            persisted?.snapshot as Record<string, unknown> | undefined
        );
        const authoritativeStatus = durableTerminal?.status as TaskStatus | undefined ?? task.status;
        if (authoritativeStatus === undefined || !isA2ATerminalTaskState(authoritativeStatus.state)) {
            return;
        }

        childCtx.__a2aParentNotified = true;
        if (authoritativeStatus.state === 'failed' || authoritativeStatus.state === 'canceled') {
            const metadata = authoritativeStatus.metadata as Record<string, unknown> | undefined;
            const messagePart = authoritativeStatus.message?.parts?.find(
                (part) => part.type === 'text'
            ) as { text?: string } | undefined;
            await this.handleChildFailed({
                tenantId: parent.parentTenantId,
                parentTaskId: parent.parentTaskId,
                childToken: parent.parentChildToken,
                childTaskId: task.id,
                error: {
                    code: typeof metadata?.code === 'string'
                        ? metadata.code
                        : authoritativeStatus.state === 'canceled' ? 'CHILD_CANCELED' : 'CHILD_FAILED',
                    message: messagePart?.text ??
                        (typeof metadata?.reason === 'string'
                            ? metadata.reason
                            : `Child task ${authoritativeStatus.state}`),
                },
                ...(durableTerminal?.turnClaim !== undefined
                    ? { childTerminalIdentity: durableTerminal.turnClaim }
                    : {}),
            });
            return;
        }
        await this.handleChildCompleted({
            tenantId: parent.parentTenantId,
            parentTaskId: parent.parentTaskId,
            childToken: parent.parentChildToken,
            childTaskId: task.id,
            result: { ...task, status: authoritativeStatus },
            childAgentId,
            ...(durableTerminal?.turnClaim !== undefined
                ? { childTerminalIdentity: durableTerminal.turnClaim }
                : {}),
        });
    }

    private async notifyPersistedA2AParentIfTerminal(params: {
        tenantId: string;
        taskId: string;
    }): Promise<void> {
        const persisted = await this.sessionManager?.load(params.tenantId, params.taskId);
        const snapshot = persisted?.snapshot as Record<string, unknown> | undefined;
        if (snapshot === undefined) return;
        const parent = readA2AParentLink(
            (snapshot as { meta?: { a2aParent?: unknown } }).meta?.a2aParent
        );
        const terminal = readDurableTaskTerminal(snapshot);
        if (parent === undefined || terminal === undefined) return;

        await this.notifyA2AParentIfTerminal(
            {
                tenantId: params.tenantId,
                __a2aParent: parent,
            } as unknown as TaskContext,
            {
                id: params.taskId,
                input: {},
                status: terminal.status as TaskStatus,
            } as TaskEntity,
            persisted?.agentId
        );
    }

    private async drainConversationActivations(
        activationKey: string,
        firstActivation?: PendingConversationActivation
    ): Promise<ConversationActivateResult> {
        let nextActivation: PendingConversationActivation | undefined = firstActivation;
        let result: ConversationActivateResult = { ok: true };
        let drainedTurns = 0;
        while (nextActivation !== undefined || this.pendingConversationActivations.has(activationKey)) {
            if (nextActivation === undefined) {
                nextActivation = this.shiftPendingConversationActivation(activationKey);
            }
            if (nextActivation === undefined) {
                break;
            }
            const currentActivation = nextActivation;
            const currentParams = currentActivation.params;
            drainedTurns += 1;
            try {
                result = await this.runConversationActivationBody(currentParams);
                for (const waiter of currentActivation.waiters) {
                    waiter.resolve(result);
                }
            } catch (err) {
                for (const waiter of currentActivation.waiters) {
                    waiter.reject(err);
                }
                throw err;
            }
            nextActivation = this.shiftPendingConversationActivation(activationKey);
            if (
                nextActivation === undefined &&
                drainedTurns < 32 &&
                await this.hasCurrentInboundConversationDelivery(currentParams)
            ) {
                nextActivation = { params: currentParams, waiters: [] };
            }
        }
        return result;
    }

    private shiftPendingConversationActivation(activationKey: string): PendingConversationActivation | undefined {
        const nextActivation = this.pendingConversationActivations.get(activationKey);
        if (nextActivation !== undefined) {
            this.pendingConversationActivations.delete(activationKey);
        }
        return nextActivation;
    }

    private async releaseConversationActivation(
        activationKey: string
    ): Promise<ConversationActivateResult | undefined> {
        if (!this.pendingConversationActivations.has(activationKey)) {
            this.activeConversationActivations.delete(activationKey);
            return undefined;
        }
        const nextActivation = this.shiftPendingConversationActivation(activationKey);
        this.activeConversationActivations.delete(activationKey);
        if (nextActivation === undefined) {
            return undefined;
        }
        this.activeConversationActivations.add(activationKey);
        let result: ConversationActivateResult = { ok: true };
        try {
            result = await this.drainConversationActivations(activationKey, nextActivation);
        } finally {
            result = (await this.releaseConversationActivation(activationKey)) ?? result;
        }
        return result;
    }

    private trackBackgroundTask<T>(
        promise: Promise<T>,
        metadata: Omit<BackgroundTaskMetadata, 'startedAt' | 'state'> = {
            kind: 'unknown',
            label: 'background task',
        }
    ): Promise<T> {
        let tracked: Promise<void>;
        tracked = promise
            .then(() => undefined, () => undefined)
            .finally(() => {
                this.backgroundTaskPromises.delete(tracked);
                this.backgroundTaskMetadata.delete(tracked);
            });
        this.backgroundTaskPromises.add(tracked);
        this.backgroundTaskMetadata.set(tracked, {
            ...metadata,
            label: metadata.label ?? metadata.kind,
            state: 'active',
            startedAt: Date.now(),
        });
        return promise;
    }

    private rememberTerminalBranch(
        tenantId: string,
        taskId: string,
        state: 'completed' | 'failed' | 'canceled' | 'detached',
        reason?: string
    ): void {
        const key = `${tenantId}:${taskId}`;
        this.terminalBranchCache.delete(key);
        this.terminalBranchCache.set(key, { state, reason, recordedAt: Date.now() });
        while (this.terminalBranchCache.size > 2048) {
            const oldest = this.terminalBranchCache.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.terminalBranchCache.delete(oldest);
        }
    }

    private runOwnedEffect<T>(
        factory: (control: { signal: AbortSignal }) => Promise<T>,
        metadata: Omit<BackgroundTaskMetadata, 'startedAt' | 'state' | 'abort'> & {
            tenantId: string;
            taskId: string;
        }
    ): Promise<T> {
        const abortController = new AbortController();
        const turnClaim = currentTaskTurnClaim();
        const abortForSupersededTurn = () => {
            abortController.abort(turnClaim?.abortSignal?.reason ?? 'task turn superseded');
        };
        if (turnClaim?.abortSignal?.aborted) {
            abortForSupersededTurn();
        } else {
            turnClaim?.abortSignal?.addEventListener('abort', abortForSupersededTurn, { once: true });
        }
        let resolveResult!: (value: T | PromiseLike<T>) => void;
        let rejectResult!: (reason?: unknown) => void;
        const result = new Promise<T>((resolve, reject) => {
            resolveResult = resolve;
            rejectResult = reject;
        });
        let tracked: Promise<void>;
        tracked = result
            .then(() => undefined, () => undefined)
            .finally(() => {
                turnClaim?.abortSignal?.removeEventListener('abort', abortForSupersededTurn);
                this.backgroundTaskPromises.delete(tracked);
                this.backgroundTaskMetadata.delete(tracked);
            });
        this.backgroundTaskPromises.add(tracked);
        const ownedMetadata: BackgroundTaskMetadata = {
            ...metadata,
            label: metadata.label ?? metadata.kind,
            state: 'registering',
            startedAt: Date.now(),
            abort: () => abortController.abort('task lifecycle detached'),
        };
        this.backgroundTaskMetadata.set(tracked, ownedMetadata);

        queueMicrotask(() => {
            void (async () => {
                try {
                    const cached = this.terminalBranchCache.get(`${metadata.tenantId}:${metadata.taskId}`);
                    if (cached !== undefined) {
                        throw new TaskLifecycleTerminalError({
                            tenantId: metadata.tenantId,
                            taskId: metadata.taskId,
                            state: cached.state,
                            ...(cached.reason !== undefined ? { reason: cached.reason } : {}),
                            effectKind: metadata.kind,
                        });
                    }
                    await assertTaskEffectActive({
                        session: this.sessionManager!,
                        tenantId: metadata.tenantId,
                        taskId: metadata.taskId,
                        effectKind: metadata.kind,
                        token: metadata.token,
                        pendingKind: metadata.pendingKind,
                    });
                    if (abortController.signal.aborted || ownedMetadata.state === 'detached') {
                        throw new TaskLifecycleTerminalError({
                            tenantId: metadata.tenantId,
                            taskId: metadata.taskId,
                            state: 'detached',
                            reason: ownedMetadata.detachReason ?? 'detached_before_provider_start',
                            effectKind: metadata.kind,
                        });
                    }
                    ownedMetadata.state = 'active';
                    resolveResult(await factory({ signal: abortController.signal }));
                } catch (error) {
                    if (isTaskLifecycleTerminalError(error)) {
                        abortController.abort(error);
                        ownedMetadata.state = 'detached';
                        ownedMetadata.detachReason = error.details.reason ?? error.details.state;
                        if (error.details.reason !== 'effect_token_not_pending') {
                            await this.detachTaskBranch({
                                tenantId: metadata.tenantId,
                                taskId: metadata.taskId,
                                reason: error.details.reason ?? `owner_${error.details.state}`,
                            });
                        }
                        defaultMetricsRegistry.increment('task_effect_provider_start_suppressed_total', {
                            effect: metadata.kind,
                        });
                    }
                    rejectResult(error);
                }
            })();
        });
        return result;
    }

    private backgroundTasksInScope(rootTaskId?: string, includeDetached = false): Promise<void>[] {
        return Array.from(this.backgroundTaskPromises).filter((promise) => {
            const metadata = this.backgroundTaskMetadata.get(promise);
            if (!includeDetached && metadata?.state === 'detached') return false;
            if (rootTaskId === undefined) return true;
            // Missing ownership is intentionally conservative for legacy callers.
            if (metadata?.rootTaskId === undefined) return true;
            return metadata.rootTaskId === rootTaskId;
        });
    }

    private conversationActivationsInScope(
        rootTaskId?: string
    ): { active: string[]; pending: string[] } {
        const inScope = (activationKey: string) =>
            rootTaskId === undefined || activationKey.endsWith(`:${rootTaskId}`);
        return {
            active: Array.from(this.activeConversationActivations).filter(inScope),
            pending: Array.from(this.pendingConversationActivations.keys()).filter(inScope),
        };
    }

    private describeBackgroundTasks(now = Date.now(), promises?: Promise<void>[]): BackgroundTaskSummary[] {
        return (promises ?? Array.from(this.backgroundTaskPromises)).map((promise, index) => {
            const metadata = this.backgroundTaskMetadata.get(promise);
            return {
                index,
                kind: metadata?.kind ?? 'unknown',
                label: metadata?.label ?? 'untracked background promise',
                ageMs: metadata ? Math.max(0, now - metadata.startedAt) : undefined,
                tenantId: metadata?.tenantId,
                taskId: metadata?.taskId,
                agentId: metadata?.agentId,
                token: metadata?.token,
                toolName: metadata?.toolName,
                childAgent: metadata?.childAgent,
                childTaskId: metadata?.childTaskId,
                source: metadata?.source,
                rootTaskId: metadata?.rootTaskId,
                ancestorTaskIds: metadata?.ancestorTaskIds,
                state: metadata?.state,
                detachReason: metadata?.detachReason,
                abortStatus: metadata?.abortStatus,
            };
        });
    }

    private detachBackgroundTask(promise: Promise<void>, reason: string): boolean {
        const metadata = this.backgroundTaskMetadata.get(promise);
        if (metadata === undefined || metadata.state === 'detached') return false;
        metadata.state = 'detached';
        metadata.detachedAt = Date.now();
        metadata.detachReason = reason;
        defaultMetricsRegistry.increment('background_task_detached_total', {
            kind: metadata.kind,
            reason,
        });
        if (metadata.abort === undefined) {
            metadata.abortStatus = 'unsupported';
            defaultMetricsRegistry.increment('background_task_abort_total', { status: 'unsupported' });
            return true;
        }
        metadata.abortStatus = 'requested';
        void Promise.resolve()
            .then(() => metadata.abort?.())
            .then(() => {
                metadata.abortStatus = 'completed';
                defaultMetricsRegistry.increment('background_task_abort_total', { status: 'completed' });
            })
            .catch((error) => {
                metadata.abortStatus = 'failed';
                defaultMetricsRegistry.increment('background_task_abort_total', { status: 'failed' });
                log.warn('Background task abort failed after durable detachment', {
                    taskId: metadata.taskId,
                    token: metadata.token,
                    kind: metadata.kind,
                    error: error instanceof Error ? error.message : String(error),
                });
            });
        return true;
    }

    private detachBackgroundTasks(params: { taskId: string; reason: string }): number {
        let detached = 0;
        for (const promise of this.backgroundTaskPromises) {
            const metadata = this.backgroundTaskMetadata.get(promise);
            if (metadata === undefined || metadata.state === 'detached') continue;
            const ownedByBranch = metadata.taskId === params.taskId ||
                metadata.rootTaskId === params.taskId ||
                metadata.ancestorTaskIds?.includes(params.taskId) === true;
            if (!ownedByBranch) continue;
            if (this.detachBackgroundTask(promise, params.reason)) detached += 1;
        }
        return detached;
    }

    private async reconcileBackgroundTaskOwnership(rootTaskId?: string): Promise<number> {
        const candidates = this.backgroundTasksInScope(rootTaskId);
        let detached = 0;
        for (const promise of candidates) {
            const metadata = this.backgroundTaskMetadata.get(promise);
            if (
                metadata?.tenantId === undefined ||
                metadata.taskId === undefined ||
                metadata.state === 'detached'
            ) continue;
            try {
                await assertTaskEffectActive({
                    session: this.sessionManager!,
                    tenantId: metadata.tenantId,
                    taskId: metadata.taskId,
                    effectKind: metadata.kind,
                    token: metadata.token,
                    pendingKind: metadata.pendingKind,
                });
            } catch (error) {
                if (!isTaskLifecycleTerminalError(error)) throw error;
                if (error.details.reason === 'effect_token_not_pending') {
                    if (this.detachBackgroundTask(promise, error.details.reason)) detached += 1;
                } else {
                    this.rememberTerminalBranch(
                        metadata.tenantId,
                        metadata.taskId,
                        error.details.state,
                        error.details.reason
                    );
                    detached += this.detachBackgroundTasks({
                        taskId: metadata.taskId,
                        reason: error.details.reason ?? 'remote_lifecycle_terminal',
                    });
                }
                defaultMetricsRegistry.increment('background_task_remote_detach_total', {
                    kind: metadata.kind,
                });
            }
        }
        return detached;
    }

    async detachTaskBranch(params: {
        tenantId: string;
        taskId: string;
        reason: string;
        detachedAt?: string;
    }): Promise<{ detachedTools: number; detachedTasks: number }> {
        const detachedAt = params.detachedAt ?? new Date().toISOString();
        const visited = new Set<string>();
        let detachedTools = 0;
        let detachedTasks = 0;

        const detach = async (taskId: string): Promise<void> => {
            if (visited.has(taskId)) return;
            visited.add(taskId);
            this.rememberTerminalBranch(params.tenantId, taskId, 'detached', params.reason);
            this.detachBackgroundTasks({ taskId, reason: params.reason });
            const reconciled = await reconcileSnapshotMutation({
                session: this.sessionManager!,
                tenantId: params.tenantId,
                sessionId: taskId,
                operation: 'task.branch.detach',
                mutate: ({ snapshot, wmVersion }) => {
                    if (wmVersion === BigInt(0) && Object.keys(snapshot).length === 0) {
                        return {
                            kind: 'noop',
                            value: {
                                childTaskIds: [] as string[],
                                toolTerminals: [] as Array<PendingToolTerminal & { token: string }>,
                                timerTokens: [] as string[],
                                lifecycleDetached: false,
                            },
                        };
                    }
                    const lifecycle = readTaskLifecycle(snapshot, taskId);
                    const lifecycleSnapshot = markTaskLifecycle(snapshot, {
                        taskId,
                        state: 'detached',
                        changedAt: detachedAt,
                        reason: params.reason,
                        rootTaskId: lifecycle?.rootTaskId,
                        parentTaskId: lifecycle?.parentTaskId,
                        ancestorTaskIds: lifecycle?.ancestorTaskIds,
                    });
                    const tools = detachPendingToolsInSnapshot(lifecycleSnapshot, {
                        taskId,
                        reason: params.reason,
                        detachedAt,
                    });
                    const pending = (tools.snapshot as any).pending ?? {};
                    const activeChildTasks = {
                        ...((pending.tasks ?? {}) as Record<string, any>),
                    };
                    const childEntries = [
                        ...Object.values(activeChildTasks),
                        ...Object.values((pending.childTerminals ?? {}) as Record<string, any>),
                    ];
                    const childTaskIds = [...new Set(childEntries
                        .map((entry) => entry?.childTaskId)
                        .filter((value): value is string => typeof value === 'string' && value.length > 0))];
                    const timerTokens = [...new Set([
                        ...Object.keys(activeChildTasks),
                        ...Object.keys((pending.inputs ?? {}) as Record<string, unknown>),
                    ])];
                    const childTerminals = {
                        ...((pending.childTerminals ?? {}) as Record<string, unknown>),
                    } as Record<string, any>;
                    for (const [token, entry] of Object.entries(activeChildTasks)) {
                        childTerminals[token] ??= synthesizeOwnerDetachedChildTerminal(entry, {
                            detachedAt,
                            ownerTaskId: taskId,
                        });
                    }
                    let inputSnapshot = tools.snapshot;
                    for (const token of Object.keys(getPendingInputs(inputSnapshot))) {
                        inputSnapshot = tombstonePendingInput(inputSnapshot, token, 'cancelled', detachedAt);
                    }
                    const inputPending = (inputSnapshot as { pending?: Record<string, unknown> }).pending ?? pending;
                    const cleanedSnapshot = {
                        ...inputSnapshot,
                        pending: {
                            ...inputPending,
                            tasks: {},
                            inputs: {},
                            childTerminals,
                        },
                    } as Record<string, unknown>;
                    const changed = tools.detached.length > 0 ||
                        lifecycle?.state === 'active' ||
                        lifecycle === undefined ||
                        Object.keys(activeChildTasks).length > 0 ||
                        Object.keys((pending.inputs ?? {}) as Record<string, unknown>).length > 0;
                    return changed
                        ? {
                              kind: 'write',
                              snapshot: cleanedSnapshot,
                              value: {
                                  childTaskIds,
                                  toolTerminals: tools.detached,
                                  timerTokens,
                                  lifecycleDetached: lifecycle?.state === 'active' || lifecycle === undefined,
                              },
                          }
                        : {
                              kind: 'noop',
                              value: { childTaskIds, toolTerminals: tools.detached, timerTokens, lifecycleDetached: false },
                          };
                },
            });
            if (reconciled.status === 'committed') {
                detachedTasks += 1;
                if (reconciled.value.lifecycleDetached) {
                    try {
                        await this.sessionManager?.appendEvent(params.tenantId, taskId, 'task.detached', {
                            taskId,
                            reason: params.reason,
                            detachedAt,
                        });
                    } catch { /* diagnostic projection is repaired from the durable snapshot */ }
                }
            }
            detachedTools += reconciled.value.toolTerminals.length;
            for (const terminal of reconciled.value.toolTerminals) {
                defaultMetricsRegistry.increment('tool.terminal_winner_total', { kind: 'detached' });
                try {
                    await this.sessionManager?.appendEvent(params.tenantId, taskId, 'task.tool_detached', {
                        token: terminal.token,
                        toolName: terminal.toolName,
                        reason: params.reason,
                        detachedAt,
                    });
                } catch { /* diagnostic only */ }
            }
            await Promise.all(reconciled.value.timerTokens.map((token) =>
                this.runtimeDriver.cancelTimer?.({ tenantId: params.tenantId, taskId, token })
            ));
            await Promise.all(reconciled.value.childTaskIds.map(async (childTaskId) => {
                try {
                    await this.runtimeDriver.cancel({
                        tenantId: params.tenantId,
                        taskId: childTaskId,
                        idempotencyKey: `${childTaskId}:branch-detach:${params.reason}`,
                        reason: params.reason,
                    });
                } catch (error) {
                    log.warn('Child runtime cancellation failed after durable branch detachment', {
                        tenantId: params.tenantId,
                        taskId: childTaskId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }));
            await Promise.all(reconciled.value.childTaskIds.map((childTaskId) => detach(childTaskId)));
        };

        await detach(params.taskId);
        return { detachedTools, detachedTasks };
    }

    private rememberConversationActivationTarget(params: ConversationActivateParams): void {
        this.recentConversationActivationTargets.set(
            `${params.tenantId}:${params.routingSessionId}`,
            params
        );
    }

    private async reconcileCurrentConversationDeliveries(): Promise<number> {
        let scheduled = 0;
        const targets = Array.from(this.recentConversationActivationTargets.values());
        for (const params of targets) {
            if (await this.hasCurrentInboundConversationDelivery(params)) {
                scheduled += 1;
                this.trackBackgroundTask(this.ensureConversationActivation(params), {
                    kind: 'conversation.activation',
                    label: `conversation.activation ${params.kind}:${params.recipientAgentId}`,
                    tenantId: params.tenantId,
                    taskId: params.routingSessionId,
                    agentId: params.recipientAgentId,
                    token: params.kind === 'invite' ? params.token : undefined,
                    source: 'TaskEngine.reconcileCurrentConversationDeliveries',
                });
            }
        }
        return scheduled;
    }

    private async hasCurrentInboundConversationDelivery(
        params: ConversationActivateParams | undefined
    ): Promise<boolean> {
        if (!params || !this.sessionManager) {
            return false;
        }
        const loaded = await this.sessionManager.load(params.tenantId, params.routingSessionId);
        const snapshot = (loaded?.snapshot as Record<string, unknown> | undefined) ?? {};
        const inbox = normalizeObservationInbox((snapshot as { inbox?: unknown }).inbox);
        return inbox.current.some((obs) => {
            if (obs.source !== 'conversation') {
                return false;
            }
            const kind = (obs as { payload?: { kind?: string } }).payload?.kind;
            return kind === 'message.received' || kind === 'topic.message.received';
        });
    }

    private async runConversationActivationBody(
        params: ConversationActivateParams
    ): Promise<ConversationActivateResult> {
        const plugin = await globalA2AService.findLocalAgent(params.recipientAgentId);
        if (!plugin) {
            const msg = `No local agent registered for id '${params.recipientAgentId}'.`;
            if (params.kind === 'thread') {
                await this.routeConversationDeliveryFailed({
                    ...params,
                    error: { type: 'PluginMissing', message: msg },
                });
            }
            return { ok: false, error: { type: 'PluginMissing', message: msg } };
        }

        let ctx: TaskContext;
        try {
            ctx = await globalA2AService.buildPassiveConversationContext({
                plugin,
                tenantId: params.tenantId,
                sessionId: params.routingSessionId,
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (params.kind === 'thread') {
                await this.routeConversationDeliveryFailed({
                    ...params,
                    error: { type: 'ActivationFailed', message: msg },
                });
            }
            return { ok: false, error: { type: 'ActivationFailed', message: msg } };
        }

        const snap = await this.sessionManager!.load(params.tenantId, params.routingSessionId);
        const base = (snap?.snapshot as Record<string, unknown>) || {};
        const prisma = this.getSessionStorePrisma() || (this.sessionManager as unknown as Record<string, unknown>)?.prisma;
        let M: MentalState = (base.M as MentalState) || initialM(ctx);
        M =
            (ArtifactHydrationService.hydrateMentalStateArtifacts(
                M,
                prisma,
                params.tenantId,
                'conversationActivation'
            ) as MentalState) || M;

        try {
            await this.runPreparedTurnThroughDriver({
                operation: 'resume',
                tenantId: params.tenantId,
                taskId: params.routingSessionId,
                agentId: params.recipientAgentId,
                idempotencyKey: `${params.routingSessionId}:conversation:${params.kind}`,
                resumeEvent: {
                    kind: 'conversation',
                    token: params.routingSessionId,
                    messageId: params.routingSessionId,
                    data: { kind: params.kind === 'invite' ? 'invite.received' : 'message.received' },
                },
                ctx,
                turnParams: {
                    tenantId: params.tenantId,
                    sessionId: params.routingSessionId,
                    trigger: params.kind === 'invite' ? 'event' : 'conversation',
                    isStreaming: false,
                    throwOnSaveFailure: true,
                },
                initialM: M,
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            log.error('conversation activation runTurn failed', { error: msg, ...params });
            if (params.kind === 'thread') {
                await this.routeConversationDeliveryFailed({
                    ...params,
                    error: { type: 'RunTurnFailed', message: msg },
                });
            }
            return { ok: false, error: { type: 'RunTurnFailed', message: msg } };
        }

        return { ok: true };
    }

    private async routeConversationDeliveryFailed(params: {
        tenantId: string;
        threadId: string;
        messageId: string;
        senderSessionId: string;
        senderAgentId: string;
        recipientAgentId: string;
        error:
            | { type: 'PluginMissing'; message: string }
            | { type: 'ActivationFailed'; message: string }
            | { type: 'RunTurnFailed'; message: string };
    }): Promise<void> {
        if (!this.sessionManager) return;
        const thread = { kind: 'thread' as const, id: params.threadId };
        const observation = {
            source: 'conversation',
            payload: {
                kind: 'delivery.failed',
                thread,
                error: params.error,
                messageId: params.messageId,
                recipientAgentId: params.recipientAgentId,
            },
        } as import('../types/observation.js').Observation;
        const router = new ConversationRouter(this.sessionManager);
        await router.routeObservation({
            tenantId: params.tenantId,
            sessionId: `${params.threadId}:${params.senderAgentId}`,
            agentId: params.senderAgentId,
            observation,
        });
    }

    private getSessionStorePrisma() {
        return (this.sessionManager as any)?.store?.prisma;
    }

    getOperatorPrismaClient(): unknown {
        return this.getSessionStorePrisma();
    }

    async appendOperatorEvent(params: {
        tenantId: string;
        sessionId: string;
        type: string;
        payload: Record<string, unknown>;
    }): Promise<{ eventId: string; seq: number } | undefined> {
        if (!this.sessionManager) {
            return undefined;
        }
        let payload = params.payload;
        const prisma = this.getSessionStorePrisma();
        if (prisma) {
            try {
                payload = cloneJsonLike(params.payload);
                await offloadArtifacts(payload, new AgentResultCache(prisma), params.tenantId);
            } catch (error) {
                log.warn('Failed to offload operator event artifacts', {
                    type: params.type,
                    taskId: params.sessionId,
                    error: error instanceof Error ? error.message : String(error),
                });
                payload = makeSafeEventPreview(params.payload) as Record<string, unknown>;
            }
        }
        return this.sessionManager.appendEvent(
            params.tenantId,
            params.sessionId,
            params.type,
            payload
        );
    }

    async buildAgentRunGraph(params: {
        tenantId: string;
        taskId: string;
    }): Promise<AgentRunGraph> {
        if (!this.sessionManager) {
            throw new Error('Session manager is not configured');
        }
        const projectionMode = readProjectionMode();
        const projectionWriteMode = readProjectionWriteMode();
        const prisma = this.getSessionStorePrisma() as
            | {
                  driverRun?: {
                      findMany: (args: {
                          where: {
                              tenantId: string;
                              taskId: { in: string[] };
                          };
                          orderBy: { createdAt: 'asc' };
                      }) => Promise<DriverRunView[]>;
                  };
              }
            | undefined;
        const projection = prisma ? new OperatorProjectionRepository(prisma as never) : undefined;
        if (projectionMode === 'semantic') {
            const current = await this.sessionManager.load(params.tenantId, params.taskId);
            await projection?.reconcileDurableTerminal({
                tenantId: params.tenantId,
                taskId: params.taskId,
                snapshot: current?.snapshot,
                agentId: current?.agentId,
            });
            const semanticGraph = await projection?.buildGraph(params);
            if (semanticGraph !== undefined && semanticGraph.projection?.partial !== true) {
                const coordination = buildTaskCoordinationView(params.taskId, current?.snapshot);
                const terminalClaim = readDurableTaskTerminal(current?.snapshot)?.turnClaim;
                if (terminalClaim && !semanticGraph.turns.some((turn) =>
                    turn.claimId === terminalClaim.claimId && turn.turnFence === terminalClaim.fence
                )) {
                    coordination.issues = [...coordination.issues, 'terminal_projection_mismatch'];
                    coordination.health = 'attention';
                }
                return withGraphCaps({
                    ...semanticGraph,
                    coordination,
                }, 'semantic');
            }
        }
        const { events: sessionEvents, taskIds } = await this.collectRunGraphEvents({
            tenantId: params.tenantId,
            rootTaskId: params.taskId,
        });
        const driverRuns = prisma?.driverRun
            ? await prisma.driverRun.findMany({
                  where: {
                      tenantId: params.tenantId,
                      taskId: { in: taskIds },
                  },
                  orderBy: { createdAt: 'asc' },
              })
            : [];

        const graph = await buildAgentRunGraph({
            tenantId: params.tenantId,
            taskId: params.taskId,
            sessionManager: this.sessionManager,
            driverRuns,
            events: sessionEvents,
        });
        if (projectionWriteMode !== 'off') {
            const writeProjection = projection?.projectGraph(graph).catch((error) => {
                log.warn('Operator semantic graph projection failed', {
                    tenantId: params.tenantId,
                    taskId: params.taskId,
                    message: error instanceof Error ? error.message : String(error),
                });
            });
            if (projectionMode === 'compare' || projectionWriteMode === 'on') {
                await writeProjection;
            } else {
                void writeProjection;
            }
        }
        if (projectionMode === 'compare') {
            void projection?.buildGraph(params).then((semanticGraph) => {
                if (semanticGraph !== undefined) {
                    const mismatch = compareGraphShape(graph, semanticGraph);
                    if (mismatch !== undefined) {
                        log.warn('Operator bridge/semantic graph mismatch', {
                            tenantId: params.tenantId,
                            taskId: params.taskId,
                            mismatch,
                        });
                    }
                }
            }).catch((error) => {
                log.warn('Operator semantic graph compare failed', {
                    tenantId: params.tenantId,
                    taskId: params.taskId,
                    message: error instanceof Error ? error.message : String(error),
                });
            });
        }
        return withGraphCaps(graph, 'bridge');
    }

    private async collectRunGraphEvents(params: {
        tenantId: string;
        rootTaskId: string;
    }): Promise<{ events: AgentRunSourceEvent[]; taskIds: string[] }> {
        const sessionManager = this.sessionManager;
        if (!sessionManager) {
            throw new Error('Session manager is not configured');
        }
        const queue = [params.rootTaskId];
        const seen = new Set<string>();
        const events: AgentRunSourceEvent[] = [];

        while (queue.length > 0) {
            const taskId = queue.shift()!;
            if (seen.has(taskId)) continue;
            seen.add(taskId);

            const taskEvents = await sessionManager.listEventsSince({
                tenantId: params.tenantId,
                sessionId: taskId,
                sinceSeq: -1,
            });
            for (const event of taskEvents) {
                const eventWithSession = { ...event, sessionId: taskId };
                events.push(eventWithSession);
                const childTaskId = event.payload.childTaskId;
                if (typeof childTaskId === 'string' && childTaskId.length > 0 && !seen.has(childTaskId)) {
                    queue.push(childTaskId);
                }
            }
        }

        return { events, taskIds: [...seen] };
    }

    async listAgentRuns(params: AgentRunListParams): Promise<AgentRunListPage> {
        const prisma = this.getSessionStorePrisma() as OperatorPrismaClient | undefined;
        const projectionMode = readProjectionMode();
        const projectionWriteMode = readProjectionWriteMode();
        const limit = clampAgentRunLimit(params.limit);
        const projection = prisma ? new OperatorProjectionRepository(prisma as never) : undefined;
        if (projectionMode === 'semantic' || params.scheduleId !== undefined) {
            const semanticPage = await projection?.listAgentRuns({
                tenantId: params.tenantId,
                agentId: params.agentId,
                status: params.status,
                since: params.since,
                cursor: params.cursor,
                limit,
                scope: params.scope ?? 'roots',
                taskId: params.taskId,
                hasLlm: params.hasLlm,
                hasMemory: params.hasMemory,
                costState: params.costState,
                scheduleId: params.scheduleId,
            });
            if (semanticPage !== undefined) {
                return semanticPage;
            }
        }
        if (!prisma?.driverRun) {
            return { items: [] };
        }
        const cursor = decodeAgentRunCursor(params.cursor);
        const baseWhere = buildBridgeAgentRunWhere(params);
        const where = withBridgeCursor(baseWhere, cursor);

        const scope = params.scope ?? 'roots';
        const rows = await prisma.driverRun.findMany({
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: scope === 'roots' ? Math.min((limit + 1) * 5, 500) : limit + 1,
        });
        const candidateTaskIds = [
            ...new Set(rows.map((row) => row.taskId).filter((taskId): taskId is string => typeof taskId === 'string' && taskId.length > 0)),
        ];
        const childLinkEvents = prisma.wMEvent
            ? await prisma.wMEvent.findMany({
                  where: {
                      tenantId: params.tenantId,
                      ...(candidateTaskIds.length > 0 ? { sessionId: { in: candidateTaskIds } } : {}),
                      type: { in: ['task.child_started', 'task.child_completed', 'task.child_failed'] },
                  },
                  orderBy: [{ createdAt: 'desc' }],
                  take: Math.max(5000, candidateTaskIds.length * 20),
              })
            : [];
        const childTaskIds = new Set(
            childLinkEvents
                .map((event) => childTaskIdFromEvent(event))
                .filter((taskId): taskId is string => typeof taskId === 'string' && taskId.length > 0)
        );
        const bridgeSummary = await summarizeBridgeAgentRuns(prisma, params, baseWhere, childTaskIds);
        const filteredRows = rows.filter((row) => scope === 'all' || isRootDriverRun(row, childTaskIds));
        const pageRows = filteredRows.slice(0, limit);
        const rootTaskIds = [
            ...new Set(
                pageRows
                    .map((row) => taskIdForRun(row))
                    .filter((taskId): taskId is string => taskId !== undefined)
            ),
        ];
        const relatedRuns = rootTaskIds.length > 0
            ? await prisma.driverRun.findMany({
                  where: {
                      tenantId: params.tenantId,
                      OR: [
                          { rootTaskId: { in: rootTaskIds } },
                          { taskId: { in: rootTaskIds } },
                      ],
                  },
                  orderBy: [{ createdAt: 'asc' }],
              })
            : [];
        const turnEvents = prisma.wMEvent && rootTaskIds.length > 0
            ? await prisma.wMEvent.findMany({
                  where: {
                      tenantId: params.tenantId,
                      sessionId: { in: rootTaskIds },
                      type: { in: ['task.failed', 'task.completed', 'task.canceled', 'task.started', 'task.child_started', 'task.child_completed', 'task.child_failed', 'turn.completed'] },
                  },
                  orderBy: [{ createdAt: 'asc' }],
              })
            : [];

        const runsByRoot = new Map<string, DriverRunListRow[]>();
        for (const run of relatedRuns) {
            const rootTaskId = taskIdForRun(run);
            if (rootTaskId === undefined) {
                continue;
            }
            const current = runsByRoot.get(rootTaskId) ?? [];
            current.push(run);
            runsByRoot.set(rootTaskId, current);
        }
        const turnEventsByRoot = new Map<string, WMEventRow[]>();
        for (const event of turnEvents) {
            const current = turnEventsByRoot.get(event.sessionId) ?? [];
            current.push(event);
            turnEventsByRoot.set(event.sessionId, current);
        }

        const items = pageRows
            .map((row): AgentRunListItem | undefined => {
                const rootTaskId = taskIdForRun(row);
                if (rootTaskId === undefined) {
                    return undefined;
                }
                const runs = runsByRoot.get(rootTaskId) ?? [];
                const taskTurnEvents = turnEventsByRoot.get(rootTaskId) ?? [];
                const completed = taskTurnEvents
                    .map((event) => event.payload)
                    .filter(isRecordValue);
                const llmCalls = completed.reduce((count, payload) => {
                    const calls = payload.llmCalls;
                    return count + (Array.isArray(calls) ? calls.length : 0);
                }, 0);
                const costUsd = completed.reduce((sum, payload) => {
                    const usage = payload.usage;
                    if (!isRecordValue(usage)) {
                        return sum;
                    }
                    return sum + (numberFromPayload(usage, 'totalCost') ?? 0);
                }, 0);
                const turns = runs.filter((run) => run.operation === 'turn.segment' || run.operation === 'segment').length ||
                    taskTurnEvents.filter((event) => event.type === 'turn.completed').length;
                const children = new Set([
                    ...runs
                        .filter((run) => run.parentTaskId !== null && run.parentTaskId !== undefined && run.parentTaskId.length > 0)
                        .map((run) => run.taskId)
                        .filter((taskId): taskId is string => typeof taskId === 'string' && taskId.length > 0 && taskId !== rootTaskId),
                    ...taskTurnEvents
                        .filter((event) => event.type.startsWith('task.child_'))
                        .map((event) => isRecordValue(event.payload) ? event.payload.childTaskId : undefined)
                        .filter((taskId): taskId is string => typeof taskId === 'string' && taskId.length > 0),
                ]).size;
                const startedAt = row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt;
                const updatedAt = row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt;
                const startedMs = new Date(startedAt).getTime();
                const updatedMs = new Date(updatedAt).getTime();
                const status = deriveListRunStatus(row, runs, taskTurnEvents);
                const isTerminal =
                    status === 'completed' ||
                    status === 'failed' ||
                    status === 'succeeded' ||
                    status === 'canceled' ||
                    status === 'cancelled';
                return {
                    ...(row.agentId ? { agentId: row.agentId } : {}),
                    taskId: row.taskId ?? rootTaskId,
                    rootTaskId,
                    status,
                    startedAt,
                    ...(isTerminal ? { finishedAt: updatedAt } : {}),
                    ...(isTerminal && Number.isFinite(startedMs) && Number.isFinite(updatedMs)
                        ? { durationMs: Math.max(0, updatedMs - startedMs) }
                        : {}),
                    turns,
                    children,
                    llmCalls,
                    costUsd,
                    ...(row.traceId ? { traceId: row.traceId } : {}),
                    ...(row.providerRunId ? { providerRunId: row.providerRunId } : {}),
                };
            })
            .filter((item): item is AgentRunListItem => item !== undefined)
            .filter((item) => params.status === undefined || params.status.length === 0 || item.status === params.status)
            .filter((item) => !params.hasLlm || item.llmCalls > 0)
            .filter((item) => !params.hasMemory || (item.memoryOps ?? 0) > 0)
            .filter((item) => params.costState !== 'captured' || typeof item.costUsd === 'number')
            .filter((item) => params.costState !== 'missing' || typeof item.costUsd !== 'number');

        const overflow = filteredRows.length > limit ? filteredRows[limit] : undefined;
        const nextCursor = overflow
            ? encodeAgentRunCursor({
                  createdAt: overflow.createdAt instanceof Date ? overflow.createdAt.toISOString() : overflow.createdAt,
                  id: overflow.id,
              })
            : undefined;
        const page: AgentRunListPage = {
            items,
            ...(nextCursor ? { nextCursor } : {}),
            summary: bridgeSummary,
            pageInfo: {
                ...(nextCursor ? { nextCursor } : {}),
                hasMore: nextCursor !== undefined,
                limit,
            },
            projection: { source: 'bridge', partial: false },
        };
        if (projectionWriteMode !== 'off') {
            const writeProjection = projection?.projectListPage(params.tenantId, page.items).catch((error) => {
                log.warn('Operator semantic list projection failed', {
                    tenantId: params.tenantId,
                    message: error instanceof Error ? error.message : String(error),
                });
            });
            if (projectionMode === 'compare' || projectionWriteMode === 'on') {
                await writeProjection;
            } else {
                void writeProjection;
            }
        }
        if (projectionMode === 'compare') {
            void projection?.listAgentRuns({
                tenantId: params.tenantId,
                agentId: params.agentId,
                status: params.status,
                since: params.since,
                cursor: params.cursor,
                limit,
                scope: params.scope ?? 'roots',
                scheduleId: params.scheduleId,
            }).then((semanticPage) => {
                const mismatch = compareListShape(page, semanticPage);
                if (mismatch !== undefined) {
                    log.warn('Operator bridge/semantic list mismatch', {
                        tenantId: params.tenantId,
                        mismatch,
                    });
                }
            }).catch((error) => {
                log.warn('Operator semantic list compare failed', {
                    tenantId: params.tenantId,
                    message: error instanceof Error ? error.message : String(error),
                });
            });
        }
        return page;
    }

    async getAgentRunTurn(params: {
        tenantId: string;
        taskId: string;
        turnSeq: number;
    }) {
        const graph = await this.buildAgentRunGraph({
            tenantId: params.tenantId,
            taskId: params.taskId,
        });
        return graph.turns.find((turn) => turn.turnSeq === params.turnSeq) ?? null;
    }

    async getAgentRunMemory(params: {
        tenantId: string;
        taskId: string;
    }) {
        const [graph, snapshot] = await Promise.all([
            this.buildAgentRunGraph({ tenantId: params.tenantId, taskId: params.taskId }),
            this.sessionManager?.load(params.tenantId, params.taskId) ?? Promise.resolve(null),
        ]);
        const state = snapshot?.snapshot;
        const memory = isRecordValue(state)
            ? isRecordValue(state.M)
                ? state.M.memory
                : state.memory
            : undefined;
        return {
            taskId: params.taskId,
            tenantId: params.tenantId,
            agentId: snapshot?.agentId,
            memory,
            operations: graph.memoryOps,
        };
    }

    // Persist a child's minimal context so durable handlers can restore it later
    public async persistChildContext(params: { tenantId: string; sessionId: string; agentId: string }): Promise<void> {
        if (!this.sessionManager) return;
        const { tenantId, sessionId, agentId } = params;
        const snap = await this.sessionManager.load(tenantId, sessionId);
        const base = (snap?.snapshot as Record<string, unknown>) || {};
        const M = ((base as Record<string, unknown>).M || {}) as MentalState;
        const nextM = { ...M };
        const snapshot = { ...base, M: nextM } as Record<string, unknown>;
        try {
            await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId, expectedWmVersion: BigInt(0), snapshot });
        } catch {
            // best-effort; a later write will win
        }
    }


    // Attach WM and orchestration APIs for child session (flush, requestInput, sendTaskToAgent, etc.)
    public async attachWorkingMemory(ctx: TaskContext, tenantId: string, sessionId: string, agentId: string, loadedMentalState?: MentalState): Promise<void> {
        if (!this.sessionManager) return;

        let M = loadedMentalState;
        if (!M) {
            const snapshot = await this.sessionManager.load(tenantId, sessionId);
            M = (snapshot?.snapshot as Record<string, unknown>)?.M as MentalState | undefined;
            M = (ArtifactHydrationService.hydrateMentalStateArtifacts(
                M as MentalState,
                this.getSessionStorePrisma() || (this.sessionManager as unknown as Record<string, unknown>)?.prisma,
                tenantId,
                'attachWorkingMemory'
            ) as MentalState) || M;
        }

        if (!(ctx as Record<string, unknown>).__ctxId) (ctx as Record<string, unknown>).__ctxId = `ctx-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        if (!(ctx as Record<string, unknown>).tenantId) (ctx as Record<string, unknown>).tenantId = tenantId;
        if (!(ctx as Record<string, unknown>).agentId) (ctx as Record<string, unknown>).agentId = agentId;
        if (M && !(ctx as Record<string, unknown>).__mental) {
            (ctx as Record<string, unknown>).__mental = M;
        }

        await this.apiBinder.attachOrchestrationAPIs(ctx, {
            tenantId,
            sessionId,
            agentId,
            flushMentalState: async () => {
                await this.flushContextSnapshot(tenantId, sessionId, agentId, ctx);
            }
        });
        try {
            bindRuntimeCognitionStream({
                ctx,
                eventBus: this.eventBus,
                tenantId,
                sessionId,
                agentId,
            });
        } catch { /* noop */ }
    }

    // Flush current MentalState and LLM state into snapshot (no vars; worldModel/scratch are persisted via M)
    public async flushContextSnapshot(tenantId: string, sessionId: string, agentId: string, ctx: TaskContext): Promise<void> {
        // Use scheduler to debounce/coalesce flushes
        const flushKey = `${tenantId}:${sessionId}`;
        return this.flushScheduler.coalesce(flushKey, async () => {
            await this._doFlushContextSnapshot(tenantId, sessionId, agentId, ctx);
        }, ctx, agentId);
    }

    private async _doFlushContextSnapshot(tenantId: string, sessionId: string, agentId: string, ctx: TaskContext): Promise<void> {
        if (!this.sessionManager) return;
        const baseSnap = ((await this.sessionManager.load(tenantId, sessionId))?.snapshot as Record<string, unknown>) || {};
        let M: MentalState | undefined = (baseSnap as Record<string, unknown>).M as MentalState | undefined;
        const mentalFromCtx = (() => { try { return (ctx as Record<string, unknown>).__mental as MentalState | undefined; } catch { return undefined; } })();
        if (!M && mentalFromCtx) M = mentalFromCtx;
        if (!M) {
            try { const { initialM } = await import('../loop/init.js'); M = initialM(ctx); } catch {
                M = { memory: { sensory: {}, longTerm: { episodic: [], semantic: { concepts: [] }, procedural: { skills: [] } } }, worldModel: {}, goalState: { hierarchy: { nodes: {}, roots: [] } }, emotion: { valence: 0, arousal: 0 }, rewardParams: { extrinsicWeights: [], intrinsic: { curiosity: 0, novelty: 0, competence: 0, exploration: 0 }, discountGamma: 1 }, policyParams: { theta: undefined, stochastic: false } } as MentalState;
            }
        }
        if (!M) return;
        // Attach LLM state
        let attachedLlmState: unknown = undefined;
        try {
            const llmAny = (ctx as any).llm as any;
            const historyMode = (typeof llmAny?.getHistoryMode === 'function') ? llmAny.getHistoryMode() : 'full';

            if (historyMode !== 'stateless') {
                if (llmAny?.getMessages) {
                    const messages = llmAny.getMessages(true);
                    attachedLlmState = { messages } as unknown;
                } else if (llmAny?.exportState) {
                    attachedLlmState = llmAny.exportState();
                }
            } else {
                log.debug('[TaskEngine] Skipping LLM history save (stateless mode)');
            }
        } catch { /* ignore */ }
        const prisma = this.getSessionStorePrisma() || (this.sessionManager as any).prisma;
        const preparedM = structuredClone(M) as MentalState;
        if (prisma) {
            await offloadArtifacts({ M: preparedM }, new AgentResultCache(prisma), tenantId);
        }
        const turnClaim = currentTaskTurnClaim();
        await reconcileSnapshotMutation({
            session: this.sessionManager,
            tenantId,
            sessionId,
            agentId: (ctx as any).agentId || agentId,
            operation: 'turn.flush_context',
            mutate: ({ snapshot, storageNow }) => {
                if (turnClaim !== undefined) {
                    assertCurrentTaskTurn(snapshot, {
                        tenantId,
                        taskId: sessionId,
                        claim: turnClaim,
                        operation: 'turn.flush_context',
                        storageNow,
                    });
                }
                return {
                    kind: 'write',
                    snapshot: {
                        ...snapshot,
                        M: preparedM,
                        ...(attachedLlmState ? { llmState: attachedLlmState } : {}),
                        meta: mergeSnapshotMetaWithCtxTelemetry(snapshot, ctx),
                    },
                    value: undefined,
                };
            },
        });
    }

    /** Compact output for root agent traces (avoid huge payloads). */
    private buildAgentTelemetryOutput(task: TaskEntity): Record<string, unknown> {
        const status = task.status;
        const state = status?.state;
        const terminalStates = new Set(['completed', 'failed', 'canceled', 'input-required']);
        return {
            state,
            timestamp: status?.timestamp,
            artifactsCount: Array.isArray(task.artifacts) ? task.artifacts.length : 0,
            taskId: task.id,
            terminal: typeof state === 'string' && terminalStates.has(state),
            outcome:
                state === 'completed'
                    ? 'success'
                    : state === 'failed'
                      ? 'failure'
                      : state === 'input-required'
                        ? 'await_input'
                        : state ?? 'unknown',
        };
    }

    private taskFailureMessage(task: TaskEntity): string {
        const st = task.status;
        if (!st || st.state !== 'failed') return 'Task failed';
        const msg = (st as { message?: { parts?: Array<{ type?: string; text?: string }> } }).message;
        if (msg?.parts && Array.isArray(msg.parts)) {
            const text = msg.parts
                .filter((p) => p.type === 'text' && typeof p.text === 'string')
                .map((p) => p.text!)
                .join(' ');
            return text || 'Task failed';
        }
        return 'Task failed';
    }

    /**
     * Close the execution AgentNode for telemetry providers.
     * Applies to TaskEngine-created nodes and reused nodes from A2AService (loop subagents).
     */
    private finalizeAgentNodeTelemetry(
        agentNode: AgentNode | undefined,
        task: TaskEntity,
        thrown?: Error
    ): void {
        if (!agentNode || agentNode.endTime != null) return;
        try {
            const state = task.status?.state;
            const output = this.buildAgentTelemetryOutput(task);

            if (state === 'failed' || thrown) {
                const err = thrown ?? new Error(this.taskFailureMessage(task));
                agentNode.fail(err);
                telemetry.failNode(agentNode, err);
                telemetry.endNode(agentNode);
                return;
            }

            const nodeStatus: NodeStatus = 'success';
            agentNode.end(output, nodeStatus);
            telemetry.endNode(agentNode);
        } catch {
            /* ignore telemetry errors */
        }
    }

    async cancelTask(params: CancelTaskParams): Promise<{ acknowledged: true }> {
        const reason = params.reason ?? 'canceled';
        const loaded = await this.sessionManager!.load(params.tenantId, params.taskId);
        if (loaded !== null) {
            const snapshot = (loaded.snapshot as Record<string, unknown> | undefined) ?? {};
            if (
                readSegmentCancellation(snapshot) !== undefined ||
                isTaskLifecycleTerminal(readTaskLifecycle(snapshot, params.taskId)) ||
                await this.hasTerminalTaskEvent(params.tenantId, params.taskId)
            ) {
                return { acknowledged: true };
            }
            const pending = { ...((snapshot as any).pending ?? {}) };
            const manifestConsents = { ...(pending.manifestConsents ?? {}) };
            const cancelledAt = new Date().toISOString();
            for (const [token, receipt] of Object.entries(manifestConsents) as Array<[string, any]>) {
                if (receipt.status === 'pending' || receipt.status === 'approved' || receipt.status === 'dispatching') {
                    manifestConsents[token] = { ...receipt, status: 'cancelled', decidedAt: cancelledAt };
                }
            }
            const cancellationClaim = await reconcileSnapshotMutation<{
                disposition: TaskTerminalDisposition;
                detached: Array<{ token: string; toolName?: string }>;
            }>({
                session: this.sessionManager!,
                tenantId: params.tenantId,
                sessionId: params.taskId,
                agentId: params.agentId ?? loaded.agentId,
                operation: 'task.cancel.claim',
                mutate: ({ snapshot: current }) => {
                    const currentLifecycle = readTaskLifecycle(current, params.taskId);
                    if (isTaskLifecycleTerminal(currentLifecycle)) {
                        return {
                            kind: 'noop' as const,
                            value: {
                                disposition: currentLifecycle?.state === 'canceled'
                                    ? 'matching_replay' as const
                                    : 'competing_terminal' as const,
                                detached: [] as Array<{ token: string; toolName?: string }>,
                            },
                        };
                    }
                    const currentPending = { ...((current as any).pending ?? {}) };
                    const currentConsents = { ...(currentPending.manifestConsents ?? {}), ...manifestConsents };
                    const canceled = markSegmentCancellationRequested({
                        ...current,
                        pending: { ...currentPending, manifestConsents: currentConsents },
                    }, reason);
                    const terminalClaim = claimTaskTerminalInSnapshot(canceled, {
                        taskId: params.taskId,
                        state: 'canceled',
                        claimedAt: cancelledAt,
                        reason,
                        status: {
                            state: 'canceled',
                            timestamp: cancelledAt,
                            metadata: { reason, ...(params.metadata ?? {}) },
                        },
                    });
                    const tools = detachPendingToolsInSnapshot(terminalClaim.snapshot, {
                        taskId: params.taskId,
                        reason: 'task_canceled',
                        detachedAt: cancelledAt,
                    });
                    return {
                        kind: 'write',
                        snapshot: tools.snapshot,
                        value: {
                            disposition: terminalClaim.disposition,
                            detached: tools.detached,
                        },
                    };
                },
            });
            if (cancellationClaim.value.disposition === 'competing_terminal') {
                return { acknowledged: true };
            }
            this.detachBackgroundTasks({ taskId: params.taskId, reason: 'task_canceled' });
            for (const terminal of cancellationClaim.value.detached) {
                try {
                    await this.sessionManager!.appendEvent(params.tenantId, params.taskId, 'task.tool_detached', {
                        token: terminal.token,
                        toolName: terminal.toolName,
                        reason: 'task_canceled',
                        detachedAt: cancelledAt,
                    });
                } catch { /* diagnostic only */ }
            }
            await this.detachTaskBranch({
                tenantId: params.tenantId,
                taskId: params.taskId,
                reason: 'task_canceled',
                detachedAt: cancelledAt,
            });
            if (cancellationClaim.value.disposition === 'committed') {
                const terminal = readDurableTaskTerminal(cancellationClaim.snapshot);
                await this.sessionManager!.appendEvent(params.tenantId, params.taskId, 'task.canceled', {
                    taskId: params.taskId,
                    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
                    reason,
                    ...(params.metadata ?? {}),
                    requestedAt: cancelledAt,
                });
                if (terminal !== undefined) {
                    await this.ensureTaskTerminalPublished({
                        tenantId: params.tenantId,
                        taskId: params.taskId,
                        agentId: params.agentId,
                        snapshot: cancellationClaim.snapshot,
                    });
                }
                await this.notifyA2AParentOfCancellation({
                    tenantId: params.tenantId,
                    taskId: params.taskId,
                    snapshot: cancellationClaim.snapshot,
                    reason,
                });
            }
        }

        try {
            await this.runtimeDriver.cancel({
                tenantId: params.tenantId,
                taskId: params.taskId,
                ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
                idempotencyKey: `${params.taskId}:cancel`,
                reason,
            });
        } catch (error) {
            log.warn('Runtime provider cancellation failed after durable cancellation marker was saved', {
                tenantId: params.tenantId,
                taskId: params.taskId,
                error: error instanceof Error ? error.message : String(error),
            });
        }

        return { acknowledged: true };
    }

    private async notifyA2AParentOfCancellation(params: {
        tenantId: string;
        taskId: string;
        snapshot: Record<string, unknown>;
        reason: string;
    }): Promise<void> {
        const meta = isRecordValue(params.snapshot.meta) ? params.snapshot.meta : undefined;
        const parent = isRecordValue(meta?.a2aParent) ? meta.a2aParent : undefined;
        const parentTenantId =
            typeof parent?.parentTenantId === 'string' ? parent.parentTenantId : undefined;
        const parentTaskId =
            typeof parent?.parentTaskId === 'string' ? parent.parentTaskId : undefined;
        const parentChildToken =
            typeof parent?.parentChildToken === 'string' ? parent.parentChildToken : undefined;

        if (!parentTenantId || !parentTaskId || !parentChildToken) {
            return;
        }

        await this.handleChildFailed({
            tenantId: parentTenantId,
            parentTaskId,
            childToken: parentChildToken,
            childTaskId: params.taskId,
            error: {
                code: 'CHILD_CANCELED',
                message: `Child task canceled: ${params.reason}`,
            },
        });
    }

    private async hasTerminalTaskEvent(tenantId: string, taskId: string): Promise<boolean> {
        const events = await this.sessionManager!.listEventsSince({
            tenantId,
            sessionId: taskId,
            sinceSeq: -1,
        });
        return events.some((event) =>
            event.type === 'task.completed' ||
            event.type === 'task.failed' ||
            event.type === 'task.canceled'
        );
    }

    /**
     * Durably admit a root loop task without running or awaiting its first
     * segment in this call chain. Provider publication is only a recoverable,
     * best-effort nudge after the authoritative snapshot CAS.
     */
    async submitTask(params: SubmitTaskParams): Promise<SubmitTaskResult> {
        try {
            return await this.submitTaskValidated(params);
        } catch (error) {
            defaultMetricsRegistry.increment('task_submission_total', {
                status: 'rejected',
                errorCode: error instanceof TaskSubmissionError
                    ? error.code
                    : error instanceof Error ? error.name : 'Error',
                runtimeSurface: this.runtimeDriver.surface ?? 'unknown',
            });
            throw error;
        }
    }

    private async submitTaskValidated(params: SubmitTaskParams): Promise<SubmitTaskResult> {
        try {
            validateTenantId(params.tenantId);
        } catch (error) {
            throw new TaskSubmissionError(
                'TASK_SUBMISSION_IDENTITY_INVALID',
                error instanceof Error ? error.message : 'tenantId is invalid'
            );
        }
        for (const [field, value] of [
            ['taskId', params.taskId],
            ['agentId', params.agentId],
        ] as const) {
            if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
                throw new TaskSubmissionError(
                    'TASK_SUBMISSION_IDENTITY_INVALID',
                    `${field} must be a non-empty string without surrounding whitespace`
                );
            }
        }

        if (!this.sessionManager?.supportsDurableTaskAdmission()) {
            throw new TaskSubmissionError(
                'TASK_ADMISSION_UNAVAILABLE',
                'the configured working-memory store cannot durably recover runnable task turns'
            );
        }
        const durableInput = canonicalizeTaskSubmissionInput(params.input);
        const maxTurns = normalizeTaskSubmissionMaxTurns(params.options?.maxTurns);
        const taskRunTimeoutMs = normalizeTaskSubmissionRunTimeout(
            params.options?.taskRunTimeoutMs
        );
        const origin = normalizeTaskSubmissionOrigin(params.origin);
        const requestDigest = taskSubmissionRequestDigest({
            agentId: params.agentId,
            canonicalInput: durableInput.canonical,
            ...(maxTurns !== undefined ? { maxTurns } : {}),
            ...(taskRunTimeoutMs !== undefined ? { taskRunTimeoutMs } : {}),
            ...(origin ? { origin } : {}),
        });

        // Stored identity is authoritative. Exact retries must remain usable
        // after an agent is undeployed or the submitting process is rebuilt
        // with a different/unavailable provider. Conflicts also take
        // precedence over current-environment validation.
        const existing = await this.sessionManager.load(params.tenantId, params.taskId);
        if (existing !== null) {
            const classification = classifyTaskSubmission({
                snapshot: existing.snapshot,
                taskId: params.taskId,
                requestDigest,
            });
            if (classification === 'missing') {
                throw new TaskSubmissionError(
                    'TASK_SUBMISSION_STATE_INCOMPATIBLE',
                    'an existing task without a submission envelope cannot be adopted'
                );
            }
            let storedSurface: string = 'unknown';
            try {
                storedSurface = readTaskTurnCoordinator(existing.snapshot, {
                    tenantId: params.tenantId,
                    taskId: params.taskId,
                }).runtimeSurface ?? 'unknown';
            } catch {
                // Observability enrichment must not change duplicate semantics.
            }
            const deadlineDisposition = classification === 'duplicate_active'
                ? await this.ensureAdmittedRootDeadline({
                      tenantId: params.tenantId,
                      taskId: params.taskId,
                      agentId: params.agentId,
                      snapshot: existing.snapshot,
                      phase: 'duplicate_repair',
                  })
                : 'terminal';
            const effectiveClassification = deadlineDisposition === 'terminal' || deadlineDisposition === 'canceled'
                ? 'duplicate_terminal'
                : classification;
            defaultMetricsRegistry.increment('task_submission_total', {
                status: effectiveClassification,
                runtimeSurface: storedSurface,
            });
            const projectionSnapshot = deadlineDisposition === 'terminal' || deadlineDisposition === 'canceled'
                ? (await this.sessionManager.load(params.tenantId, params.taskId))?.snapshot ?? existing.snapshot
                : existing.snapshot;
            await this.projectTaskAdmissionSnapshot({
                tenantId: params.tenantId,
                taskId: params.taskId,
                agentId: params.agentId,
                snapshot: projectionSnapshot,
            });
            return { taskId: params.taskId, status: effectiveClassification };
        }

        const capability = this.runtimeDriver.taskAdmissionCapabilities;
        const runtimeSurface = this.runtimeDriver.surface;
        if (
            capability?.recoverableStarts !== true ||
            (runtimeSurface !== 'in_process' && runtimeSurface !== 'hatchet')
        ) {
            throw new TaskSubmissionError(
                'TASK_ADMISSION_UNAVAILABLE',
                'the configured runtime driver does not support recoverable admitted starts'
            );
        }

        const plugin = PluginManager.findAgent(params.agentId);
        if (plugin?.resolved === undefined) {
            throw new TaskSubmissionError(
                'TASK_SUBMISSION_AGENT_UNAVAILABLE',
                `agent ${params.agentId} is not registered with resolved manifests`
            );
        }
        if (plugin.resolved.runtimeManifest.runMode !== 'loop') {
            throw new TaskSubmissionError(
                'TASK_SUBMISSION_AGENT_UNSUPPORTED',
                `agent ${params.agentId} is not a loop-mode agent`
            );
        }

        let manifestProvenance: ManifestProvenance;
        try {
            manifestProvenance = resolveManifestProvenance({
                agentCard: {
                    source: plugin.resolved.agentCardSource as ManifestSource,
                    content: plugin.resolved.agentCard,
                },
                runtimeManifest: {
                    source: plugin.resolved.runtimeManifestSource as ManifestSource,
                    content: plugin.resolved.runtimeManifest,
                },
            });
        } catch (error) {
            throw new TaskSubmissionError(
                'TASK_SUBMISSION_MANIFEST_INVALID',
                error instanceof Error ? error.message : String(error)
            );
        }
        const generation = '1';
        const deliveryKey = `${params.taskId}:turn-request:${generation}`;
        const startParams = {
            tenantId: params.tenantId,
            taskId: params.taskId,
            rootTaskId: params.taskId,
            agentId: params.agentId,
            input: durableInput.input,
            idempotencyKey: deliveryKey,
            recoveryGeneration: generation,
            recoveryDeliveryKey: deliveryKey,
        } as const;

        // Must happen before the admission CAS: an input that can never fit on
        // the selected provider must not become a permanently runnable intent.
        await capability.preflightStart(startParams);

        const reconciled = await reconcileSnapshotMutation<{
            status: SubmitTaskResult['status'];
            generation?: string;
            deliveryKey?: string;
        }>({
            session: this.sessionManager,
            tenantId: params.tenantId,
            sessionId: params.taskId,
            agentId: params.agentId,
            operation: 'task.submit',
            mutate: ({ exists, snapshot, storageNow }) => {
                const classification = classifyTaskSubmission({
                    snapshot,
                    taskId: params.taskId,
                    requestDigest,
                });
                if (classification !== 'missing') {
                    return { kind: 'noop', value: { status: classification } };
                }
                if (exists) {
                    throw new TaskSubmissionError(
                        'TASK_SUBMISSION_STATE_INCOMPATIBLE',
                        'an existing task without a submission envelope cannot be adopted'
                    );
                }
                const admitted = buildAdmittedTaskSnapshot({
                    tenantId: params.tenantId,
                    taskId: params.taskId,
                    agentId: params.agentId,
                    input: durableInput.input,
                    ...(maxTurns !== undefined ? { maxTurns } : {}),
                    ...(taskRunTimeoutMs !== undefined ? { taskRunTimeoutMs } : {}),
                    requestDigest,
                    manifestProvenance,
                    runtimeSurface,
                    storageNow,
                    ...(origin ? { origin } : {}),
                });
                return {
                    kind: 'write',
                    snapshot: admitted.snapshot,
                    value: {
                        status: 'accepted',
                        generation: admitted.generation,
                        deliveryKey: admitted.deliveryKey,
                    },
                };
            },
        });

        const reconciledSurface = readTaskTurnCoordinator(reconciled.snapshot, {
            tenantId: params.tenantId,
            taskId: params.taskId,
        }).runtimeSurface ?? runtimeSurface;
        defaultMetricsRegistry.increment('task_submission_total', {
            status: reconciled.value.status,
            runtimeSurface: reconciledSurface,
        });

        await this.projectTaskAdmissionSnapshot({
            tenantId: params.tenantId,
            taskId: params.taskId,
            agentId: params.agentId,
            snapshot: reconciled.snapshot,
        });

        // Only the admission CAS winner publishes directly. Exact duplicates
        // are read-only; the reconciler for the stored runtime surface owns all
        // recovery nudges.
        const coordinator = readTaskTurnCoordinator(reconciled.snapshot, {
            tenantId: params.tenantId,
            taskId: params.taskId,
        });
        const intent = coordinator.dispatchIntent;
        const deadlineDisposition = await this.ensureAdmittedRootDeadline({
            tenantId: params.tenantId,
            taskId: params.taskId,
            agentId: params.agentId,
            snapshot: reconciled.snapshot,
            phase: reconciled.value.status === 'accepted' ? 'admission' : 'cas_replay',
        });
        if (
            reconciled.value.status === 'accepted' &&
            deadlineDisposition !== 'terminal' &&
            deadlineDisposition !== 'canceled' &&
            deadlineDisposition !== 'unavailable' &&
            intent?.generation === generation &&
            intent.deliveryKey === deliveryKey &&
            intent.runtimeSurface === runtimeSurface &&
            intent.enqueuedAt === undefined
        ) {
            const publish = this.runtimeDriver.enqueueStart(startParams)
                .then(async () => {
                    await markTaskTurnDispatchEnqueued({
                        session: this.sessionManager!,
                        tenantId: params.tenantId,
                        taskId: params.taskId,
                        agentId: params.agentId,
                        generation,
                        deliveryKey,
                        runtimeSurface,
                    });
                    defaultMetricsRegistry.increment('task_submission_publish_total', {
                        status: 'published',
                        runtimeSurface,
                    });
                });
            try {
                await awaitTaskSubmissionPublish(publish);
            } catch (error) {
                defaultMetricsRegistry.increment('task_submission_publish_total', {
                    status: 'deferred',
                    runtimeSurface,
                });
                log.warn('Admitted task publication deferred to reconciliation', {
                    tenantId: params.tenantId,
                    taskId: params.taskId,
                    agentId: params.agentId,
                    generation,
                    runtimeSurface,
                    errorCode: error instanceof TaskSubmissionError
                        ? error.code
                        : error instanceof Error ? error.name : 'Error',
                });
            }
        }

        return { taskId: params.taskId, status: reconciled.value.status };
    }

    /**
     * Best-effort semantic projection sourced only from the authoritative
     * admission snapshot. Calling this for exact duplicates makes projection
     * failures self-repairing without republishing provider work.
     */
    private async projectTaskAdmissionSnapshot(params: {
        tenantId: string;
        taskId: string;
        agentId: string;
        snapshot: Record<string, unknown>;
    }): Promise<void> {
        if (readProjectionWriteMode() === 'off') return;
        const prisma = this.getSessionStorePrisma() as OperatorPrismaClient | undefined;
        const submission = readTaskSubmissionMetadata(params.snapshot);
        if (!prisma?.agentRun || !submission) return;
        await new OperatorProjectionRepository(prisma as never).projectAdmission({
            tenantId: params.tenantId,
            taskId: params.taskId,
            agentId: params.agentId,
            admittedAt: submission.admittedAt,
            ...(submission.origin ? { origin: submission.origin } : {}),
        }).catch((error) => {
            log.warn('Task admission semantic projection failed', {
                tenantId: params.tenantId,
                taskId: params.taskId,
                agentId: params.agentId,
                message: error instanceof Error ? error.message : String(error),
            });
        });
    }

    /**
     * Start a task with either streaming or buffered mode
     * @returns The final task entity for buffered mode, or void for streaming mode
     */
    async startTask(params: StartTaskParams): Promise<TaskEntity | void> {
        const { task, isStreaming, agentId, tenantId: startTenantId, initialContext, parentTelemetryNodeId, skipTelemetryNodeCreation } = params;

        // Automatic Telemetry: specific Agent Node for this task execution
        let agentNode: AgentNode | undefined;
        try {
            const parentNode = parentTelemetryNodeId ? telemetry.getNode(parentTelemetryNodeId) : undefined;
            if (skipTelemetryNodeCreation && parentNode instanceof AgentNode && parentNode.agentName === (agentId || 'default') && !parentNode.endTime) {
                agentNode = parentNode;
            } else {
                const traceId = parentNode?.traceId || uuidv7();
                const nodeId = uuidv7();
                agentNode = new AgentNode(agentId || 'default', nodeId, parentTelemetryNodeId, traceId);
                const inputPayload = (typeof task.input === 'object' && task.input !== null)
                    ? { ...task.input, originalTaskId: task.id }
                    : { value: task.input, originalTaskId: task.id };
                agentNode.start(inputPayload);
                telemetry.registerNode(agentNode);
            }
        } catch { /* ignore telemetry errors to prevent blockers */ }

        // Use provided context if present, otherwise create a basic one
        const ctx = initialContext ?? this.createContext(task, {
            tenantId: startTenantId ?? 'default',
            ...(agentId !== undefined ? { agentId } : {}),
        });

        // Inject telemetry context
        if (agentNode) {
            if (!ctx.telemetry) ctx.telemetry = {};
            ctx.telemetry.nodeId = agentNode.id;
            ctx.telemetry.traceId = agentNode.traceId;
        }

        // Preserve A2A requestInput override if provided on initialContext
        try {
            if ((initialContext as any)?.__preserveRequestInput && (initialContext as any).requestInput) {
                (ctx as any).requestInput = (initialContext as any).requestInput;
            }
        } catch { }
        // Safety: warn if semantic registry looks uninitialized
        try {
            const def = (ctx as any).memory?.semantic?.getDefaultBackend?.();
            if (def === 'none') {
                (ctx as any).logger?.warn?.('TaskEngine.startTask: semantic registry appears uninitialized (default=none)');
            }
        } catch { }
        // Attach agentId/tenantId to context for downstream persistence/restore
        if (agentId) {
            (ctx as any).agentId = agentId;
        }
        if (startTenantId) {
            (ctx as any).tenantId = startTenantId;
        }

        // Attach LLM adapter for this agent if configured
        try {
            const agentNameForStart = ((ctx as any).agentId || agentId) as string | undefined;
            if (agentNameForStart) {
                const { PluginManager } = await import('../plugin/pluginManager.js');
                const pluginForStart = PluginManager.findAgent(agentNameForStart);
                if (pluginForStart?.llmAdapter) {
                    (ctx as any).llm = pluginForStart.llmAdapter;
                } else if (pluginForStart?.llmConfig) {
                    const { createLLMForTask } = await import('../llm/LLMFactory.js');
                    (ctx as any).llm = createLLMForTask(pluginForStart.llmConfig, ctx as any);
                }
            }
        } catch { /* ignore LLM attach errors */ }

        // Choose execution path: loop-first (default) or durable handler
        // Check manifest for runMode, then ctx, then default to 'loop'
        const activeAgentId = (ctx as Record<string, unknown>).agentId as string | undefined || agentId;
        const plugin = activeAgentId ? PluginManager.findAgent(activeAgentId) : null;
        const manifestRunMode = plugin?.resolved.runtimeManifest.runMode;
        const turnTrace = plugin?.resolved.runtimeManifest.observability?.turnTrace;
        (ctx as InternalTaskContext).__operatorTurnTraceCapture = {
            enabled: turnTrace?.enabled ?? true,
            level: turnTrace?.level ?? 'summary',
        } satisfies OperatorTurnTraceCapture;
        const runModeRaw = (ctx as Record<string, unknown>).runMode ?? manifestRunMode ?? 'loop';
        const runMode: 'loop' | 'legacy' = runModeRaw === 'legacy' ? 'legacy' : 'loop';
        try { log.debug('Task execution start', { runMode, agentId: activeAgentId }); } catch { }
        if (process.env.DEBUG_BACKGROUND_TASKS) {
            console.log('[TaskEngine.startTask] About to execute, runMode=', runMode, 'isStreaming=', isStreaming);
        }

        const tenantId = ((ctx as Record<string, unknown>).tenantId || startTenantId || 'default') as string;
        const sessionId = task.id as string;
        if (agentNode) {
            Object.assign(agentNode.providerData, {
                sessionId,
                tenantId,
                rootTaskId: task.id,
                threadId: agentNode.traceId,
            });
        }
        const traceparent = createTraceparent();

        // Compute manifest provenance (fail-fast on identity mismatch when plugin has both manifests)
        let manifestProvenance: ManifestProvenance;
        if (plugin?.resolved) {
            try {
                manifestProvenance = resolveManifestProvenance({
                    agentCard: { source: plugin.resolved.agentCardSource as ManifestSource, content: plugin.resolved.agentCard },
                    runtimeManifest: { source: plugin.resolved.runtimeManifestSource as ManifestSource, content: plugin.resolved.runtimeManifest }
                });
            } catch (err) {
                throw new Error(`Manifest provenance failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        } else {
            manifestProvenance = { agentCardSource: 'inline', runtimeManifestSource: 'inline', agentCardHash: '', runtimeManifestHash: '' };
        }
        (ctx as InternalTaskContext).__manifestProvenance = manifestProvenance;

        try {
            // Load session-scoped snapshot if available (tenantId/sessionId assumed on ctx for now)
            const session = await this.sessionManager?.load(tenantId, sessionId) ?? null;


            let baseSnap = (session?.snapshot as Record<string, unknown>) || {};
            let contextWmVersion = session?.wmVersion;
            // Restore manifest provenance from snapshot if present (resume path)
            const meta = baseSnap.meta as { manifestProvenance?: ManifestProvenance } | undefined;
            if (meta?.manifestProvenance) {
                (ctx as InternalTaskContext).__manifestProvenance = meta.manifestProvenance;
            } else {
                // Persist provenance into snapshot meta so it is saved and available on resume
                const metaObj = (baseSnap.meta as Record<string, unknown>) || {};
                metaObj.manifestProvenance = manifestProvenance;
                baseSnap.meta = metaObj;
            }
            const persistedA2AParent = readA2AParentLink(
                (baseSnap as { meta?: { a2aParent?: unknown } }).meta?.a2aParent
            );
            if (persistedA2AParent && !(ctx as A2AChildContext).__a2aParent) {
                (ctx as A2AChildContext).__a2aParent = persistedA2AParent;
            }
            const a2aParent = (ctx as A2AChildContext).__a2aParent;
            if (a2aParent) {
                const metaObj = (baseSnap.meta as Record<string, unknown>) || {};
                metaObj.a2aParent = a2aParent;
                baseSnap.meta = metaObj;
            }
            // Reply delivery is task-scoped and must be durable before a loop
            // segment can be reconstructed by this or another process.
            const declaredAgentId = ((ctx as any).agentId || activeAgentId || 'default') as string;
            const requestedReplyMode = taskReplyDeliveryModeFromStreaming(isStreaming);
            if (this.sessionManager) {
                const desiredMeta = (baseSnap.meta as Record<string, unknown> | undefined) ?? {};
                const reconciled = await reconcileSnapshotMutation({
                    session: this.sessionManager,
                    tenantId,
                    sessionId,
                    agentId: declaredAgentId,
                    operation: 'task.seed_reply_delivery_mode',
                    mutate: ({ snapshot, agentId: storedAgentId }) => {
                        const lifecycle = readTaskLifecycle(snapshot, sessionId);
                        const delivery = isTaskLifecycleTerminal(lifecycle)
                            ? { snapshot, changed: false }
                            : ensureTaskReplyDeliveryMode(snapshot, requestedReplyMode);
                        const currentMeta =
                            delivery.snapshot.meta !== null &&
                            typeof delivery.snapshot.meta === 'object' &&
                            !Array.isArray(delivery.snapshot.meta)
                                ? delivery.snapshot.meta as Record<string, unknown>
                                : {};
                        const nextMeta = { ...currentMeta };
                        let changed = delivery.changed;
                        for (const key of ['manifestProvenance', 'a2aParent'] as const) {
                            if (nextMeta[key] === undefined && desiredMeta[key] !== undefined) {
                                nextMeta[key] = desiredMeta[key];
                                changed = true;
                            }
                        }
                        const needsAgentIdentity = !storedAgentId || storedAgentId === 'default';
                        if (!changed && !needsAgentIdentity) {
                            return { kind: 'noop', value: undefined };
                        }
                        return {
                            kind: 'write',
                            snapshot: {
                                ...delivery.snapshot,
                                meta: nextMeta,
                            },
                            value: undefined,
                        };
                    },
                });
                baseSnap = reconciled.snapshot;
                contextWmVersion = reconciled.wmVersion;
            } else {
                const lifecycle = readTaskLifecycle(baseSnap, sessionId);
                if (!isTaskLifecycleTerminal(lifecycle)) {
                    baseSnap = ensureTaskReplyDeliveryMode(baseSnap, requestedReplyMode).snapshot;
                }
            }

            let M: MentalState = (baseSnap as Record<string, unknown>).M as MentalState || initialM(ctx);
            // Hydrate any persisted Artifact markers inside the mental state / vars
            const mentalHydrationPrisma = this.getSessionStorePrisma() || (this.sessionManager as any)?.prisma;
            M = (ArtifactHydrationService.hydrateMentalStateArtifacts(M, mentalHydrationPrisma, tenantId, 'startTask') as MentalState) || M;
            // Expose MentalState on context for in-turn cognitive operations (e.g., goals API)
            (ctx as Record<string, unknown>).__mental = M;
            (ctx as Record<string, unknown>).__wmVersion = contextWmVersion;

            // Seed loop budget limits if provided in params.options
            if (params.options) {
                (ctx as any).options = { ...(ctx as any).options, ...params.options };

                try {
                    if (typeof params.options.maxTurns === 'number') {
                        // Update base snapshot meta immediately so it persists
                        const meta = (baseSnap as any).meta || {};
                        const budgets = meta.budgets || {};
                        budgets.maxTurns = params.options.maxTurns;
                        meta.budgets = budgets;
                        (baseSnap as any).meta = meta;

                        // Also seed initial mental state meta if needed
                        const mMeta = (M as any).meta || {};
                        const mBudgets = mMeta.budgets || {};
                        mBudgets.maxTurns = params.options.maxTurns;
                        mMeta.budgets = mBudgets;
                        (M as any).meta = mMeta;
                    }
                } catch (err) {
                    try { (ctx as any).logger?.warn?.('TaskEngine.startTask: Failed to inject options.maxTurns', { error: err }); } catch { }
                }
            }


            let cachedLlmState: unknown = undefined;
            const prepareLlmState = () => {
                try {
                    const llmAny = (ctx as any).llm as any;
                    const historyMode = (typeof llmAny?.getHistoryMode === 'function') ? llmAny.getHistoryMode() : 'full';

                    if (historyMode !== 'stateless') {
                        if (llmAny?.getMessages) {
                            const messages = llmAny.getMessages(true);
                            cachedLlmState = { messages } as unknown;
                        } else if (llmAny?.exportState) {
                            cachedLlmState = llmAny.exportState();
                        }
                    }
                } catch { /* ignore */ }
            };
            const flushMentalState = async () => {
                if (!this.snapshotRepo) return;
                // Capture dependencies for mutate function
                const prisma = this.getSessionStorePrisma() || (this.sessionManager as any).prisma;

                const parentTelemetryId = ctx.telemetry?.nodeId ?? agentNode?.id;
                const traceForPersist = ctx.telemetry?.traceId ?? agentNode?.traceId;
                let persistNode: WorkflowNode | undefined;
                if (parentTelemetryId) {
                    persistNode = new WorkflowNode('state.persist', parentTelemetryId, undefined, traceForPersist);
                    persistNode.start({
                        tenantId,
                        sessionId,
                        agentId: (ctx as Record<string, unknown>).agentId as string | undefined,
                    });
                    telemetry.registerNode(persistNode);
                }

                const mutateFn = async (baseSnap: Record<string, unknown>) => {
                    prepareLlmState();
                    const next = {
                        ...baseSnap,
                        M,
                        ...(cachedLlmState ? { llmState: cachedLlmState } : {}),
                        meta: mergeSnapshotMetaWithCtxTelemetry(baseSnap, ctx),
                    } as Record<string, unknown>;

                    if (prisma) {
                        const cache = new AgentResultCache(prisma);
                        await offloadArtifacts(next, cache, tenantId);
                    }
                    return next;
                };

                try {
                    try {
                        await this.snapshotRepo.saveWithRetry({
                            tenantId,
                            sessionId,
                            agentId: typeof (ctx as Record<string, unknown>).agentId === 'string' ? (ctx as Record<string, unknown>).agentId as string : 'default',
                            mutate: mutateFn
                        });
                    } catch (e) {
                        if ((e as Error).message === 'LIMIT_WM_SNAPSHOT_TOO_LARGE') {
                            const prunedM = pruneSnapshot(M);
                            M = prunedM;
                            await this.snapshotRepo.saveWithRetry({
                                tenantId,
                                sessionId: sessionId,
                                agentId: typeof (ctx as Record<string, unknown>).agentId === 'string' ? (ctx as Record<string, unknown>).agentId as string : 'default',
                                mutate: async (baseSnap) => {
                                    const next = {
                                        ...baseSnap,
                                        M,
                                        meta: mergeSnapshotMetaWithCtxTelemetry(baseSnap, ctx),
                                    };
                                    if (prisma) {
                                        const cache = new AgentResultCache(prisma);
                                        await offloadArtifacts(next, cache, tenantId);
                                    }
                                    return next;
                                }
                            });
                        } else {
                            throw e;
                        }
                    }
                    if (persistNode) {
                        persistNode.end({ ok: true }, 'success');
                        telemetry.endNode(persistNode);
                    }
                    if (parentTelemetryId) {
                        const concepts = M?.memory?.longTerm?.semantic?.concepts;
                        const semanticConceptCount = Array.isArray(concepts) ? concepts.length : 0;
                        const vars = (M as Record<string, unknown>).vars as
                            | Record<string, unknown>
                            | undefined;
                        const hasSelectorsInVars = vars != null && vars.selectors != null;
                        const memSaveNode = new WorkflowNode(
                            'memory.save_selectors',
                            parentTelemetryId,
                            undefined,
                            traceForPersist
                        );
                        memSaveNode.start({
                            tenantId,
                            sessionId,
                            surface: 'working_memory_snapshot',
                            semanticConceptCount,
                            hasSelectorsInVars,
                        });
                        telemetry.registerNode(memSaveNode);
                        memSaveNode.end({ ok: true, persisted: true }, 'success');
                        telemetry.endNode(memSaveNode);
                    }
                } catch (e) {
                    if (persistNode) {
                        const er = e instanceof Error ? e : new Error(String(e));
                        persistNode.fail(er);
                        telemetry.failNode(persistNode, er);
                        telemetry.endNode(persistNode);
                    }
                    throw e;
                }
            };

            // Legacy VarsSync.createVarsProxy and assignVarsIntoMental removed.


            await this.apiBinder.attachOrchestrationAPIs(ctx, {
                tenantId,
                sessionId,
                agentId: (ctx as any).agentId || 'default',
                flushMentalState
            });

            // Append start event and publish status via outbox; reducer entrypoint
            await this.sessionManager?.appendEvent(tenantId as string, sessionId as string, 'task.started', {
                taskId: sessionId,
                agentId: typeof (ctx as Record<string, unknown>).agentId === 'string' ? (ctx as Record<string, unknown>).agentId : undefined,
                traceparent,
                inputPreview: task.input,
            });
            await this.sessionManager?.enqueueOutbox(tenantId as string, 'task.status', sessionId as string, { taskId: sessionId, status: { state: 'working', timestamp: new Date().toISOString() }, traceparent });
            // Emit initial working status locally too so CLI can see the taskId
            try {
                void this.eventBus.publish(
                    createBusEvent({
                        channel: taskChannel(sessionId),
                        partitionKey: sessionId,
                        cloud: {
                            id: uuidv7(),
                            type: 'task.status',
                            source: `/tasks/${sessionId}`,
                            time: new Date().toISOString(),
                            datacontenttype: 'application/json',
                            data: {
                                id: sessionId,
                                status: {
                                    state: 'working',
                                    timestamp: new Date().toISOString(),
                                    message: {
                                        role: 'agent',
                                        parts: [{ type: 'text', text: `Task started: ${sessionId}` }],
                                    },
                                },
                                final: false,
                            },
                        },
                    })
                );
            } catch {
                /* noop */
            }
            const initialWm = (session?.snapshot as Record<string, unknown>) || {};
            const { wm: wmAfterStart } = decide(initialWm, { t: 'task.started' });

            // Extend the context with streaming capabilities
            extendContextWithStreaming(ctx, isStreaming, this.eventBus);
            // carry runMode from agent manifest via streaming runner if present; default loop
            // FIX: Don't prematurely default to 'loop' here, wait until we check the manifest
            // if (!(ctx as any).runMode) { (ctx as any).runMode = 'loop'; }


            // Set initial status
            const initialStatus: TaskStatus = {
                state: 'submitted',
                timestamp: new Date().toISOString()
            };

            // Update status to 'working'
            ctx.progress({
                state: 'working',
                timestamp: new Date().toISOString()
            });

            // Choose execution path: loop-first (default) or durable handler
            // Check manifest for runMode, then ctx, then default to 'loop'
            const agentId = (ctx as any).agentId;
            const plugin = agentId ? PluginManager.findAgent(agentId) : null;
            const manifestRunMode = plugin?.resolved.runtimeManifest.runMode;
            const runMode: 'loop' | 'legacy' = (ctx as any).runMode || manifestRunMode || 'loop';
            try { log.debug('Task execution start', { runMode, agentId: (ctx as any).agentId }); } catch { }
            if (process.env.DEBUG_BACKGROUND_TASKS) {
                console.log('[TaskEngine.startTask] About to execute, runMode=', runMode, 'isStreaming=', isStreaming);
            }

            const runLegacy = async () => {
                if (isStreaming) {
                    this.executeTaskHandler(ctx).catch(error => {
                        log.error('Task handler error', { error: error instanceof Error ? error.message : String(error) });
                        ctx.fail({
                            state: 'failed',
                            message: { role: 'agent', parts: [{ type: 'text', text: `Task execution failed: ${error instanceof Error ? error.message : String(error)}` }] },
                            timestamp: new Date().toISOString()
                        } as any);
                    });
                    return;
                }
                await this.executeTaskHandler(ctx);
            };

            if (runMode === 'legacy') {
                await runLegacy();
            } else {
                const taskResult = await this.runPreparedTurnThroughDriver({
                        operation: 'start',
                        tenantId,
                        taskId: sessionId,
                        agentId: typeof agentId === 'string' ? agentId : undefined,
                        idempotencyKey: `${sessionId}:start`,
                        input: task.input,
                        ctx,
                        turnParams: {
                            tenantId,
                            sessionId,
                            trigger: 'start',
                            isStreaming,
                            input: task.input,
                        },
                        initialM: M,
                        snapshot: baseSnap,
                    });
                const terminalHandledBySegmentRuntime =
                    (taskResult as { __turnPersistence?: unknown }).__turnPersistence !== undefined;

                if (taskResult) {
                    task.status = taskResult.status;
                    task.artifacts = taskResult.artifacts;
                    task.input = taskResult.input;
                }

                // A timeout/manual cancellation may have won while this segment was
                // executing. Snapshot lifecycle is authoritative; a stale local turn
                // must not publish a contradictory terminal event afterward.
                let terminalPublicationAllowed = true;
                let authoritativeTerminal: ReturnType<typeof readDurableTaskTerminal>;
                const publishDurableTerminal = async (): Promise<void> => {
                    const latest = await this.sessionManager?.load(tenantId as string, sessionId as string);
                    const latestSnapshot = (latest?.snapshot as Record<string, unknown> | undefined) ?? {};
                    if (readDurableTaskTerminal(latestSnapshot) === undefined) {
                        // Compatibility for injected/custom turn executors that
                        // return a terminal result without persisting the standard
                        // TaskExecutor terminal record.
                        if (task.status !== undefined) {
                            await this.sessionManager?.enqueueOutbox(
                                tenantId as string,
                                'task.status',
                                sessionId as string,
                                { taskId: sessionId, status: task.status, final: true, traceparent }
                            );
                        }
                        return;
                    }
                    await this.ensureTaskTerminalPublished({
                        tenantId: tenantId as string,
                        taskId: sessionId as string,
                        agentId: typeof agentId === 'string' ? agentId : undefined,
                        snapshot: latestSnapshot,
                    });
                };
                if (
                    task.status?.state === 'completed' ||
                    task.status?.state === 'failed' ||
                    task.status?.state === 'canceled'
                ) {
                    const latest = await this.sessionManager?.load(tenantId as string, sessionId as string);
                    const latestSnapshot = (latest?.snapshot as Record<string, unknown> | undefined) ?? {};
                    const durableTerminal = readDurableTaskTerminal(latestSnapshot);
                    authoritativeTerminal = durableTerminal;
                    const durableStatus = durableTerminal?.status as TaskStatus | undefined;
                    if (durableStatus !== undefined && durableStatus.state !== task.status.state) {
                        terminalPublicationAllowed = false;
                        task.status = durableStatus;
                    }
                }

                const terminalProjection = authoritativeTerminal?.turnClaim ? {
                    attemptKey: authoritativeTerminal.turnClaim.attemptKey ??
                        `claim:${authoritativeTerminal.turnClaim.claimId}`,
                    claimId: authoritativeTerminal.turnClaim.claimId,
                    fence: authoritativeTerminal.turnClaim.fence,
                    claimedGeneration: authoritativeTerminal.turnClaim.generation,
                    turnSeq: authoritativeTerminal.turnClaim.turnSeq,
                    deliveryKey: authoritativeTerminal.deliveryKey,
                    authoritativeTerminal: true,
                } : {};

                if (terminalPublicationAllowed && task.status?.state === 'completed') {
                    const artifacts = artifactMetadataForOperator(task.artifacts);
                    await this.sessionManager?.appendEvent(tenantId as string, sessionId as string, 'task.completed', {
                        taskId: sessionId,
                        artifactsCount: Array.isArray(task.artifacts) ? task.artifacts.length : 0,
                        ...(artifacts.length > 0 ? { artifacts } : {}),
                        traceparent,
                        ...terminalProjection,
                    });
                    await publishDurableTerminal();
                } else if (terminalPublicationAllowed && task.status?.state === 'failed') {
                    const failureMessage = this.taskFailureMessage(task);
                    const failureReason =
                        typeof task.status.metadata?.reason === 'string'
                            ? task.status.metadata.reason
                            : failureMessage;
                    await this.sessionManager?.appendEvent(tenantId as string, sessionId as string, 'task.failed', {
                        taskId: sessionId,
                        error: failureMessage,
                        reason: failureReason,
                        traceparent,
                        ...terminalProjection,
                    });
                    await publishDurableTerminal();
                } else if (terminalPublicationAllowed && task.status?.state === 'canceled') {
                    const cancelReason =
                        typeof task.status.metadata?.reason === 'string'
                            ? task.status.metadata.reason
                            : 'canceled';
                    await this.sessionManager?.appendEvent(tenantId as string, sessionId as string, 'task.canceled', {
                        taskId: sessionId,
                        reason: cancelReason,
                        canceledAt: task.status.timestamp ?? new Date().toISOString(),
                        traceparent,
                        ...terminalProjection,
                    });
                    await publishDurableTerminal();
                }

                this.finalizeAgentNodeTelemetry(agentNode, task);
                if (terminalPublicationAllowed && !terminalHandledBySegmentRuntime) {
                    // A committed in-process segment already invoked the runtime
                    // terminal callback. This path remains for terminal replays
                    // and injected/custom segment results that did not execute
                    // through the standard TurnRunner persistence boundary.
                    await this.notifyA2AParentIfTerminal(
                        ctx,
                        task,
                        typeof agentId === 'string' ? agentId : undefined
                    );
                }

                if (isStreaming) {
                    // Even in streaming mode, we return the task entity so the caller has the ID and handle.
                    // The runTurn call above is awaited, so we have initial state.
                }
                return task;
            }

            // After handler: flush MentalState once (skip if already flushed earlier in this turn)
            if (this.sessionManager && !(ctx as any).__wmSavedThisTurn) {
                try { await flushMentalState(); } catch (e) {
                    if ((e as Error).message !== 'LIMIT_WM_SNAPSHOT_TOO_LARGE') {
                        throw e;
                    }
                }
            }

            // Get the buffered results from the context
            const results = (ctx as any).getBufferedResults();

            // Update the task entity with the results
            task.status = results.status || {
                state: 'completed',
                timestamp: new Date().toISOString()
            };
            task.artifacts = results.artifacts;

            // If this turn requested input, do NOT mark completed; just return current status
            if (task.status?.state === 'input-required' || (ctx as any).__wmSavedThisTurn) {
                this.finalizeAgentNodeTelemetry(agentNode, task);
                await this.notifyA2AParentIfTerminal(
                    ctx,
                    task,
                    typeof (ctx as Record<string, unknown>).agentId === 'string'
                        ? (ctx as Record<string, unknown>).agentId as string
                        : undefined
                );
                return task;
            }

            // Append completed event and publish status via outbox
            const artifacts = artifactMetadataForOperator(task.artifacts);
            await this.sessionManager?.appendEvent(tenantId as string, sessionId as string, 'task.completed', {
                taskId: sessionId,
                artifactsCount: Array.isArray(task.artifacts) ? task.artifacts.length : 0,
                ...(artifacts.length > 0 ? { artifacts } : {}),
                traceparent
            });
            await this.sessionManager?.enqueueOutbox(tenantId as string, 'task.status', sessionId as string, {
                taskId: sessionId,
                status: { state: 'completed', timestamp: new Date().toISOString() },
                final: true,
                traceparent
            });

            this.finalizeAgentNodeTelemetry(agentNode, task);
            await this.notifyA2AParentIfTerminal(
                ctx,
                task,
                typeof (ctx as Record<string, unknown>).agentId === 'string'
                    ? (ctx as Record<string, unknown>).agentId as string
                    : undefined
            );
            return task;
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            log.error('Task engine error', { error: err.message });

            if (runMode === 'loop') {
                // Loop-mode failures are arbitrated inside the fenced segment. If
                // a terminal commit already won, recover and republish that exact
                // durable result. Otherwise surface the internal/runtime error;
                // synthesizing an unfenced failed status here could overwrite or
                // notify from a losing attempt.
                let latest: Awaited<ReturnType<SessionManager['load']>> | undefined;
                try {
                    latest = await this.sessionManager?.load(tenantId, sessionId) ?? undefined;
                } catch (recoveryError) {
                    log.warn('Unable to inspect durable terminal while propagating loop execution error', {
                        tenantId,
                        taskId: sessionId,
                        error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
                    });
                }
                const terminal = readDurableTaskTerminal(
                    latest?.snapshot as Record<string, unknown> | undefined
                );
                if (terminal !== undefined) {
                    task.status = terminal.status as TaskStatus;
                    try {
                        await this.ensureTaskTerminalPublished({
                            tenantId,
                            taskId: sessionId,
                            agentId: activeAgentId,
                            snapshot: latest?.snapshot as Record<string, unknown>,
                        });
                    } catch (projectionError) {
                        log.warn('Durable terminal recovery projection failed', {
                            tenantId,
                            taskId: sessionId,
                            error: projectionError instanceof Error
                                ? projectionError.message
                                : String(projectionError),
                        });
                    }
                    try {
                        await this.notifyA2AParentIfTerminal(ctx, task, activeAgentId);
                    } catch (notificationError) {
                        log.warn('Durable terminal recovery parent notification failed', {
                            tenantId,
                            taskId: sessionId,
                            error: notificationError instanceof Error
                                ? notificationError.message
                                : String(notificationError),
                        });
                    }
                    this.finalizeAgentNodeTelemetry(agentNode, task);
                    return task;
                }
                this.finalizeAgentNodeTelemetry(agentNode, task, err);
                throw err;
            }

            // Set failure status for non-streaming mode
            if (!isStreaming) {
                task.status = {
                    state: 'failed',
                    message: {
                        role: 'agent',
                        parts: [
                            { type: 'text', text: `Task execution failed: ${err.message}` }
                        ]
                    },
                    timestamp: new Date().toISOString()
                };
                await this.sessionManager?.appendEvent(tenantId as string, sessionId as string, 'task.failed', {
                    taskId: sessionId,
                    error: err.message,
                    traceparent
                });
                await this.sessionManager?.enqueueOutbox(tenantId as string, 'task.status', sessionId as string, {
                    taskId: sessionId,
                    status: {
                        state: 'failed',
                        message: { role: 'agent', parts: [{ type: 'text', text: err.message }] },
                        timestamp: new Date().toISOString()
                    },
                    final: true,
                    traceparent
                });
                this.finalizeAgentNodeTelemetry(agentNode, task, err);
                return task;
            }

            // Append failed event and publish status via outbox
            await this.sessionManager?.appendEvent(tenantId as string, sessionId as string, 'task.failed', {
                taskId: sessionId,
                error: err.message,
                traceparent
            });
            await this.sessionManager?.enqueueOutbox(tenantId as string, 'task.status', sessionId as string, {
                taskId: sessionId,
                status: {
                    state: 'failed',
                    message: { role: 'agent', parts: [{ type: 'text', text: err.message }] },
                    timestamp: new Date().toISOString()
                },
                final: true,
                traceparent
            });

            // For streaming, emit a failure event directly
            task.status = {
                state: 'failed',
                message: {
                    role: 'agent',
                    parts: [{ type: 'text', text: err.message }]
                },
                timestamp: new Date().toISOString()
            };
            this.finalizeAgentNodeTelemetry(agentNode, task, err);
            void this.eventBus.publish(
                createBusEvent({
                    channel: taskChannel(task.id),
                    partitionKey: task.id,
                    cloud: {
                        id: uuidv7(),
                        type: 'task.status',
                        source: `/tasks/${task.id}`,
                        time: new Date().toISOString(),
                        datacontenttype: 'application/json',
                        data: {
                            id: task.id,
                            status: {
                                state: 'failed',
                                message: {
                                    role: 'agent',
                                    parts: [{ type: 'text', text: `Task execution failed: ${err.message}` }],
                                },
                                timestamp: new Date().toISOString(),
                            },
                            final: true,
                        },
                    },
                })
            );
        }
    }

    /**
     * Resume a task on input (scaffold): append input event and publish status via outbox.
     * Real handler dispatch will be added with durable handler registry.
     */
    async resumeInput(params: {
        tenantId: string;
        taskId: string;
        token: string;
        input: unknown;
        isStreaming?: boolean;
    }): Promise<{ acknowledged: true }> {
        log.debug('Resume input processing started');
        const { tenantId, taskId, token, input, isStreaming } = params;
        // load snapshot
        const snap = await this.sessionManager?.load(tenantId, taskId);
        if (!snap) {
            throwInvariantError(
                'SESSION_NOT_FOUND',
                `Session ${taskId} not found`,
                { type: 'session_config', reason: 'session_not_found', taskId }
            );
        }

        const base = (snap.snapshot as Record<string, unknown>) || {};
        const loopAgentName = snap.agentId ?? (base as { meta?: { agentId?: string } }).meta?.agentId;
        const loopPlugin = loopAgentName ? PluginManager.findAgent(loopAgentName) : null;
        const configuredRunMode = loopPlugin?.resolved.runtimeManifest.runMode ?? 'loop';
        if (configuredRunMode !== 'legacy') {
            if (isStreaming !== undefined) {
                const requestedMode = taskReplyDeliveryModeFromStreaming(isStreaming);
                await reconcileSnapshotMutation({
                    session: this.sessionManager!,
                    tenantId,
                    sessionId: taskId,
                    agentId: loopAgentName,
                    operation: 'input.seed_reply_delivery_mode',
                    mutate: ({ snapshot, storageNow }) => {
                        const lifecycle = readTaskLifecycle(snapshot, taskId);
                        if (isTaskLifecycleTerminal(lifecycle)) {
                            return { kind: 'noop', value: undefined };
                        }
                        const pending = getPendingInputs(snapshot);
                        const entry = pending[token];
                        const tokenIsValid = entry !== undefined && (
                            entry.expiresAt === undefined ||
                            Date.parse(entry.expiresAt) >= Date.parse(storageNow)
                        );
                        if (!tokenIsValid) {
                            return { kind: 'noop', value: undefined };
                        }
                        const ensured = ensureTaskReplyDeliveryMode(snapshot, requestedMode);
                        return ensured.changed
                            ? { kind: 'write', snapshot: ensured.snapshot, value: undefined }
                            : { kind: 'noop', value: undefined };
                    },
                });
            }
            if (input && typeof input === 'object') {
                const prisma = this.getSessionStorePrisma();
                if (prisma) hydrateArtifacts(input, new AgentResultCache(prisma), tenantId);
            }
            const resume = {
                tenantId,
                taskId,
                agentId: loopAgentName,
                idempotencyKey: `${taskId}:input:${token}`,
                event: { kind: 'input' as const, token, value: input },
            };
            if (isSyncRuntimeDriver(this.runtimeDriver)) {
                await this.runtimeDriver.enqueueResumeSync(resume);
            } else {
                await this.runtimeDriver.enqueueResume(resume);
            }
            return { acknowledged: true };
        }
        // Validate token existence/expiry
        try {
            const pend = getPendingInputs(base) as any;
            const entry = pend[token];
            if (!entry) {
                throwInvariantError(
                    'INPUT_TOKEN_NOT_FOUND',
                    `Input token ${token} not found for session ${taskId}`,
                    { type: 'token_validation', category: 'input', token, reason: 'missing', pendingSnapshot: pend }
                );
            }
            if (entry.expiresAt && Date.parse(entry.expiresAt) < Date.now()) {
                throwInvariantError(
                    'INPUT_TOKEN_EXPIRED',
                    `Input token ${token} expired for session ${taskId}`,
                    { type: 'token_validation', category: 'input', token, reason: 'expired', pendingSnapshot: pend }
                );
            }

        } catch (e) {
            throw e instanceof Error ? e : new Error('INPUT_TOKEN_INVALID');
        }
        const { next } = applyInputProvided(base, token, input, {
            tenantId,
            taskId,
            agentId: String((snap as any)?.agentId ?? (base as any)?.meta?.agentId ?? 'default'),
        });
        // Hydrate input if it contains artifacts (e.g. from resumeInput)
        if (input && typeof input === 'object') {
            const prisma = this.getSessionStorePrisma();
            if (prisma) {
                const cache = new AgentResultCache(prisma);
                hydrateArtifacts(input, cache, tenantId);
            }
        }
        const expected = snap?.wmVersion ?? BigInt(0);
        await this.sessionManager?.appendEvent(tenantId, taskId, 'task.input_provided', { token });
        await this.sessionManager?.saveSnapshot({ tenantId, sessionId: taskId, agentId: (next as any).meta?.agentId || 'default', expectedWmVersion: expected, snapshot: next });
        await this.sessionManager?.enqueueOutbox(tenantId, 'task.status', taskId, { taskId, status: { state: 'working', timestamp: new Date().toISOString() }, metadata: { inputProvided: true } });
        // Always auto-resume one loop turn to consume the provided input
        try {
            const agentName = (snap as any)?.agentId;
            const plugin = agentName ? PluginManager.findAgent(agentName) : null;
            // Build context for this resume turn; use provided input as the current turn input
            const ctx = this.createContext(
                { id: taskId, input: input as any },
                {
                    tenantId,
                    ...(agentName !== undefined ? { agentId: agentName } : {}),
                }
            );
            (ctx as any).tenantId = tenantId;
            if (agentName) (ctx as any).agentId = agentName;
            // Ensure replies in this resumed turn are streamed to chat
            try {
                extendContextWithStreaming(ctx, true, this.eventBus);
            } catch {
                /* noop */
            }

            // Attach requestInput implementation (same as in startTask) so agent can ask for more input
            const sessionId = taskId;
            if ((ctx as any).__a2aParent || (ctx as any).__preserveRequestInput) {
                // Keep existing A2A override
                try { (ctx as any).logger?.debug?.('TaskEngine.resumeInput: preserving A2A requestInput override'); } catch { }
            } else {
                (ctx as any).requestInput = async (promptOrParts: string | string[] | import('../shared/types/index.js').MessagePart | import('../shared/types/index.js').MessagePart[], opts?: { ttlMs?: number; schema?: unknown; onProvided?: string; onExpired?: string; __existingToken?: string; setToken?: boolean; setStage?: string }) => {
                    if (!this.sessionManager) throw new Error('Session manager not configured');
                    // Limits: cap max outstanding prompts
                    const maxPrompts = 100;
                    const snapL = await this.sessionManager.load(tenantId, sessionId);
                    const baseL = (snapL?.snapshot as Record<string, unknown>) || {};
                    const pendingNow = getPendingInputs(baseL);
                    if (Object.keys(pendingNow).length >= maxPrompts) {
                        throwInvariantError(
                            'LIMIT_MAX_PROMPTS_EXCEEDED',
                            `Maximum outstanding prompts reached (${maxPrompts})`,
                            { type: 'session_config', reason: 'limit_max_prompts_exceeded', limit: maxPrompts, actual: Object.keys(pendingNow).length }
                        );
                    }

                    const snap = await this.sessionManager.load(tenantId, sessionId);
                    const base = (snap?.snapshot as Record<string, unknown>) || {};
                    const token = opts?.__existingToken || uuidv7();
                    const expiresAt = opts?.ttlMs ? new Date(Date.now() + opts.ttlMs).toISOString() : undefined;
                    const pending = { ...getPendingInputs(base) };

                    // Normalize promptOrParts into parts[] and derive a fallback prompt string
                    const normalizeParts = (p: string | string[] | import('../shared/types/index.js').MessagePart | import('../shared/types/index.js').MessagePart[]): import('../shared/types/index.js').MessagePart[] => {
                        if (typeof p === 'string') return [{ type: 'text', text: p, format: 'markdown' } as any];
                        if (Array.isArray(p) && p.length > 0 && typeof p[0] === 'string') return (p as string[]).map(t => ({ type: 'text', text: t, format: 'markdown' } as any));
                        if (Array.isArray(p)) return (p as any[]).map(part => (part?.type === 'text' && !part?.format ? { ...part, format: 'markdown' } : part));
                        const one = p as any;
                        return [one?.type === 'text' && !one?.format ? { ...one, format: 'markdown' } : one];
                    };
                    const parts = normalizeParts(promptOrParts);
                    const prompt = (parts.find((x: any) => x?.type === 'text') as any)?.text as string | undefined;

                    // Only add to pending if it's a new token request
                    if (!opts?.__existingToken) {
                        pending[token] = {
                            schema: opts?.schema,
                            expiresAt,
                            handlerName: opts?.onProvided,
                            expiredHandlerName: opts?.onExpired
                        } as any;
                    }
                    // Helper to flush M and save snapshot
                    const flushMentalState = async () => {
                        try {
                            const snap = await this.sessionManager!.load(tenantId, sessionId);
                            const M = (snap?.snapshot as any)?.M;
                            if (M) {
                                const llmAny = (ctx as any).llm as any;
                                const llmStateFromSnap = (snap?.snapshot as any)?.llmState;
                                if (typeof llmStateFromSnap === 'undefined' && llmAny?.exportState) {
                                    return llmAny.exportState();
                                }
                            }
                        } catch { /* noop */ }
                        return undefined;
                    };
                    const controlUpdates: Array<[string, unknown]> = [];
                    const writeOnce = async (baseSnap: Record<string, unknown>, expectedVer: bigint) => {
                        let exportedLlm: unknown = undefined;
                        try { exportedLlm = await flushMentalState(); } catch { /* best-effort */ }
                        const latest = await this.sessionManager!.load(tenantId, sessionId);
                        const latestBase = (latest?.snapshot as Record<string, unknown>) || baseSnap;
                        let nextSnapshot = setPendingInputs(latestBase, pending);
                        if (exportedLlm) {
                            nextSnapshot.llmState = exportedLlm;
                        }
                        if (controlUpdates.length > 0) {
                            for (const [path, value] of controlUpdates) {
                                nextSnapshot = TaskStateUtils.applyControlVarToSnapshot(nextSnapshot, path, value);
                            }
                        }
                        const expectedNext = latest?.wmVersion ?? expectedVer;
                        await this.sessionManager!.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || 'default', expectedWmVersion: expectedNext, snapshot: nextSnapshot });
                        await this.sessionManager!.appendEvent(tenantId, sessionId, 'task.input_required', { token, prompt, parts, schema: opts?.schema, expiresAt });
                        await this.sessionManager!.enqueueOutbox(tenantId, 'task.input_required', sessionId, { taskId: sessionId, prompt, parts, token, schema: opts?.schema, expiresAt });
                    };
                    try {
                        const expected = snap?.wmVersion ?? BigInt(0);
                        await writeOnce(base, expected);
                    } catch (e) {
                        if (isWorkingMemoryVersionConflict(e)) {
                            try {
                                const snap2 = await this.sessionManager.load(tenantId, sessionId);
                                const base2 = (snap2?.snapshot as Record<string, unknown>) || {};
                                const pending2 = { ...getPendingInputs(base2), [token]: { schema: opts?.schema, expiresAt } } as any;
                                const expected2 = snap2?.wmVersion ?? BigInt(0);
                                let next2 = setPendingInputs(base2, pending2);
                                if (controlUpdates.length > 0) {
                                    for (const [path, value] of controlUpdates) {
                                        next2 = TaskStateUtils.applyControlVarToSnapshot(next2, path, value);
                                    }
                                }
                                await this.sessionManager.saveSnapshot({ tenantId, sessionId, agentId: (ctx as any).agentId || 'default', expectedWmVersion: expected2, snapshot: next2 });
                                await this.sessionManager.appendEvent(tenantId, sessionId, 'task.input_required', { token, prompt, parts, schema: opts?.schema, expiresAt });
                                await this.sessionManager.enqueueOutbox(tenantId, 'task.input_required', sessionId, { taskId: sessionId, prompt, parts, token, schema: opts?.schema, expiresAt });
                            } catch { /* swallow second failure */ }
                        } else {
                            throw e;
                        }
                    }
                    try { (ctx as any).logger?.info?.('requestInput: input_required emitted', { token, prompt, expiresAt }); } catch { }
                    // Emit prompt parts as a reply so chat UIs can render markup/buttons/etc.
                    try { await ctx.reply(parts as any); } catch { /* best-effort */ }
                    try {
                        ctx.progress({
                            state: 'input-required',
                            message: {
                                role: 'agent',
                                parts
                            },
                            timestamp: new Date().toISOString(),
                            metadata: { token }
                        } as any);
                    } catch { /* noop */ }
                    // Automatic token management (default: true)
                    if (opts?.setToken !== false) {
                        controlUpdates.push(['token', token]);
                        writeControlVar(ctx, 'token', token);
                    }

                    // Automatic stage management
                    if (opts?.setStage) {
                        try {
                            controlUpdates.push(['stage', opts.setStage]);
                            writeControlVar(ctx, 'stage', opts.setStage);
                        } catch (error) {
                            (ctx as any).logger?.warn?.('Failed to auto-set stage', { stage: opts.setStage, error });
                        }
                    }

                    (ctx as any).__wmSavedThisTurn = true;
                    const handle = new InputHandle(this.sessionManager, tenantId, sessionId, token);
                    return handle;
                };
            }
            // Load MentalState and pending for EnvironmentState
            const baseNow = (await this.sessionManager!.load(tenantId, taskId))?.snapshot as Record<string, unknown> || {};
            let M: MentalState = (baseNow as any).M as MentalState || initialM(ctx);
            M = (ArtifactHydrationService.hydrateMentalStateArtifacts(
                M,
                this.getSessionStorePrisma() || (this.sessionManager as any)?.prisma,
                tenantId,
                'requestInput.autoResume'
            ) as MentalState) || M;
            // Attach and restore LLM before running loop
            await this.attachAndRestoreLLM(ctx, agentName, M);
            const baseMeta = (baseNow as Record<string, unknown>)?.meta as Record<string, unknown> | undefined;
            const startTurnTotal = Number(baseMeta?.turn ?? 0) || 0;
            // Resolve runMode for resume
            const manifestRunMode = plugin?.resolved.runtimeManifest.runMode;
            const rawRunMode = (ctx as Record<string, unknown>).runMode;
            const runMode: 'loop' | 'legacy' = (rawRunMode === 'legacy' || rawRunMode === 'loop') ? rawRunMode : (manifestRunMode ?? 'loop');

            if (runMode === 'legacy') {
                await this.executeTaskHandler(ctx);
            } else {
                const taskResult = await this.runPreparedTurnThroughDriver({
                        operation: 'resume',
                        tenantId,
                        taskId,
                        agentId: agentName,
                        idempotencyKey: `${taskId}:input:${token}`,
                        resumeEvent: { kind: 'input', token, value: input },
                        ctx,
                        turnParams: {
                            tenantId,
                            sessionId: taskId,
                            trigger: 'resume',
                            isStreaming: false,
                            input: { token },
                        },
                        initialM: M,
                        snapshot: baseNow,
                    });

                const channel = taskChannel(taskId);
                try {
                    if (taskResult.status) {
                        void this.eventBus.publish(
                            createBusEvent({
                                channel,
                                partitionKey: taskId,
                                cloud: {
                                    id: uuidv7(),
                                    type: 'task.status',
                                    source: `/tasks/${taskId}`,
                                    time: new Date().toISOString(),
                                    datacontenttype: 'application/json',
                                    data: {
                                        id: taskId,
                                        status: taskResult.status,
                                        final:
                                            taskResult.status.state === 'completed' ||
                                            taskResult.status.state === 'failed',
                                    },
                                },
                            })
                        );
                    }
                } catch {
                    /* noop */
                }
            }
        } catch (e) {
            try { console.error('[TaskEngine] resumeInput auto-resume failed:', e instanceof Error ? e.message : String(e), e instanceof Error ? e.stack : ''); } catch { }
        }
        return { acknowledged: true };
    }

    /**
     * Handle tool completion (placeholder): removes pending tool token and invokes durable handler if present.
     */
    async handleToolCompleted(params: { tenantId: string; taskId: string; token: string; result: unknown }): Promise<void> {
        const { tenantId, taskId, token, result } = params;
        const completedAt = new Date().toISOString();
        const terminalClaim = await coordinateToolTerminal({
            session: {
                load: (loadTenantId, sessionId) => this.sessionManager!.load(loadTenantId, sessionId),
                saveSnapshot: (saveParams) => this.sessionManager!.saveSnapshot(saveParams),
            },
            tenantId,
            taskId,
            token,
            result,
            completedAt,
        });
        if (terminalClaim.resumeEligible !== true || terminalClaim.observation === undefined) {
            if (terminalClaim.disposition === 'committed_detached') {
                try {
                    await this.sessionManager?.appendEvent(tenantId, taskId, 'task.tool_detached', {
                        token,
                        toolName: terminalClaim.entry?.name ?? terminalClaim.terminal?.toolName,
                        reason: terminalClaim.terminal?.reason,
                        detachedAt: terminalClaim.terminal?.claimedAt,
                    });
                } catch { /* diagnostic only */ }
            }
            if (terminalClaim.lateCompletion) {
                try {
                    await this.sessionManager?.appendEvent(tenantId, taskId, 'task.tool_late_completion', {
                        token,
                        toolName: terminalClaim.entry?.name ?? terminalClaim.terminal?.toolName,
                        completedAt,
                        resultPreview: makeSafeEventPreview(result),
                    });
                } catch { /* diagnostic only */ }
            }
            return;
        }
        const entry = terminalClaim.entry;
        const next = terminalClaim.snapshot;
        const terminalSnapshot = await this.sessionManager?.load(tenantId, taskId);
        const agentName = terminalSnapshot?.agentId ?? (next as any)?.meta?.agentId;
        const toolCompletedPayload = { token, toolName: entry?.name, resultPreview: makeSafeEventPreview(result) };
        const toolCompletedEvent = await this.sessionManager?.appendEvent(tenantId, taskId, 'task.tool_completed', toolCompletedPayload);
        if (toolCompletedEvent) {
            const [runtimeEvent] = mapWorkingMemoryEventToRuntimeStream({
                eventId: toolCompletedEvent.eventId,
                seq: toolCompletedEvent.seq,
                type: 'task.tool_completed',
                payload: toolCompletedPayload,
                createdAt: new Date().toISOString(),
            }, {
                taskId,
                tenantId,
                agentId: agentName,
            });
            if (runtimeEvent) {
                void this.eventBus.publish(createBusEvent({
                    channel: taskChannel(taskId),
                    cloud: {
                        id: runtimeEvent.id,
                        type: runtimeEvent.type,
                        source: `/tasks/${taskId}`,
                        time: runtimeEvent.ts,
                        datacontenttype: 'application/json',
                        data: runtimeEvent,
                    },
                }));
            }
        }

        const resume = {
            tenantId,
            taskId,
            agentId: agentName,
            idempotencyKey: `${taskId}:tool:${token}`,
            event: { kind: 'tool' as const, token, result },
        };
        if (isSyncRuntimeDriver(this.runtimeDriver)) {
            await this.runtimeDriver.enqueueResumeSync(resume);
        } else {
            await this.runtimeDriver.enqueueResume(resume);
        }
    }

    /**
     * Handle external event occurrence: removes pending event token and invokes durable handler if present.
     */
    async handleExternalEventOccurred(params: { tenantId: string; taskId: string; token: string; payload: unknown }): Promise<void> {
        const { tenantId, taskId, token, payload } = params;
        const snap = await this.sessionManager?.load(tenantId, taskId);
        if (!snap) return;
        const base = (snap.snapshot as Record<string, unknown>) || {};
        const events = getPendingExternalEvents(base) as any;
        const entry = events[token];

        const agentName = (snap as any)?.agentId ?? (base as any)?.meta?.agentId;
        const eventPlugin = agentName ? PluginManager.findAgent(agentName) : null;
        if ((eventPlugin?.resolved.runtimeManifest.runMode ?? 'loop') !== 'legacy') {
            const resume = {
                tenantId,
                taskId,
                agentId: agentName,
                idempotencyKey: `${taskId}:external:${token}`,
                event: {
                    kind: 'external' as const,
                    token,
                    type: entry?.type ?? 'external',
                    data: payload,
                },
            };
            if (isSyncRuntimeDriver(this.runtimeDriver)) {
                await this.runtimeDriver.enqueueResumeSync(resume);
            } else {
                await this.runtimeDriver.enqueueResume(resume);
            }
            return;
        }

        if (!entry) return;

        delete events[token];
        const next = setPendingExternalEvents(base, events) as Record<string, unknown>;
        const externalObservation: EngineObservation = {
            source: 'env',
            kind: 'external.event',
            payload: { token, payload, type: entry?.type },
            provenance: {
                ts: Date.now(),
                turn: Number((base as any)?.meta?.turn ?? 0) + 1,
                id: token,
                correlationId: token
            }
        };
        (next as any).inbox = InboxManager.addObservationToInbox((next as any).inbox, externalObservation);
        await this.sessionManager?.saveSnapshot({ tenantId, sessionId: taskId, agentId: (base as any)?.meta?.agentId || 'default', expectedWmVersion: snap.wmVersion ?? BigInt(0), snapshot: next });
        await this.sessionManager?.appendEvent(tenantId, taskId, 'task.external_event_registered', { token, type: entry?.type });
        // Always auto-resume one loop turn to consume the external event
        try {
            const ctx = this.createContext(
                { id: taskId, input: {} },
                {
                    tenantId,
                    ...(agentName !== undefined ? { agentId: agentName } : {}),
                }
            );
            (ctx as any).tenantId = tenantId; if (agentName) (ctx as any).agentId = agentName;

            const snapNow = await this.sessionManager!.load(tenantId, taskId);
            const baseNow = (snapNow?.snapshot as Record<string, unknown>) || {};
            const M: MentalState = (baseNow as any).M as MentalState || initialM(ctx);
            // Attach and restore LLM before running loop
            await this.attachAndRestoreLLM(ctx, agentName, M);

            const taskResult = await this.runPreparedTurnThroughDriver({
                    operation: 'resume',
                    tenantId,
                    taskId,
                    agentId: agentName,
                    idempotencyKey: `${taskId}:external:${token}`,
                    resumeEvent: {
                        kind: 'external',
                        token,
                        type: entry?.type ?? 'external',
                        data: payload,
                    },
                    ctx,
                    turnParams: {
                        tenantId,
                        sessionId: taskId,
                        trigger: 'event',
                        eventToken: token,
                        eventType: entry?.type,
                        eventPayload: payload,
                        isStreaming: false,
                    },
                    initialM: M,
                    snapshot: baseNow,
                });

            const channel = taskChannel(taskId);
            try {
                if (taskResult.status) {
                    void this.eventBus.publish(
                        createBusEvent({
                            channel,
                            partitionKey: taskId,
                            cloud: {
                                id: uuidv7(),
                                type: 'task.status',
                                source: `/tasks/${taskId}`,
                                time: new Date().toISOString(),
                                datacontenttype: 'application/json',
                                data: {
                                    id: taskId,
                                    status: taskResult.status,
                                    final:
                                        taskResult.status.state === 'completed' ||
                                        taskResult.status.state === 'failed',
                                },
                            },
                        })
                    );
                }
            } catch {
                /* noop */
            }
        } catch { }
    }

    /**
     * Stage child completion observation synchronously in the inbox.
     * This ensures the observation is available when the parent resumes, even for synchronous completions.
     */
    async stageChildCompletionObservation(params: { tenantId: string; parentTaskId: string; childToken?: string; childTaskId?: string; result: unknown; childAgentId?: string }): Promise<void> {
        const { tenantId, parentTaskId, childToken, childTaskId, result, childAgentId } = params;
        const snap = await this.sessionManager?.load(tenantId, parentTaskId);
        if (!snap || !this.sessionManager) return;
        const base = (snap.snapshot as Record<string, unknown>) || {};
        const tasks = getPendingTasks(base);
        const token = resolveChildToken(base, tasks, childToken, childTaskId);
        if (!token) return;
        const cleanChildResult = TaskStateUtils.extractCleanChildResult(result);
        const a2aTelemetry = readA2aResultTelemetry(result);
        const childExecutionMetadata = {
            ...(cleanChildResult.executionMetadata ?? {}),
            ...(a2aTelemetry?.executionOrigin ? { origin: a2aTelemetry.executionOrigin } : {}),
        };
        const stagingPrisma = this.getSessionStorePrisma();
        const childResultForParent = await prepareChildResultForPersistence(
            cleanChildResult.result,
            stagingPrisma ? new AgentResultCache(stagingPrisma) : undefined,
            tenantId
        );
        await coordinateChildTerminal({
            session: this.sessionManager,
            tenantId,
            parentTaskId,
            deliveryMode: 'inline',
            runtimeSurface: this.runtimeDriver.surface ?? 'in_process',
            request: {
                kind: 'completed',
                token,
                completedAt: new Date().toISOString(),
                childTaskId: cleanChildResult.childTaskId || childTaskId || token,
                agentId: childAgentId,
                result: childResultForParent,
                executionMetadata: Object.keys(childExecutionMetadata).length > 0
                    ? childExecutionMetadata as any
                    : undefined,
            },
        });
    }

    /**
     * Route child completion to parent's durable handler using pending task mappings.
     * Provide either childToken (preferred correlation) or childTaskId.
     */
    async handleChildCompleted(params: { tenantId: string; parentTaskId: string; childToken?: string; childTaskId?: string; result: unknown; childAgentId?: string; childTerminalIdentity?: ChildTerminalIdentity }): Promise<void> {
        const { tenantId, parentTaskId, childToken, childTaskId, result, childAgentId, childTerminalIdentity } = params;
        const completionReceivedAt = new Date().toISOString();
            const snap = await this.sessionManager?.load(tenantId, parentTaskId);
            if (!snap) return;
            const base = (snap.snapshot as Record<string, unknown>) || {};
            const tasks = getPendingTasks(base);
            const token = resolveChildToken(base, tasks, childToken, childTaskId);
            if (!token) return;
            const entry = tasks[token] as any;
            // Extract clean result from potentially wrapped TaskEntity
            // This fixes the confusing nested structure where result might be a TaskEntity wrapper
            const cleanChildResult = TaskStateUtils.extractCleanChildResult(result);
            const a2aTelemetry = readA2aResultTelemetry(result);
            const childExecutionMetadata = {
                ...(cleanChildResult.executionMetadata ?? {}),
                ...(a2aTelemetry?.executionOrigin ? { origin: a2aTelemetry.executionOrigin } : {}),
            };
            const parentPrisma = this.getSessionStorePrisma();
            const parentArtifactCache = parentPrisma ? new AgentResultCache(parentPrisma) : undefined;
            const childResultForParent = await prepareChildResultForPersistence(
                cleanChildResult.result,
                parentArtifactCache,
                tenantId
            );
            if (parentArtifactCache && childResultForParent && typeof childResultForParent === 'object') {
                log.debug('hydrating child result in handleChildCompleted', { parentTaskId, token });
                ArtifactHydrationService.tryHydrateChildResult(childResultForParent, parentArtifactCache, tenantId);
            }
            const completionRequest = {
                kind: 'completed' as const,
                token,
                completedAt: completionReceivedAt,
                childTaskId: cleanChildResult.childTaskId || childTaskId || token,
                agentId: childAgentId,
                result: childResultForParent,
                executionMetadata: Object.keys(childExecutionMetadata).length > 0
                    ? childExecutionMetadata as any
                    : undefined,
                ...(childTerminalIdentity !== undefined ? { terminalIdentity: childTerminalIdentity } : {}),
            };
            const terminalClaim = await coordinateChildTerminal({
                session: this.sessionManager!,
                tenantId,
                parentTaskId,
                deliveryMode: 'async_wake',
                runtimeSurface: this.runtimeDriver.surface ?? 'in_process',
                request: completionRequest,
            });
            if ((terminalClaim.publicationDisposition !== 'new_delivery' &&
                terminalClaim.publicationDisposition !== 'matching_replay') || terminalClaim.observation === undefined) {
                return;
            }
            const childObservation = terminalClaim.observation;
            log.debug('Appending child completion event', {
                parentTaskId,
                token,
                resultStatus: (result as any)?.status,
            });
            const parentAgentId = (snap as any)?.agentId || (base as any)?.meta?.agentId || 'default';
            await this.runtimeDriver.cancelTimer?.({ tenantId, taskId: parentTaskId, token });

            const durableChildPayload = childObservation.payload as {
                childTaskId?: string;
                agentId?: string;
                result?: unknown;
                executionMetadata?: unknown;
            };
            const durableChildResult = durableChildPayload.result;
            if (terminalClaim.disposition === 'committed' && this.handlerInvoker) {
                if (entry?.handlers?.completed !== undefined) {
                    await this.handlerInvoker.invoke({
                        tenantId,
                        taskId: parentTaskId,
                        handlerName: entry.handlers.completed,
                        input: durableChildResult,
                    });
                }
                for (const intent of terminalClaim.groupIntents ?? []) {
                    if (intent.handler !== undefined) {
                        await this.handlerInvoker.invoke({
                            tenantId,
                            taskId: parentTaskId,
                            handlerName: intent.handler,
                            input: intent.results,
                        });
                    }
                }
            }
            const childCompletedPayload = {
                token,
                childTaskId: durableChildPayload.childTaskId || cleanChildResult.childTaskId || childTaskId || token,
                agentId: durableChildPayload.agentId ?? childAgentId,
                result: durableChildResult,
                executionMetadata: durableChildPayload.executionMetadata,
                resultPreview: makeSafeEventPreview(durableChildResult),
            };
            if (terminalClaim.kind === 'failed') {
                const terminalError = terminalClaim.terminal?.error ?? {
                    code: 'CHILD_FAILED',
                    message: 'Child failed while completing.',
                };
                const failedResume = {
                    tenantId,
                    taskId: parentTaskId,
                    agentId: parentAgentId,
                    token,
                    idempotencyKey: `${parentTaskId}:child:${token}`,
                    event: {
                        kind: 'child' as const,
                        token,
                        childTaskId: childCompletedPayload.childTaskId,
                        outcome: 'failed' as const,
                        error: terminalError,
                        completedAt: completionReceivedAt,
                        terminalClaimed: true,
                    },
                };
                if (isSyncRuntimeDriver(this.runtimeDriver)) {
                    await this.runtimeDriver.enqueueResumeSync(failedResume);
                } else {
                    await this.runtimeDriver.enqueueResume(failedResume);
                }
                return;
            }

            const completedResume = {
                tenantId,
                taskId: parentTaskId,
                agentId: parentAgentId,
                token,
                idempotencyKey: `${parentTaskId}:child:${token}`,
                event: {
                    kind: 'child' as const,
                    token,
                    childTaskId: childCompletedPayload.childTaskId,
                    outcome: 'completed' as const,
                    output: durableChildResult,
                    completedAt: completionReceivedAt,
                    terminalClaimed: true,
                },
            };
            if (isSyncRuntimeDriver(this.runtimeDriver)) {
                await this.runtimeDriver.enqueueResumeSync(completedResume);
            } else {
                await this.runtimeDriver.enqueueResume(completedResume);
            }

    }

    /**
     * Route child input-required to parent's durable handler.
     */
    async handleChildInputRequired(params: { tenantId: string; parentTaskId: string; childToken?: string; childTaskId?: string; prompt: string; schema?: unknown; childOnProvided?: string; childInputToken?: string }): Promise<void> {
        const { tenantId, parentTaskId, childToken, childTaskId, prompt, schema, childOnProvided, childInputToken } = params;
        const snap = await this.sessionManager?.load(tenantId, parentTaskId);
        if (!snap) return;
        const base = (snap.snapshot as Record<string, unknown>) || {};
        const tasks = getPendingTasks(base);
        const token = resolveChildToken(base, tasks, childToken, childTaskId);
        if (!token) return;
        const entry = tasks[token] as any;
        const alreadyDelivered = !!entry?.deliveredInput;
        const handlerName = entry?.handlers?.inputRequired;

        // Handle automatic token and stage management if options are set
        if (entry?.options) {
            await reconcileSnapshotMutation({
                session: this.sessionManager!,
                tenantId,
                sessionId: parentTaskId,
                operation: 'child.input_required.control',
                mutate: ({ snapshot }) => {
                    let parentBase = snapshot;
                    const childTokenPath = entry.options.tokenPath ?? 'child.token';
                    if (entry.options.setToken && token) {
                        parentBase = TaskStateUtils.applyControlVarToSnapshot(parentBase, childTokenPath, token);
                    }
                    if (entry.options.setStage) {
                        parentBase = TaskStateUtils.applyControlVarToSnapshot(parentBase, 'stage', entry.options.setStage);
                    }
                    return { kind: 'write', snapshot: parentBase, value: undefined };
                },
            });
        }

        const childInputRequiredPayload = {
            token,
            childTaskId,
            agentId: (entry as { target?: string } | undefined)?.target,
            prompt,
            schema,
            childOnProvided,
            childInputToken,
        };
        const childInputRequiredEvent = await this.sessionManager?.appendEvent(tenantId, parentTaskId, 'task.child_input_required', childInputRequiredPayload);
        if (childInputRequiredEvent) {
            const [runtimeEvent] = mapWorkingMemoryEventToRuntimeStream({
                eventId: childInputRequiredEvent.eventId,
                seq: childInputRequiredEvent.seq,
                type: 'task.child_input_required',
                payload: childInputRequiredPayload,
                createdAt: new Date().toISOString(),
            }, {
                taskId: parentTaskId,
                tenantId,
                agentId: (base as { meta?: { agentId?: string } })?.meta?.agentId,
            });
            if (runtimeEvent) {
                void this.eventBus.publish(createBusEvent({
                    channel: taskChannel(parentTaskId),
                    cloud: {
                        id: runtimeEvent.id,
                        type: runtimeEvent.type,
                        source: `/tasks/${parentTaskId}`,
                        time: runtimeEvent.ts,
                        datacontenttype: 'application/json',
                        data: runtimeEvent,
                    },
                }));
            }
        }
        try { log.debug('Child input required processing', { token, handlerName, childOnProvided, childTaskId }); } catch { }
        if (!alreadyDelivered && handlerName && this.handlerInvoker) {
            log.debug('Invoking parent handler', { handlerName, token });
            const maybe = await this.handlerInvoker.invoke({ tenantId, taskId: parentTaskId, handlerName, input: { prompt, schema, token, childTaskId } });
            log.debug('Parent handler completed', { handlerName, hasResult: maybe !== undefined });
            if (typeof maybe !== 'undefined') {
                // Parent provided immediate answer; first try to invoke child's onProvided if available
                let finalChildResult: unknown = maybe;
                try {
                    const effectiveChildOnProvided = childOnProvided || (entry?.pendingInput?.childOnProvided as string | undefined);
                    if (effectiveChildOnProvided && childTaskId && this.handlerInvoker) {
                        log.debug('Invoking child onProvided', { childOnProvided: effectiveChildOnProvided, childTaskId });
                        try {
                            const _childResult = await this.handlerInvoker.invoke({ tenantId, taskId: childTaskId, handlerName: effectiveChildOnProvided, input: maybe });
                            log.debug('Child onProvided completed', { childTaskId, hasResult: _childResult !== undefined });
                            if (typeof _childResult !== 'undefined') {
                                finalChildResult = _childResult;
                            }
                        } catch (err) {
                            try { log.warn('Handler not found or error invoking child onProvided', { childOnProvided: effectiveChildOnProvided, error: err instanceof Error ? err.message : String(err) }); } catch { }
                        }
                    }
                } catch (e) {
                    // If invoking child's handler fails, fall back to using parent's value
                    try { log.debug('Child onProvided invocation failed; using parent value', { error: (e as Error).message }); } catch { }
                }
                // Resume the child loop once with env.input so it processes the provided value inside its own loop
                if (childTaskId && childInputToken) {
                    try {
                        await this.resumeInput({ tenantId, taskId: childTaskId, token: childInputToken, input: finalChildResult });
                        try { console.log(`[TaskEngine] resumed child '${childTaskId}' with input token=${childInputToken}`); } catch { }
                    } catch (err) {
                        try { console.warn(`[TaskEngine] resumeInput failed for childTaskId=${childTaskId}:`, err instanceof Error ? err.message : String(err)); } catch { }
                    }
                }
                try { console.log(`[TaskEngine] routing child completed to parent (token=${token}) result=${JSON.stringify(finalChildResult)}`); } catch { }
                await this.handleChildCompleted({ tenantId, parentTaskId, childToken: token, result: finalChildResult });
            }
            // mark delivered
            await reconcileSnapshotMutation({
                session: this.sessionManager!,
                tenantId,
                sessionId: parentTaskId,
                operation: 'child.input_required.delivered',
                mutate: ({ snapshot }) => {
                    const tasks3 = getPendingTasks(snapshot) as any;
                    if (!tasks3[token]) return { kind: 'noop', value: undefined };
                    tasks3[token].deliveredInput = true;
                    return {
                        kind: 'write',
                        snapshot: setPendingTasks(snapshot, tasks3),
                        value: undefined,
                    };
                },
            });
        }
        // If handler is not yet registered, persist pending input so it can be routed once handler is added
        if (!handlerName && !alreadyDelivered) {
            await reconcileSnapshotMutation({
                session: this.sessionManager!,
                tenantId,
                sessionId: parentTaskId,
                operation: 'child.input_required.pending',
                mutate: ({ snapshot }) => {
                    const tasks2 = getPendingTasks(snapshot) as any;
                    if (!tasks2[token]) return { kind: 'noop', value: undefined };
                    tasks2[token].pendingInput = { prompt, schema, childTaskId, childOnProvided };
                    return {
                        kind: 'write',
                        snapshot: setPendingTasks(snapshot, tasks2),
                        value: undefined,
                    };
                },
            });
        }
    }

    /**
     * Route child failure to parent's durable handler and update group aggregations.
     */
    async handleChildFailed(params: { tenantId: string; parentTaskId: string; childToken?: string; childTaskId?: string; error: unknown; childTerminalIdentity?: ChildTerminalIdentity }): Promise<void> {
        const { tenantId, parentTaskId, childToken, childTaskId, error, childTerminalIdentity } = params;
        const snap = await this.sessionManager?.load(tenantId, parentTaskId);
        if (!snap) return;
        const base = (snap.snapshot as Record<string, unknown>) || {};
        const tasks = getPendingTasks(base);
        const token = resolveChildToken(base, tasks, childToken, childTaskId);
        if (!token) return;
        const entry = tasks[token];
        const handlerName = entry?.handlers?.failed;
        const rawError = error instanceof Error
            ? { code: error.name || 'CHILD_FAILED', message: error.message }
            : error !== null && typeof error === 'object' && !Array.isArray(error)
              ? {
                    code: typeof (error as any).code === 'string' ? (error as any).code : 'CHILD_FAILED',
                    message: typeof (error as any).message === 'string' ? (error as any).message : String(error),
                    ...(typeof (error as any).timeoutMs === 'number'
                        ? { timeoutMs: (error as any).timeoutMs }
                        : {}),
                }
              : { code: 'CHILD_FAILED', message: String(error) };
        const failedAt = new Date().toISOString();
        const terminalClaim = await coordinateChildTerminal({
            session: this.sessionManager!,
            tenantId,
            parentTaskId,
            deliveryMode: 'async_wake',
            runtimeSurface: this.runtimeDriver.surface ?? 'in_process',
            request: {
                kind: 'failed',
                token,
                failedAt,
                childTaskId: childTaskId ?? entry?.childTaskId ?? token,
                agentId: entry?.agentId ?? entry?.target,
                error: rawError,
                ...(childTerminalIdentity !== undefined ? { terminalIdentity: childTerminalIdentity } : {}),
            },
        });
        if (terminalClaim.publicationDisposition !== 'new_delivery' &&
            terminalClaim.publicationDisposition !== 'matching_replay') return;
        const terminalError = terminalClaim.terminal?.error ?? rawError;
        if (terminalError.code === 'CHILD_TIMEOUT') {
            const timedOutChildTaskId = terminalClaim.terminal?.childTaskId ?? childTaskId ?? entry?.childTaskId;
            if (timedOutChildTaskId !== undefined) {
                await this.detachTaskBranch({
                    tenantId,
                    taskId: timedOutChildTaskId,
                    reason: 'child_timeout',
                });
            }
        }
        const resume = {
            tenantId,
            taskId: parentTaskId,
            agentId: (base as { meta?: { agentId?: string } })?.meta?.agentId ?? (snap as { agentId?: string }).agentId,
            token,
            idempotencyKey: `${parentTaskId}:child:${token}`,
            event: {
                kind: 'child' as const,
                token,
                childTaskId: terminalClaim.terminal?.childTaskId ?? childTaskId ?? entry?.childTaskId ?? token,
                outcome: 'failed' as const,
                error: terminalError,
                completedAt: failedAt,
                terminalClaimed: true,
            },
        };
        await this.runtimeDriver.cancelTimer?.({ tenantId, taskId: parentTaskId, token });
        if (isSyncRuntimeDriver(this.runtimeDriver)) {
            await this.runtimeDriver.enqueueResumeSync(resume);
        } else {
            await this.runtimeDriver.enqueueResume(resume);
        }
        if (terminalClaim.disposition !== 'committed') return;
        if (handlerName && this.handlerInvoker) {
            await this.handlerInvoker.invoke({ tenantId, taskId: parentTaskId, handlerName, input: error });
        }
        if (this.handlerInvoker) {
            for (const intent of terminalClaim.groupIntents ?? []) {
                if (intent.handler !== undefined) {
                    await this.handlerInvoker.invoke({
                        tenantId,
                        taskId: parentTaskId,
                        handlerName: intent.handler,
                        input: intent.results,
                    });
                }
            }
        }
    }

    /**
     * Execute the task handler
     * In a real implementation, this would find and call the correct agent plugin
     */
    private async executeTaskHandler(ctx: TaskContext): Promise<void> {
        // 1. Try agent-scoped handleTask first
        const agentId = (ctx as any).agentId;
        if (agentId) {
            try {
                const { PluginManager } = await import('../plugin/pluginManager.js');
                const plugin = PluginManager.findAgent(agentId);
                if (plugin && typeof (plugin as any).handleTask === 'function') {
                    (ctx as any).logger?.info?.('TaskEngine.executeTaskHandler: invoking agent-scoped handleTask', { agentId, taskId: ctx.task.id });
                    await (plugin as any).handleTask(ctx, { input: ctx.task.input });
                    (ctx as any).logger?.info?.('TaskEngine.executeTaskHandler: agent-scoped handleTask returned', { agentId, taskId: ctx.task.id });
                    return;
                }
            } catch (err) {
                (ctx as any).logger?.error?.('TaskEngine.executeTaskHandler: agent-scoped handleTask failed', { taskId: ctx.task.id, error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
                // If the agent-scoped handler explicitly failed, don't fall back to global registry
                throw err;
            }
        }

        // 2. Fallback to durable 'handleTask' if registered in global registry
        try {
            (ctx as any).logger?.info?.('TaskEngine.executeTaskHandler: invoking durable handler handleTask from registry', { taskId: ctx.task.id });
            const { invokeHandler } = await import('./HandlerRegistry.js');
            await invokeHandler('handleTask', ctx, {
                input: ctx.task.input
            });
            (ctx as any).logger?.info?.('TaskEngine.executeTaskHandler: durable handleTask returned', { taskId: ctx.task.id });
            return;
        } catch (err) {
            // Fallback: placeholder
            const traceId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            if (err instanceof Error && err.message.includes('HANDLER_NOT_FOUND')) {
                (ctx as any).logger?.warn?.('TaskEngine.executeTaskHandler: no registered handleTask found, and no agent-scoped handler available', { taskId: ctx.task.id });
            } else {
                (ctx as any).logger?.error?.('TaskEngine.executeTaskHandler: durable handler invocation failed', { taskId: ctx.task.id, traceId, error: err instanceof Error ? err.message : String(err) });
            }
            console.log('Executing task handler (placeholder):', ctx.task.id);
        }
    }

    /**
     * Helper to attach and restore LLM for a context from persisted MentalState
     */
    private async attachAndRestoreLLM(ctx: TaskContext, agentName: string | undefined, M: MentalState | undefined, baseSnap?: Record<string, unknown>): Promise<void> {
        if (TaskEngine.testOverrides?.attachAndRestoreLLM) {
            return TaskEngine.testOverrides.attachAndRestoreLLM(ctx, agentName, M, baseSnap);
        }
        if (!agentName) return;

        try {
            const { PluginManager } = await import('../plugin/pluginManager.js');
            const plugin = PluginManager.findAgent(agentName);

            // Create/attach LLM
            if (plugin?.llmAdapter) {
                (ctx as any).llm = plugin.llmAdapter;
            } else if (plugin?.llmConfig) {
                const { createLLMForTask } = await import('../llm/LLMFactory.js');
                (ctx as any).llm = createLLMForTask(plugin.llmConfig, ctx as any);
            }

            // Restore/Clear LLM conversation state if available
            if (M) {
                try {
                    const llmAny = (ctx as any).llm as any;
                    const historyMode = (typeof llmAny?.getHistoryMode === 'function') ? llmAny.getHistoryMode() : 'full';

                    if (historyMode === 'stateless') {
                        if (typeof llmAny?.clearHistory === 'function') {
                            llmAny.clearHistory();
                            try { console.log('[TaskEngine] Cleared LLM history (stateless mode) for', agentName); } catch { }
                        }
                    } else {
                        // Pass snapshot explicitly to grab llmState
                        const finalLlmState = (baseSnap as Snapshot)?.llmState;

                        if (typeof finalLlmState !== 'undefined' && llmAny?.importState) {
                            llmAny.importState(finalLlmState);
                            try { console.log('[TaskEngine] Restored LLM history for', agentName); } catch { }
                        }
                    }
                } catch (e) {
                    try { console.log('[TaskEngine] Failed to restore/clear LLM state for', agentName, e); } catch { }
                }
            }
        } catch (e) {
            try { console.log('[TaskEngine] Failed to attach LLM for', agentName, e); } catch { }
        }
    }

    /**
     * Create a basic task context
     */
    private createContext(
        task: TaskEntity,
        binding?: RuntimeContextBinding
    ): TaskContext {
        // This is a simplified version - a real implementation would
        // inject all required dependencies like LLM, tools, etc.
        const ctx: TaskContext = {
            tenantId: binding?.tenantId ?? 'default',
            agentId: binding?.agentId ?? 'default',
            task: {
                id: task.id,
                input: task.input as TaskInput
            },
            artifacts: createArtifactFactory({
                tenantId: binding?.tenantId ?? 'default',
                resolveCache: () => {
                    const prisma = this.getSessionStorePrisma();
                    return prisma ? new AgentResultCache(prisma) : undefined;
                },
                onFailure: ({ operation, error, artifactId }) => {
                    log.error('Artifact factory operation failed', {
                        operation,
                        tenantId: binding?.tenantId ?? 'default',
                        taskId: task.id,
                        agentId: binding?.agentId ?? 'default',
                        artifactId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                },
            }),
            // These fail closed until the canonical turn finalizer installs the
            // real reply/progress transport.
            reply: async () => {
                throw new TaskReplyCapabilityUnavailableError(task.id);
            },
            progress: () => {
                throw new TaskReplyCapabilityUnavailableError(task.id);
            },
            complete: () => { },
            fail: async () => { },
            // Add stub for recordUsage
            recordUsage: () => { console.warn('recordUsage called on base context'); },
            // Stub implementations for other required properties
            llm: {
                call: async () => [],
                stream: async function* () { },
                addToolResult: () => { },
                updateSettings: () => { }
            } as any,
            tools: {
                invoke: async <T>(toolName: string, args: unknown, options?: { onCompleted?: string; setToken?: boolean; setStage?: string }) => {
                    const { withSafety } = await import('../loop/effectSafety.js');
                    return withSafety(async () => ({} as unknown as T), { timeoutMs: 60000, maxRetries: 2 });
                }
            },
            memory: {
                semantic: {
                    getDefaultBackend: () => 'none',
                    setDefaultBackend: () => { },
                    backends: {},
                    getAtomic: () => undefined,
                    get: async () => null,
                    set: async () => { },
                    read: async () => [],
                    delete: async () => { },
                    remove: async () => 0,
                    recognize: async () => { throw new Error('Semantic memory recognition not available in basic task engine'); },
                    enrich: async () => { throw new Error('Semantic memory enrichment not available in basic task engine'); },
                    add: async () => { },
                    readItems: async () => [],
                    removeItem: async () => { },
                    removeItems: async () => ({ removedCount: 0 }),
                },
                episodic: {
                    getDefaultBackend: () => 'none',
                    setDefaultBackend: () => { },
                    backends: {},
                    append: async () => { },
                    getEvents: async () => [],
                    deleteEvent: async () => { },
                },
                embed: {
                    getDefaultBackend: () => 'none',
                    setDefaultBackend: () => { },
                    backends: {},
                    upsert: async () => { },
                    queryByVector: async () => [],
                    delete: async () => { },
                }
            },
            cognitive: {
                loadWorkingMemory: () => { },
                plan: async () => ({}),
                record: () => { },
                flush: async () => { }
            },
            config: {},
            validate: () => { },
            retry: async (fn) => fn(),
            cache: {
                get: async () => null,
                set: async () => { },
                delete: async () => { }
            },
            emitEvent: async () => { },
            updateStatus: () => { },
            services: { get: () => undefined },
            getEnv: () => undefined,
            throw: (code, message, detail, context) => {
                throwInvariantError(code as InvariantErrorCode, message, detail as InvariantErrorDetail, context);
            },

            sendTaskToAgent: async () => { throw new Error('A2A not available in basic task engine'); },
            requestInput: async () => { throw new Error('requestInput not available in basic task engine'); },
            requestTool: async () => { throw new Error('requestTool not available in basic task engine'); },

            // (legacy methods removed)
            // (legacy goals API removed)
            recall: async () => { throw new Error('Memory not available in basic task engine'); },
            remember: async () => { throw new Error('Memory not available in basic task engine'); }
        };

        // Attach auto-executor for requestTool({ awaitCompletion: false })
        (ctx as any).__autoExecuteTool = async (
            tId: string,
            sId: string,
            token: string,
            toolName: string,
            args: unknown,
            control?: { signal?: AbortSignal }
        ) => {
            try {
                let result: unknown;
                // Check if it's an MCP tool call (format: mcp:serverName.toolName)
                if (toolName.startsWith('mcp:')) {
                    const parts = toolName.slice(4).split('.');
                    if (parts.length >= 2) {
                        const serverName = parts[0];
                        const mcpToolName = parts.slice(1).join('.');
                        if (typeof (ctx as any).llm?.callMcpTool === 'function') {
                            result = await (ctx as any).llm.callMcpTool(
                                serverName,
                                mcpToolName,
                                args as any,
                                { signal: control?.signal }
                            );
                        } else {
                            throw new Error(`MCP execution not supported by current LLM adapter for tool: ${toolName}`);
                        }
                    } else {
                        throw new Error(`Invalid MCP tool name format: ${toolName}. Expected mcp:server.tool`);
                    }
                } else {
                    // Regular tool execution
                    result = await ctx.tools.invoke(toolName, args, { signal: control?.signal } as any);
                }

                // Feed result back into the engine using handleToolCompleted
                await this.handleToolCompleted({ tenantId: tId, taskId: sId, token, result });
            } catch (error) {
                // Return error object as the result so the agent sees the failure
                const errorResult = {
                    error: true,
                    message: error instanceof Error ? error.message : String(error)
                };
                await this.handleToolCompleted({ tenantId: tId, taskId: sId, token, result: errorResult });
            }
        };

        // ✅ FIX: Attach session manager reference for loop to reload inbox on await_child
        // This enables the synchronous child completion detection in loopRunner
        (ctx as any)._sessionManager = this.sessionManager;

        return ctx;
    }

    private async restoreCtx(tenantId: string, taskId: string): Promise<TaskContext> {
        const task: TaskEntity = { id: taskId, input: {} };
        const snap = await this.sessionManager?.load(tenantId, taskId);
        const agentName = snap?.agentId;
        const ctx = this.createContext(task, {
            tenantId,
            ...(agentName !== undefined ? { agentId: agentName } : {}),
        });
        (ctx as any).tenantId = tenantId;
        const baseSnap = (snap?.snapshot as Record<string, unknown>) || {};
        // Expose MentalState on durable handler context
        try {
            const M = (baseSnap as any).M as MentalState | undefined;
            (ctx as any).__mental = M || initialM(ctx);
            (ctx as any).M = (ctx as any).__mental; // readonly view for handlers
        } catch { /* noop */ }
        // Reattach LLM for this agent if available AND restore its conversation state
        try {
            if (agentName) {
                const { PluginManager } = await import('../plugin/pluginManager.js');
                const plugin = PluginManager.findAgent(agentName);
                if (plugin?.llmAdapter) {
                    (ctx as any).llm = plugin.llmAdapter;
                } else if (plugin?.llmConfig) {
                    const { createLLMForTask } = await import('../llm/LLMFactory.js');
                    (ctx as any).llm = createLLMForTask(plugin.llmConfig, ctx as any);
                }

                // Restore LLM state immediately after creating/attaching LLM
                try {
                    const llmAny = (ctx as any).llm as any;
                    const llmState = (baseSnap as Snapshot)?.llmState;

                    if (typeof llmState !== 'undefined' && llmAny?.importState) {
                        llmAny.importState(llmState);
                        try { console.log('[TaskEngine] restoreCtx restored LLM history'); } catch { }
                    }
                } catch (e) {
                    try { console.log('[TaskEngine] restoreCtx failed to restore LLM state', e); } catch { }
                }

                // ✅ FIX: Create memory registry with SQL backend for durable handler context
                // This ensures ctx.memory.semantic.backends is properly populated
                try {
                    const { createEmbeddingFunction, isEmbeddingAvailable } = await import('../llm/LLMFactory.js');
                    const embeddingFunction = isEmbeddingAvailable() ? await createEmbeddingFunction() : undefined;

                    // Get Prisma client from session manager or singleton
                    const { getMemoryPrismaClient } = await import('@a2arium/callagent-memory-engine');

                    // Only attempt to use SQL memory if we have a session prisma or a database URL is configured
                    const dbUrl = process.env.MEMORY_DATABASE_URL;
                    if (!dbUrl) throw new Error('MEMORY_DATABASE_URL is required for AgentResultCache');
                    const sessionPrisma = (this.sessionManager as any)?.store?.prisma;

                    if (sessionPrisma || dbUrl) {
                        const existingPrisma = sessionPrisma || await getMemoryPrismaClient();

                        const memoryRegistry = await createMemoryRegistry(
                            tenantId,
                            agentName,
                            ctx,
                            {
                                ...(existingPrisma ? { database: { prismaClient: existingPrisma } } : {}),
                                embeddingFunction
                            }
                        );

                        // Replace the stub memory object with the real one
                        (ctx as any).memory = memoryRegistry;

                        console.log('[TaskEngine] restoreCtx: Memory registry created with backends', {
                            agentName,
                            semanticBackends: Object.keys(memoryRegistry.semantic.backends),
                            hasSet: !!(memoryRegistry.semantic as any)?.set
                        });
                    } else {
                        try { console.log('[TaskEngine] restoreCtx: skipping memory registry initialization (no database config)'); } catch { }
                    }
                } catch (memErr) {
                    console.error('[TaskEngine] restoreCtx: Failed to create memory registry', {
                        error: memErr instanceof Error ? memErr.message : String(memErr),
                        agentName
                    });
                    // Keep the stub memory object if creation fails
                }
            }
            try { console.log('[TaskEngine] restoreCtx LLM type', (ctx as any).llm?.constructor?.name); } catch { }
        } catch { /* ignore LLM reattach failures */ }
        await this.apiBinder.attachOrchestrationAPIs(ctx, {
            tenantId,
            sessionId: taskId,
            agentId: (ctx as any).agentId || snap?.agentId || 'default',
            flushMentalState: async () => {
                await this.flushContextSnapshot(tenantId, taskId, (ctx as any).agentId || snap?.agentId || 'default', ctx);
            }
        });
        // Minimal namespaces for episodic, thoughts, world
        try {
            (ctx as any).episodic = {
                add: (e: any) => {
                    try {
                        const arr = ((((ctx as any).__mental?.memory as any)?.longTerm?.episodic) || []) as any[];
                        arr.push(e); (((ctx as any).__mental!.memory as any).longTerm as any).episodic = arr;
                    } catch { /* noop */ }
                }
            };
            (ctx as any).thoughts = { add: async (t: any) => { try { await (ctx as any).addThought(String((t?.text ?? t) || '')); } catch { /* noop */ } } };
            // Read-only world: deep clone so no shared refs; caller cannot mutate MentalState.worldModel
            const __mental = (ctx as Record<string, unknown>).__mental as { worldModel?: Record<string, unknown> } | undefined;
            const wm = __mental?.worldModel;
            (ctx as Record<string, unknown>).world = {
                read: (): Readonly<Record<string, unknown>> => {
                    if (!wm || typeof wm !== 'object') return Object.freeze({});
                    try {
                        const cloned = JSON.parse(JSON.stringify(wm)) as Record<string, unknown>;
                        return Object.freeze(cloned);
                    } catch {
                        return Object.freeze({ ...wm });
                    }
                }
            };
        } catch { /* noop */ }
        // LLM state restoration now happens immediately after LLM creation above (lines 1551-1564)
        // Ensure restored context can emit streaming events to the same task channel
        try {
            extendContextWithStreaming(ctx, true, this.eventBus);
        } catch {
            /* noop */
        }
        // Wire Goals API on durable handler context
        try {
            const goals = await import('../loop/goals.js');
            const baseCtx = ctx as TaskContext;
            type CtxWithLegacyGoalFns = TaskContext & {
                addGoal: (node: TaskContextGoalAddInput) => Promise<GoalId>;
                updateGoal: (id: GoalId, patch: TaskContextGoalUpdatePatch) => Promise<void>;
                moveGoal: (id: GoalId, parentId?: GoalId, order?: number) => Promise<void>;
                completeGoal: (
                    id: GoalId,
                    opts?: { cascadeChildren?: boolean; requireNoActiveChildren?: boolean }
                ) => Promise<void>;
                failGoal: (id: GoalId) => Promise<void>;
                listGoals: (filter?: TaskContextGoalsReadFilter) => Promise<GoalNode[]>;
            };
            const extended = baseCtx as CtxWithLegacyGoalFns;
            extended.addGoal = (node) => goals.addGoal(baseCtx, node);
            extended.updateGoal = (id, patch) => goals.updateGoal(baseCtx, id, patch);
            extended.moveGoal = (id, parentId, order) => goals.moveGoal(baseCtx, id, parentId, order);
            extended.completeGoal = (id, opts) => goals.completeGoal(baseCtx, id, opts);
            extended.failGoal = (id) => goals.failGoal(baseCtx, id);
            extended.listGoals = (filter) => goals.listGoals(baseCtx, filter);
            baseCtx.goals = {
                add: (g) => goals.addGoal(baseCtx, g),
                update: (id, patch) => goals.updateGoal(baseCtx, id, patch),
                remove: (id) => goals.failGoal(baseCtx, id),
                clear: async (predicate?: (g: GoalNode) => boolean) => {
                    const all = await goals.listGoals(baseCtx, {});
                    for (const g of all) {
                        if (!predicate || predicate(g)) await goals.failGoal(baseCtx, g.id);
                    }
                },
                read: (filter?: TaskContextGoalsReadFilter) => goals.listGoals(baseCtx, filter),
            };
        } catch { /* noop */ }
        try {
            bindRuntimeCognitionStream({
                ctx,
                eventBus: this.eventBus,
                tenantId,
                sessionId: taskId,
                agentId: (ctx as any).agentId || snap?.agentId || 'default',
            });
        } catch { /* noop */ }
        // Enable A2A from durable handler context - use the proper TaskEngine sendTaskToAgent implementation
        // NOTE: sendTaskToAgent is already defined in attachOrchestrationAPIs with the correct logic.
        // We do NOT need to override it here anymore.

        return ctx;
    }

    /**
     * Composition-root access to the scheduling driver (Phase 0.4).
     * Framework/worker bootstrap only — not for agent handlers.
     */
    getCompositionRuntimeDriver(): RuntimeDriver {
        return this.runtimeDriver;
    }

    /** In-process segment kernel — stable even when an outer driver wraps scheduling. */
    getCompositionTurnExecutor(): TurnExecutor {
        return this.compositionTurnExecutor;
    }

    /** Runtime-timer entrypoint for an autonomous, restart-safe root deadline. */
    async handleTaskRunTimeout(params: {
        tenantId: string;
        taskId: string;
        agentId?: string;
        token: string;
        dueAt: string;
        payload?: unknown;
    }): Promise<TaskRunTimeoutDisposition> {
        const inspection = await this.inspectAdmittedRootDeadline({
            tenantId: params.tenantId,
            taskId: params.taskId,
            expectedToken: params.token,
            expectedDueAt: params.dueAt,
        });
        if (inspection.disposition !== 'due') {
            const disposition = inspection.disposition === 'canceled'
                ? 'canceled'
                : inspection.disposition === 'terminal'
                  ? 'terminal'
                  : inspection.disposition === 'pending'
                    ? 'not_due'
                    : inspection.disposition === 'stale'
                      ? 'stale'
                      : 'missing';
            defaultMetricsRegistry.increment('task_run_timeout_total', { disposition });
            return disposition;
        }

        const deadline = inspection.deadline;
        await this.cancelTask({
            tenantId: params.tenantId,
            taskId: params.taskId,
            ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
            reason: 'active_run_timeout',
            metadata: {
                code: 'TASK_RUN_TIMEOUT',
                timeoutMs: deadline.timeoutMs,
                expiresAt: deadline.expiresAt,
            },
        });

        const after = await this.sessionManager!.load(params.tenantId, params.taskId);
        if (after === null) {
            throw new Error(`Task ${params.taskId} disappeared after its root timeout was claimed.`);
        }
        const terminalDisposition = this.taskRunTimeoutTerminalDisposition(
            (after.snapshot as Record<string, unknown> | undefined) ?? {},
            params.taskId
        );
        if (terminalDisposition === undefined) {
            throw new Error(`Task ${params.taskId} root timeout did not converge to durable terminality.`);
        }
        defaultMetricsRegistry.increment('task_run_timeout_total', {
            disposition: terminalDisposition,
        });
        return terminalDisposition;
    }

    private taskRunTimeoutTerminalDisposition(
        snapshot: Record<string, unknown>,
        taskId: string
    ): 'canceled' | 'terminal' | undefined {
        const status = terminalStatusFromSnapshot(snapshot, taskId);
        if (status === undefined) return undefined;
        const metadata = status.metadata as Record<string, unknown> | undefined;
        return status.state === 'canceled' && (
            metadata?.reason === 'active_run_timeout' || metadata?.code === 'TASK_RUN_TIMEOUT'
        )
            ? 'canceled'
            : 'terminal';
    }

    /**
     * Read task identity and time from one authoritative storage snapshot.
     * A no-op reconciliation is intentional: SQL loadForMutation supplies
     * PostgreSQL clock_timestamp() alongside the exact snapshot inspected.
     */
    private async inspectAdmittedRootDeadline(params: {
        tenantId: string;
        taskId: string;
        phase?: 'admission' | 'cas_replay' | 'duplicate_repair' | 'initial_segment';
        expectedToken?: string;
        expectedDueAt?: string;
    }): Promise<RootDeadlineInspection> {
        const inspected = await reconcileSnapshotMutation<RootDeadlineInspection>({
            session: this.sessionManager!,
            tenantId: params.tenantId,
            sessionId: params.taskId,
            operation: 'task.run_deadline.inspect',
            mutate: ({ exists, snapshot, storageNow }) => {
                if (!exists) {
                    return { kind: 'noop' as const, value: { disposition: 'missing' as const } };
                }
                const submission = readTaskSubmissionMetadata(snapshot);
                if (submission === undefined || submission.options.taskRunTimeoutMs === undefined) {
                    return { kind: 'noop' as const, value: { disposition: 'none' as const } };
                }
                if (params.phase === 'initial_segment' && submission.firstClaimedAt !== undefined) {
                    return { kind: 'noop' as const, value: { disposition: 'claimed' as const } };
                }

                const taskRunTimeoutMs = submission.options.taskRunTimeoutMs;
                const deadline = readRootRunDeadline(snapshot);
                const admittedAtMs = Date.parse(submission.admittedAt);
                const expectedExpiresAt = new Date(admittedAtMs + taskRunTimeoutMs).toISOString();
                if (
                    deadline === undefined ||
                    deadline.timeoutMs !== taskRunTimeoutMs ||
                    deadline.startedAt !== submission.admittedAt ||
                    deadline.expiresAt !== expectedExpiresAt ||
                    deadline.source !== 'task_submission' ||
                    deadline.timerToken !== 'root-run-timeout'
                ) {
                    throw new TaskSubmissionError(
                        'TASK_SUBMISSION_STATE_INVALID',
                        'stored task submission deadline is missing or inconsistent'
                    );
                }
                if (
                    (params.expectedToken !== undefined && params.expectedToken !== deadline.timerToken) ||
                    (params.expectedDueAt !== undefined && params.expectedDueAt !== deadline.expiresAt)
                ) {
                    return { kind: 'noop' as const, value: { disposition: 'stale' as const } };
                }

                const terminalDisposition = this.taskRunTimeoutTerminalDisposition(
                    snapshot,
                    params.taskId
                );
                if (terminalDisposition !== undefined) {
                    return {
                        kind: 'noop' as const,
                        value: { disposition: terminalDisposition },
                    };
                }
                const storageNowMs = Date.parse(storageNow);
                if (!Number.isFinite(storageNowMs)) {
                    throw new Error('TASK_RUN_DEADLINE_STORAGE_CLOCK_INVALID');
                }
                return {
                    kind: 'noop' as const,
                    value: {
                        disposition: storageNowMs >= Date.parse(deadline.expiresAt)
                            ? 'due' as const
                            : 'pending' as const,
                        deadline,
                    },
                };
            },
        });
        return inspected.value;
    }

    /**
     * Establish or enforce the immutable deadline attached by durable root
     * admission. The authoritative snapshot supplies both identity and time;
     * callers never derive a replacement deadline from their local clock.
     */
    private async ensureAdmittedRootDeadline(params: {
        tenantId: string;
        taskId: string;
        agentId?: string;
        snapshot: Record<string, unknown>;
        phase: 'admission' | 'cas_replay' | 'duplicate_repair' | 'initial_segment';
    }): Promise<'none' | 'scheduled' | 'unavailable' | 'terminal' | 'canceled'> {
        const inspection = await this.inspectAdmittedRootDeadline({
            tenantId: params.tenantId,
            taskId: params.taskId,
            phase: params.phase,
        });
        if (
            inspection.disposition === 'none' ||
            inspection.disposition === 'claimed' ||
            inspection.disposition === 'missing'
        ) {
            return 'none';
        }
        if (inspection.disposition === 'terminal' || inspection.disposition === 'canceled') {
            return inspection.disposition;
        }
        if (inspection.disposition === 'stale') {
            throw new TaskSubmissionError(
                'TASK_SUBMISSION_STATE_INVALID',
                'stored task submission deadline changed while it was being inspected'
            );
        }
        if (!('deadline' in inspection)) {
            throw new TaskSubmissionError(
                'TASK_SUBMISSION_STATE_INVALID',
                'stored task submission deadline could not be classified'
            );
        }

        const deadline = inspection.deadline;
        if (inspection.disposition === 'due') {
            const timeoutDisposition = await this.handleTaskRunTimeout({
                tenantId: params.tenantId,
                taskId: params.taskId,
                ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
                token: deadline.timerToken,
                dueAt: deadline.expiresAt,
                payload: {
                    code: 'TASK_RUN_TIMEOUT',
                    timeoutMs: deadline.timeoutMs,
                    expiresAt: deadline.expiresAt,
                },
            });
            defaultMetricsRegistry.increment('task_run_deadline_registration_total', {
                phase: params.phase,
                disposition: timeoutDisposition,
            });
            if (timeoutDisposition === 'canceled' || timeoutDisposition === 'terminal') {
                return timeoutDisposition;
            }
        }

        const scheduled = await this.ensureRootRunDeadlineTimer({
            tenantId: params.tenantId,
            taskId: params.taskId,
            ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
            deadline,
        });
        defaultMetricsRegistry.increment('task_run_deadline_registration_total', {
            phase: params.phase,
            disposition: scheduled ? 'scheduled' : 'unavailable',
        });
        return scheduled ? 'scheduled' : 'unavailable';
    }

    private async ensureRootRunDeadlineTimer(params: {
        tenantId: string;
        taskId: string;
        agentId?: string;
        deadline: RootRunDeadline;
    }): Promise<boolean> {
        try {
            await this.runtimeDriver.scheduleTimer({
                tenantId: params.tenantId,
                taskId: params.taskId,
                ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
                token: params.deadline.timerToken,
                fireAt: params.deadline.expiresAt,
                kind: 'task_run_timeout',
                payload: {
                    code: 'TASK_RUN_TIMEOUT',
                    timeoutMs: params.deadline.timeoutMs,
                    expiresAt: params.deadline.expiresAt,
                },
                idempotencyKey: `${params.taskId}:task-run-timeout:${params.deadline.expiresAt}`,
            });
            return true;
        } catch (error) {
            log.warn('Root run deadline timer scheduling failed; lifecycle observer will retry', {
                tenantId: params.tenantId,
                taskId: params.taskId,
                error: error instanceof Error ? error.message : String(error),
            });
            return false;
        }
    }

    private async ensureTaskTerminalPublished(params: {
        tenantId: string;
        taskId: string;
        agentId?: string;
        snapshot: Record<string, unknown>;
    }): Promise<void> {
        const terminal = readDurableTaskTerminal(params.snapshot);
        if (terminal === undefined || terminal.enqueuedAt !== undefined) return;
        const terminalEventPayload = {
            taskId: params.taskId,
            ...(params.agentId ? { agentId: params.agentId } : {}),
            deliveryKey: terminal.deliveryKey,
            authoritativeTerminal: true,
            ...(terminal.turnClaim ? {
                attemptKey: terminal.turnClaim.attemptKey ?? `claim:${terminal.turnClaim.claimId}`,
                claimId: terminal.turnClaim.claimId,
                fence: terminal.turnClaim.fence,
                claimedGeneration: terminal.turnClaim.generation,
                turnSeq: terminal.turnClaim.turnSeq,
            } : {}),
            ...(terminal.status.metadata?.reason !== undefined
                ? { reason: terminal.status.metadata.reason }
                : {}),
        };
        try {
            const terminalEventType = `task.${terminal.state}`;
            const existingEvents = await this.sessionManager!.listEventsSince({
                tenantId: params.tenantId,
                sessionId: params.taskId,
                sinceSeq: -1,
            });
            if (!existingEvents.some((event) => event.type === terminalEventType)) {
                await this.sessionManager!.appendEvent(
                    params.tenantId,
                    params.taskId,
                    terminalEventType,
                    terminalEventPayload
                );
            }
        } catch (error) {
            log.warn('Durable terminal projection event append failed', {
                tenantId: params.tenantId,
                taskId: params.taskId,
                deliveryKey: terminal.deliveryKey,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        await this.sessionManager!.enqueueOutbox(
            params.tenantId,
            'task.status',
            params.taskId,
            {
                taskId: params.taskId,
                status: terminal.status,
                final: true,
                deliveryKey: terminal.deliveryKey,
            },
            undefined,
            terminal.deliveryKey
        );
        const enqueuedAt = new Date().toISOString();
        await reconcileSnapshotMutation({
            session: this.sessionManager!,
            tenantId: params.tenantId,
            sessionId: params.taskId,
            agentId: params.agentId,
            operation: 'task.terminal.mark_enqueued',
            mutate: ({ snapshot }) => {
                const next = markDurableTaskTerminalEnqueued(snapshot, terminal.deliveryKey, enqueuedAt);
                return next === snapshot
                    ? { kind: 'noop' as const, value: undefined }
                    : { kind: 'write' as const, snapshot: next, value: undefined };
            },
        });
        defaultMetricsRegistry.increment('task_terminal_publication_total', { status: 'enqueued' });
    }

    /** Observe a root until durable terminality; process-local idleness is not completion. */
    async awaitTaskTerminal(params: AwaitTaskTerminalParams): Promise<AwaitTaskTerminalResult> {
        const now = params.now ?? Date.now;
        const sleep = params.sleep ?? delay;
        const pollIntervalMs = Math.max(10, Math.trunc(params.pollIntervalMs ?? 1000));
        const timeoutMs = Math.max(1, Math.trunc(params.timeoutMs));
        const startedAtMs = params.startedAtMs ?? now();
        const proposedDeadline: RootRunDeadline = {
            timeoutMs,
            startedAt: new Date(startedAtMs).toISOString(),
            expiresAt: new Date(startedAtMs + timeoutMs).toISOString(),
            source: params.timeoutSource,
            timerToken: 'root-run-timeout',
        };

        const classify = (snapshot: Record<string, unknown>): AwaitTaskTerminalResult | undefined => {
            const terminal = terminalStatusFromSnapshot(snapshot, params.taskId);
            if (terminal !== undefined) {
                const storedDeadline = readRootRunDeadline(snapshot);
                return {
                    status: terminal,
                    lifecycle: 'terminal',
                    ...(storedDeadline !== undefined ? { deadline: storedDeadline } : {}),
                };
            }
            const awaiting = awaitingFromSnapshot(snapshot);
            if (awaiting.kind === 'await_input') {
                return {
                    status: {
                        state: 'input-required',
                        timestamp: new Date(now()).toISOString(),
                        metadata: {
                            awaiting: 'await_input',
                            ...(awaiting.token ? { token: awaiting.token } : {}),
                        },
                    },
                    lifecycle: 'input-required',
                };
            }
            return undefined;
        };

        const initial = await this.sessionManager!.load(params.tenantId, params.taskId);
        const initialSnapshot = (initial?.snapshot as Record<string, unknown> | undefined) ?? {};
        const initialResult = classify(initialSnapshot);
        if (initialResult !== undefined) {
            if (initialResult.lifecycle === 'terminal') {
                const storedDeadline = readRootRunDeadline(initialSnapshot);
                if (storedDeadline !== undefined) {
                    await this.runtimeDriver.cancelTimer?.({
                        tenantId: params.tenantId,
                        taskId: params.taskId,
                        token: storedDeadline.timerToken,
                    });
                }
                await this.ensureTaskTerminalPublished({
                    tenantId: params.tenantId,
                    taskId: params.taskId,
                    agentId: params.agentId,
                    snapshot: initialSnapshot,
                });
            }
            return initialResult;
        }

        const deadlineClaim = await reconcileSnapshotMutation({
            session: this.sessionManager!,
            tenantId: params.tenantId,
            sessionId: params.taskId,
            agentId: params.agentId,
            operation: 'task.run_deadline.register',
            mutate: ({ snapshot }) => {
                const existing = readRootRunDeadline(snapshot);
                if (existing !== undefined) return { kind: 'noop' as const, value: existing };
                if (terminalStatusFromSnapshot(snapshot, params.taskId) !== undefined) {
                    return { kind: 'noop' as const, value: proposedDeadline };
                }
                return {
                    kind: 'write' as const,
                    snapshot: writeRootRunDeadline(snapshot, proposedDeadline),
                    value: proposedDeadline,
                };
            },
        });
        const deadlineValue = deadlineClaim.value;
        const expiresAtMs = Date.parse(deadlineValue.expiresAt);
        let timerScheduled = await this.ensureRootRunDeadlineTimer({
            tenantId: params.tenantId,
            taskId: params.taskId,
            ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
            deadline: deadlineValue,
        });

        for (;;) {
            const loaded = await this.sessionManager!.load(params.tenantId, params.taskId);
            const snapshot = (loaded?.snapshot as Record<string, unknown> | undefined) ?? {};
            const result = classify(snapshot);
            if (result !== undefined) {
                if (result.lifecycle === 'terminal') {
                    await this.runtimeDriver.cancelTimer?.({
                        tenantId: params.tenantId,
                        taskId: params.taskId,
                        token: deadlineValue.timerToken,
                    });
                    await this.ensureTaskTerminalPublished({
                        tenantId: params.tenantId,
                        taskId: params.taskId,
                        agentId: params.agentId,
                        snapshot,
                    });
                }
                defaultMetricsRegistry.increment('task_terminal_wait_total', {
                    status: result.lifecycle === 'input-required' ? 'input_required' : result.status.state,
                });
                return { ...result, deadline: deadlineValue };
            }

            if (!timerScheduled) {
                timerScheduled = await this.ensureRootRunDeadlineTimer({
                    tenantId: params.tenantId,
                    taskId: params.taskId,
                    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
                    deadline: deadlineValue,
                });
            }

            const remainingMs = expiresAtMs - now();
            if (remainingMs <= 0) {
                await this.cancelTask({
                    tenantId: params.tenantId,
                    taskId: params.taskId,
                    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
                    reason: 'active_run_timeout',
                    metadata: {
                        code: 'TASK_RUN_TIMEOUT',
                        timeoutMs: deadlineValue.timeoutMs,
                        expiresAt: deadlineValue.expiresAt,
                    },
                });
                const after = await this.sessionManager!.load(params.tenantId, params.taskId);
                const afterSnapshot = (after?.snapshot as Record<string, unknown> | undefined) ?? {};
                const authoritative = terminalStatusFromSnapshot(afterSnapshot, params.taskId);
                if (authoritative === undefined) {
                    throw new Error(`Task ${params.taskId} deadline expired without a durable terminal claim.`);
                }
                await this.ensureTaskTerminalPublished({
                    tenantId: params.tenantId,
                    taskId: params.taskId,
                    agentId: params.agentId,
                    snapshot: afterSnapshot,
                });
                defaultMetricsRegistry.increment('task_terminal_wait_total', {
                    status: authoritative.state === 'canceled' ? 'timeout' : authoritative.state,
                });
                return { status: authoritative, lifecycle: 'terminal', deadline: deadlineValue };
            }
            await sleep(Math.min(pollIntervalMs, remainingMs));
        }
    }

    /**
     * Wait for all background task promises to complete
     * Useful for tests to ensure all background work finishes before test cleanup
     * @param timeoutMs Maximum time to wait (default: 5000ms)
     */
    async waitForBackgroundTasks(
        timeoutMs: number = 5000,
        options: WaitForBackgroundTasksOptions = {}
    ): Promise<void> {
        const initialCount = this.backgroundTasksInScope(options.rootTaskId).length;
        if (process.env.DEBUG_BACKGROUND_TASKS) {
            if (initialCount === 0) {
                console.log('[TaskEngine] No background tasks to wait for');
            }
            console.log(`[TaskEngine] Waiting for ${initialCount} background task(s), timeout=${timeoutMs}ms`);
            console.log(`[TaskEngine] Active handles before wait: ${(process as any)._getActiveHandles?.()?.length ?? 'unknown'}`);
            console.log(`[TaskEngine] Active requests before wait: ${(process as any)._getActiveRequests?.()?.length ?? 'unknown'}`);
        }

        const startTime = Date.now();
        const deadline = startTime + timeoutMs;
        const idleGraceMs = Math.min(250, Math.max(25, timeoutMs));
        while (Date.now() < deadline) {
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
                break;
            }
            await this.reconcileBackgroundTaskOwnership(options.rootTaskId);
            if (this.backgroundTasksInScope(options.rootTaskId).length === 0) {
                const reconciled = await this.reconcileCurrentConversationDeliveries();
                if (reconciled > 0) {
                    continue;
                }
                await delay(Math.min(idleGraceMs, remainingMs));
                const reconciledAfterGrace = await this.reconcileCurrentConversationDeliveries();
                if (reconciledAfterGrace > 0) {
                    continue;
                }
                if (this.backgroundTasksInScope(options.rootTaskId).length === 0) {
                    break;
                }
                continue;
            }
            const promises = this.backgroundTasksInScope(options.rootTaskId);
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    Promise.allSettled(promises),
                    new Promise<void>((resolve) => {
                        timeout = setTimeout(resolve, Math.min(250, remainingMs));
                    })
                ]);
            } finally {
                if (timeout !== undefined) {
                    clearTimeout(timeout);
                }
            }
        }
        if (this.runtimeDriver instanceof InProcessRuntimeDriver) {
            await this.runtimeDriver.waitForIdle();
        } else {
            const delegate = (
                this.runtimeDriver as { getDelegate?: () => RuntimeDriver }
            ).getDelegate?.();
            if (delegate instanceof InProcessRuntimeDriver) {
                await delegate.waitForIdle();
            }
        }
        const elapsed = Date.now() - startTime;

        let remainingPromises = this.backgroundTasksInScope(options.rootTaskId);
        let remainingCount = remainingPromises.length;
        let conversationActivations = this.conversationActivationsInScope(options.rootTaskId);
        let activeConversationActivations = conversationActivations.active;
        let pendingConversationActivations = conversationActivations.pending;
        let remainingTasks = this.describeBackgroundTasks(Date.now(), remainingPromises);
        if (process.env.DEBUG_BACKGROUND_TASKS) {
            console.log(`[TaskEngine] Wait completed after ${elapsed}ms, remaining promises=${remainingCount}`);
            if (remainingTasks.length > 0) {
                console.log(`[TaskEngine] Remaining background tasks: ${JSON.stringify(remainingTasks)}`);
            }
            console.log(`[TaskEngine] Active handles after wait: ${(process as any)._getActiveHandles?.()?.length ?? 'unknown'}`);
            console.log(`[TaskEngine] Active requests after wait: ${(process as any)._getActiveRequests?.()?.length ?? 'unknown'}`);
        }

        // Give a bit more time for async cleanup after promises resolve
        // This ensures resources like Prisma connections are closed
        await delay(100);

        // Work can settle or register nested cleanup while the grace interval is
        // running. Reconcile and classify the final state instead of throwing from
        // the point-in-time snapshot captured before the delay.
        await this.reconcileBackgroundTaskOwnership(options.rootTaskId);
        remainingPromises = this.backgroundTasksInScope(options.rootTaskId);
        remainingCount = remainingPromises.length;
        conversationActivations = this.conversationActivationsInScope(options.rootTaskId);
        activeConversationActivations = conversationActivations.active;
        pendingConversationActivations = conversationActivations.pending;
        remainingTasks = this.describeBackgroundTasks(Date.now(), remainingPromises);

        if (process.env.DEBUG_BACKGROUND_TASKS) {
            console.log(`[TaskEngine] Active handles after cleanup delay: ${(process as any)._getActiveHandles?.()?.length ?? 'unknown'}`);
            console.log(`[TaskEngine] Active requests after cleanup delay: ${(process as any)._getActiveRequests?.()?.length ?? 'unknown'}`);
        }
        if (
            options.throwOnTimeout === true &&
            (remainingCount > 0 || activeConversationActivations.length > 0 || pendingConversationActivations.length > 0)
        ) {
            log.warn('Background task drain incomplete', {
                elapsed,
                remainingPromises: remainingCount,
                remainingTasks,
                activeConversationActivations,
                pendingConversationActivations,
            });
            throw new BackgroundTaskDrainError({
                elapsedMs: elapsed,
                activeCount: remainingCount,
                detachedCount: this.backgroundTasksInScope(options.rootTaskId, true)
                    .filter((promise) => this.backgroundTaskMetadata.get(promise)?.state === 'detached').length,
                remainingTasks,
                activeConversationActivations,
                pendingConversationActivations,
            });
        }
        defaultMetricsRegistry.increment('background_drain_total', {
            status: remainingCount > 0 ? 'incomplete' : 'drained',
        });
    }

    async drainBackgroundTasks(params: {
        rootTaskId: string;
        timeoutMs?: number;
        throwOnTimeout?: boolean;
    }): Promise<BackgroundTaskDrainReport> {
        const startedAt = Date.now();
        await this.waitForBackgroundTasks(params.timeoutMs ?? 5000, {
            rootTaskId: params.rootTaskId,
            throwOnTimeout: params.throwOnTimeout,
        });
        const active = this.backgroundTasksInScope(params.rootTaskId);
        const detached = this.backgroundTasksInScope(params.rootTaskId, true)
            .filter((promise) => this.backgroundTaskMetadata.get(promise)?.state === 'detached');
        const conversationActivations = this.conversationActivationsInScope(params.rootTaskId);
        return {
            elapsedMs: Date.now() - startedAt,
            activeCount: active.length,
            detachedCount: detached.length,
            remainingTasks: this.describeBackgroundTasks(Date.now(), active),
            activeConversationActivations: conversationActivations.active,
            pendingConversationActivations: conversationActivations.pending,
        };
    }

    async triggerExpiredInviteSweep(params: {
        tenantId: string;
        nowIso?: string;
        limit?: number;
    }): Promise<string[]> {
        return this.inviteSweeper.runExpirySweep(params);
    }

    /**
     * `sendTaskToAgent` identical to the TaskEngine session path (conversation row + A2A + trace stamps).
     * Used by the streaming runner when this engine is registered via `EngineLocator`.
     */
    createStreamingSendTaskToAgent(ctx: TaskContext): TaskContext['sendTaskToAgent'] {
        return ApiBinder.createSendTaskToAgentHandler(
            {
                sessionManager: this.sessionManager!,
                snapshotRepo: this.snapshotRepo!,
                getTraceContext: () => ({}),
                getSessionStorePrisma: () => this.getSessionStorePrisma(),
                taskCreationMutex: this.taskCreationMutex,
                backgroundTaskPromises: this.backgroundTaskPromises,
                trackBackgroundTask: (promise, metadata) => this.trackBackgroundTask(promise, metadata),
                runOwnedEffect: (factory, metadata) => this.runOwnedEffect(factory, metadata),
                handleToolCompleted: (p) => this.handleToolCompleted(p),
                conversationService: this.conversationService,
                enqueueChildStart: (p) => this.runtimeDriver.enqueueStart(p),
                scheduleChildTimeout: (p) => this.runtimeDriver.scheduleTimer(p),
                cancelTimer: (p) => this.runtimeDriver.cancelTimer?.(p) ?? Promise.resolve(),
                detachTaskBranch: (p) => this.detachTaskBranch(p),
                getRuntimeSurface: () => this.runtimeDriver.surface ?? 'in_process',
            },
            ctx,
            {
                tenantId: ctx.tenantId,
                sessionId: ctx.task.id,
                agentId: ctx.agentId,
                flushMentalState: async () => {
                    try {
                        await (ctx as { flushSnapshot?: (s: unknown) => Promise<void> }).flushSnapshot?.({
                            M: (ctx as { M?: unknown }).M,
                            env: (ctx as { env?: unknown }).env,
                        });
                    } catch {
                        /* noop */
                    }
                },
            }
        );
    }

    async triggerThreadLifecycleSweep(params: {
        tenantId: string;
        nowIso?: string;
        limit?: number;
        autoArchiveAfterMs?: number | null;
    }): Promise<{ expiredThreadIds: string[]; archivedThreadIds: string[] }> {
        return this.threadLifecycleSweeper.sweepTenant(params);
    }

    async triggerTopicLifecycleSweep(params: {
        tenantId: string;
        nowIso?: string;
        limit?: number;
        autoArchiveAfterMs?: number | null;
    }): Promise<{ archivedTopicIds: string[] }> {
        return this.topicLifecycleSweeper.sweepTenant(params);
    }

    async triggerInviteStartupRecoverySweep(params: {
        tenantId: string;
        nowIso?: string;
        limit?: number;
    }): Promise<string[]> {
        return this.inviteSweeper.runStartupRecoverySweep({
            ...params,
            publish: async (channel, event) => {
                await this.eventBus.publish(
                    createBusEvent({
                        channel,
                        cloud: {
                            id: uuidv7(),
                            type: channel,
                            source: '/conversation/invite-sweeper',
                            time: new Date().toISOString(),
                            datacontenttype: 'application/json',
                            data: event,
                        },
                    })
                );
            },
        });
    }

    stopOutboxPublisher(): void {
        this.outboxPublisherInstance?.stop();
    }

    /** Close optional broker connections when `TaskEngine` was constructed with `transportClose` from `resolveTransportAdapters`. */
    async closeTransportAdapters(): Promise<void> {
        await this.transportClose?.();
    }
}
