import type { TelemetryProvider } from '../Provider.js';
import { TelemetryNode } from '../nodes/TelemetryNode.js';
import { logger } from '@a2arium/callagent-utils';
import { AgentNode } from '../nodes/AgentNode.js';
import { TurnNode } from '../nodes/TurnNode.js';
import { ToolNode } from '../nodes/ToolNode.js';
import { LLMNode } from '../nodes/LLMNode.js';
import { ChildCallNode } from '../nodes/ChildCallNode.js';
import type { TurnTrace } from '../../types/turnTrace.js';
import { v7 as uuidv7, validate as uuidValidate, version as uuidVersion } from 'uuid';
import { turnOpikDiagEnabled } from '../turnOpikDiagEnv.js';
import { sanitizeForOpikPayload } from '../turnTraceHelpers.js';

type OpikTracePayload = {
    id: string;
    name: string;
    metadata?: Record<string, unknown>;
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
    startTime?: Date;
    endTime?: Date;
    /** Opik UI grouping; matches JS SDK `TraceWrite.threadId`. */
    threadId?: string;
};

type OpikSpanPayload = {
    id: string;
    name: string;
    type: 'general' | 'tool' | 'llm';
    startTime: Date;
    endTime?: Date;
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    parentSpanId?: string;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
    totalEstimatedCost?: number;
    model?: string;
    provider?: string;
};

type OpikTrace = {
    span(payload: OpikSpanPayload): OpikSpan;
    update(payload: Partial<OpikTracePayload>): void;
    end(): void;
};

type OpikSpan = {
    update(payload: Partial<OpikSpanPayload>): void;
    end(): void;
};

type OpikClient = {
    trace(payload: OpikTracePayload): OpikTrace;
};

type GetTelemetryNode = (id: string) => TelemetryNode | undefined;
type GetAllRegisteredNodes = () => TelemetryNode[];

export class OpikProvider implements TelemetryProvider {
    public readonly name = 'opik';
    private enabled = false;
    private client: OpikClient | undefined;
    /** Cached from dynamic `opik` import; used to flush batched trace updates after root close. */
    private opikFlushAll: (() => Promise<void>) | undefined;

    private traces = new Map<string, OpikTrace>();
    private traceIdToTrace = new Map<string, OpikTrace>();
    private nodeToOpikId = new Map<string, string>();
    /** TurnNode references kept until onTurnTrace fires so we can read startTime. */
    private turnNodes = new Map<string, TurnNode>();
    /** Track which turn spans were already emitted by onTurnTrace so onNodeEnd doesn't duplicate. */
    private turnSpansEmitted = new Set<string>();

    /**
     * Telemetry node ids that already have an Opik span recorded. Children must wait
     * or Opik drops them (subagent Turn/LLM spans were emitted before Agent: subagent existed).
     */
    private parentSpanEmitted = new Set<string>();

    /** Spans waiting for parentSpanEmitted(parentId) before they can be sent. */
    private deferredByParent = new Map<string, Array<() => void>>();

    /**
     * TurnTrace rows received while `import('opik')` is still in flight (or client missing).
     * Without this, early loop turns are dropped — unrelated to Opik's 100MB product limit.
     */
    private pendingTurnTraces: Array<{ trace: TurnTrace; startTimeMs?: number }> = [];

    constructor(
        private readonly getTelemetryNode: GetTelemetryNode,
        private readonly getAllRegisteredNodes?: GetAllRegisteredNodes
    ) {
        this.init().catch((err) =>
            logger.warn('Opik initialization failed', { error: err })
        );
    }

    /** Invoked from TelemetryCollector.shutdownProviders. */
    async flush(): Promise<void> {
        if (this.opikFlushAll) {
            await this.opikFlushAll();
        }
    }

    /** Walk parent chain so nodes without traceId still attach to the root Opik trace. */
    private resolveTraceId(node: TelemetryNode): string | undefined {
        if (node.traceId) return node.traceId;
        let pid = node.parentId;
        const seen = new Set<string>();
        while (pid && pid !== 'root' && !seen.has(pid)) {
            seen.add(pid);
            const p = this.getTelemetryNode(pid);
            if (p?.traceId) return p.traceId;
            pid = p?.parentId;
        }
        return undefined;
    }

    /** Human-readable phase fragment for turn span titles (Opik list view). */
    private formatStagePhaseLabel(stage: string | undefined): string {
        if (!stage || !String(stage).trim()) return 'Run';
        const s = String(stage).trim();
        const words = s.split(/[-_]+/).filter(Boolean);
        if (words.length === 0) return 'Run';
        return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    }

    /**
     * Walk parents to the nearest AgentNode so span names are unique per agent.
     * Nested subagents all use env.turn 1,2,… — without this, Opik collapses "Turn 1" from
     * the main agent and from fetch-page-router into one row.
     */
    private resolveOwningAgentName(node: TelemetryNode | undefined): string {
        if (!node) return 'agent';
        let pid: string | undefined = node.parentId;
        const seen = new Set<string>();
        while (pid && pid !== 'root' && !seen.has(pid)) {
            seen.add(pid);
            const p = this.getTelemetryNode(pid);
            if (p instanceof AgentNode) return p.agentName;
            pid = p?.parentId;
        }
        return 'agent';
    }

    /** Root session agent: turns should not use parentSpanId (avoids a duplicate agent row vs the trace). */
    private isRootAgentTelemetryId(telemetryId: string | undefined): boolean {
        if (!telemetryId) return false;
        const n = this.getTelemetryNode(telemetryId);
        return (
            n instanceof AgentNode &&
            (!n.parentId || n.parentId === 'root')
        );
    }

    /** Resolve the Opik trace object for a given traceId, rehydrating a stub if needed. */
    private resolveOpikTrace(traceId: string | undefined): OpikTrace | undefined {
        if (!traceId) return undefined;
        let trace = this.traceIdToTrace.get(traceId);
        if (!trace) {
            const opikId = this.getOpikId(traceId);
            const startTime = new Date();
            // Match root startTrace: thread groups the session in Opik UI. Stubs created before
            // the root AgentNode opens must still carry threadId or spans show empty thread_id.
            trace = this.client!.trace({
                id: opikId,
                name: 'agent-resumed-stub',
                startTime,
                threadId: traceId,
            });
            this.traceIdToTrace.set(traceId, trace);
        }
        return trace;
    }

    private async init(): Promise<void> {
        if (
            process.env.CALLAGENT_OPIK_ENABLED !== 'true' &&
            !process.env.OPIK_API_KEY
        ) {
            return;
        }
        try {
            const opikModule = await import('opik');
            const OpikClientClass = opikModule.Opik as new () => OpikClient;
            this.client = new OpikClientClass();
            this.opikFlushAll = opikModule.flushAll;
            this.enabled = true;
            logger.info('Opik provider initialized');
            this.syncOpenRootTracesAfterInit();
            this.flushPendingTurnTraces();
        } catch {
            logger.debug('Opik SDK not found, skipping Opik provider');
        }
    }

    /**
     * Root AgentNode may register before async init() finishes; startTrace was skipped.
     * Attach to existing stub trace from early spans or open a proper root trace.
     */
    private syncOpenRootTracesAfterInit(): void {
        if (!this.client || !this.enabled) return;
        const nodes = this.getAllRegisteredNodes?.() ?? [];
        for (const node of nodes) {
            if (
                !(node instanceof AgentNode) ||
                (node.parentId && node.parentId !== 'root') ||
                node.endTime != null
            ) {
                continue;
            }
            try {
                if (!this.traces.has(node.id)) {
                    this.startTrace(node);
                }
            } catch (err) {
                logger.error('Opik syncOpenRootTracesAfterInit error', {
                    error: err,
                    nodeId: node.id,
                });
            }
        }
    }

    // ── Lifecycle hooks ──────────────────────────────────────────────────

    onNodeStart(node: TelemetryNode): void {
        try {
            if (node instanceof TurnNode) {
                this.turnNodes.set(node.id, node);
            }
            if (!this.enabled || !this.client) {
                return;
            }
            if (node instanceof AgentNode && (!node.parentId || node.parentId === 'root')) {
                this.startTrace(node);
            }
            // All other node types: nothing on start. Spans are created with
            // full data at end time so the Opik SDK receives content in a
            // single trace.span() call (its update() is unreliable).
        } catch (error) {
            logger.error('Opik onNodeStart error', { error, nodeId: node.id });
        }
    }

    onNodeEnd(node: TelemetryNode): void {
        try {
            if (node instanceof AgentNode && (!node.parentId || node.parentId === 'root')) {
                if (this.enabled && this.client) {
                    this.endTrace(node);
                }
                return;
            }
            if (node instanceof TurnNode) {
                if (this.enabled && this.client && !this.turnSpansEmitted.has(node.id)) {
                    this.createSpanOrDefer(node);
                }
                this.turnNodes.delete(node.id);
                this.turnSpansEmitted.delete(node.id);
                return;
            }
            if (!this.enabled || !this.client) {
                return;
            }
            this.createSpanOrDefer(node);
        } catch (error) {
            logger.error('Opik onNodeEnd error', { error, nodeId: node.id });
        }
    }

    onTurnTrace(trace: TurnTrace): void {
        const D = turnOpikDiagEnabled();
        if (!this.enabled || !this.client) {
            const turnNodeId = trace.spanId;
            const turnNodeRef = turnNodeId ? this.turnNodes.get(turnNodeId) : undefined;
            this.pendingTurnTraces.push({
                trace,
                startTimeMs: turnNodeRef?.startTime,
            });
            if (D) {
                logger.info('[CALLAGENT_DEBUG_TURN_OPIK] onTurnTrace BUFFER (awaiting Opik client)', {
                    turn: trace.turn,
                    traceId: trace.traceId,
                    spanId: trace.spanId,
                    pendingCount: this.pendingTurnTraces.length,
                });
            }
            return;
        }
        try {
            this.submitTurnTraceForOpik(trace);
        } catch (error) {
            logger.error('Opik onTurnTrace error', { error });
        }
    }

    /** Replay turns that were buffered until `import('opik')` finished. */
    private flushPendingTurnTraces(): void {
        if (!this.enabled || !this.client || this.pendingTurnTraces.length === 0) {
            return;
        }
        const batch = this.pendingTurnTraces;
        this.pendingTurnTraces = [];
        for (const { trace, startTimeMs } of batch) {
            try {
                if (turnOpikDiagEnabled()) {
                    logger.info('[CALLAGENT_DEBUG_TURN_OPIK] flushPendingTurnTraces replay', {
                        turn: trace.turn,
                        spanId: trace.spanId,
                    });
                }
                this.submitTurnTraceForOpik(trace, startTimeMs);
            } catch (error) {
                logger.error('Opik flushPendingTurnTraces failed for buffered turn', {
                    error,
                    turn: trace.turn,
                    spanId: trace.spanId,
                });
            }
        }
    }

    private submitTurnTraceForOpik(trace: TurnTrace, startTimeMsOverride?: number): void {
        const D = turnOpikDiagEnabled();
        let effectiveTraceId = trace.traceId;
        if (!effectiveTraceId && trace.spanId) {
            const spanNode = this.getTelemetryNode(trace.spanId);
            if (spanNode) {
                effectiveTraceId = this.resolveTraceId(spanNode);
            }
        }
        if (D) {
            logger.info('[CALLAGENT_DEBUG_TURN_OPIK] onTurnTrace enter', {
                turn: trace.turn,
                payloadTraceId: trace.traceId,
                effectiveTraceId,
                spanId: trace.spanId,
                parentSpanId: trace.parentSpanId,
                traceIdToTraceHas: effectiveTraceId
                    ? this.traceIdToTrace.has(effectiveTraceId)
                    : false,
            });
        }
        const opikTrace = this.resolveOpikTrace(effectiveTraceId);
        if (!opikTrace) {
            logger.warn('Opik onTurnTrace: no Opik trace handle (turn span dropped)', {
                traceId: trace.traceId,
                effectiveTraceId,
                turn: trace.turn,
                spanId: trace.spanId,
            });
            return;
        }

        const turnNodeId = trace.spanId;
        if (!turnNodeId) {
            logger.warn('Opik onTurnTrace: missing spanId (turn span dropped)', {
                turn: trace.turn,
                traceId: effectiveTraceId ?? trace.traceId,
            });
            return;
        }

        const turnNodeRef = this.turnNodes.get(turnNodeId);
        const startTime =
            startTimeMsOverride != null
                ? new Date(startTimeMsOverride)
                : turnNodeRef?.startTime
                  ? new Date(turnNodeRef.startTime)
                  : new Date();

        const owningAgent = this.resolveOwningAgentName(turnNodeRef);
        const phaseSlug = trace.stageAfter ?? trace.stageBefore;
        const phaseLabel = this.formatStagePhaseLabel(phaseSlug);
        const turnLabel = `${owningAgent} · ${phaseLabel} · Turn ${trace.turn}`;

        const parentTelemetryId =
            trace.parentSpanId && trace.parentSpanId !== 'root'
                ? trace.parentSpanId
                : undefined;

        const parentSpanIdForPayload =
            parentTelemetryId && !this.isRootAgentTelemetryId(parentTelemetryId)
                ? this.getOpikId(parentTelemetryId)
                : undefined;

        const emitTurnSpan = (): void => {
            if (D) {
                logger.info('[CALLAGENT_DEBUG_TURN_OPIK] onTurnTrace SPAN_SUBMIT', {
                    turn: trace.turn,
                    turnLabel,
                    turnNodeId,
                    effectiveTraceId: effectiveTraceId ?? trace.traceId,
                    opikSpanId: this.getOpikId(turnNodeId),
                    hasParentSpanInPayload: !!parentSpanIdForPayload,
                });
            }
            const spanPayload: OpikSpanPayload = {
                id: this.getOpikId(turnNodeId),
                name: turnLabel,
                type: 'general',
                startTime,
                endTime: new Date(),
                input: this.toOpikRecord({
                    inboxCurrent: trace.inboxCurrent,
                    correlationId: trace.correlationId,
                }),
                output: this.toOpikRecord({
                    intent: trace.intent,
                    transition: trace.transition,
                    error: trace.error,
                    execAction: trace.execAction,
                    execResult: trace.execResult,
                }),
                metadata: this.toOpikRecord({
                    nodeId: turnNodeId,
                    nodeType: 'turn',
                    agentName: owningAgent,
                    turn: trace.turn,
                    turnId: trace.turnId,
                    stageBefore: trace.stageBefore,
                    stageAfter: trace.stageAfter,
                    stagePhaseSlug: phaseSlug,
                    timings: trace.timings,
                    usage: trace.usage,
                    llmCalls: trace.llmCalls,
                    toolCalls: trace.toolCalls,
                    childCalls: trace.childCalls,
                    threadId: effectiveTraceId ?? trace.traceId,
                }),
            };
            if (parentSpanIdForPayload) {
                spanPayload.parentSpanId = parentSpanIdForPayload;
            }

            const span = opikTrace.span(spanPayload);
            span.end();
            this.afterEmitSpan(turnNodeId);
            this.turnSpansEmitted.add(turnNodeId);
        };

        const parentNodeForDefer = parentTelemetryId
            ? this.getTelemetryNode(parentTelemetryId)
            : undefined;
        const parentIsRootSessionAgent =
            parentNodeForDefer instanceof AgentNode &&
            (!parentNodeForDefer.parentId || parentNodeForDefer.parentId === 'root');

        if (
            !parentIsRootSessionAgent &&
            parentTelemetryId &&
            !this.parentSpanEmitted.has(parentTelemetryId)
        ) {
            if (D) {
                logger.warn('[CALLAGENT_DEBUG_TURN_OPIK] onTurnTrace DEFER (waiting for parent span)', {
                    turn: trace.turn,
                    turnLabel,
                    parentTelemetryId,
                    parentNodeType: parentNodeForDefer?.type,
                    parentIsRootSessionAgent,
                    parentSpanEmitted: false,
                    queueLenAfter: (this.deferredByParent.get(parentTelemetryId)?.length ?? 0) + 1,
                });
            }
            this.queueDeferred(parentTelemetryId, emitTurnSpan);
            this.turnSpansEmitted.add(turnNodeId);
            return;
        }

        if (D) {
            logger.info('[CALLAGENT_DEBUG_TURN_OPIK] onTurnTrace EMIT_IMMEDIATE', {
                turn: trace.turn,
                turnLabel,
                parentTelemetryId,
                parentIsRootSessionAgent,
                parentSpanEmitted:
                    parentTelemetryId != null
                        ? this.parentSpanEmitted.has(parentTelemetryId)
                        : null,
            });
        }
        emitTurnSpan();
    }

    onNodeFailure(node: TelemetryNode, error: Error): void {
        if (!this.enabled || !this.client) return;
        try {
            const trace = this.traces.get(node.id);
            if (trace) {
                const failedTraceId = node instanceof AgentNode ? node.traceId : undefined;
                void this.finalizeClosedRootTrace(trace, node.id, failedTraceId, (t) => {
                    t.update({
                        output: this.toOpikRecord({
                            error: error.message,
                            stack: error.stack,
                        }),
                        endTime: new Date(),
                        metadata: { status: 'failed' },
                    });
                });
            } else if (node instanceof AgentNode && (!node.parentId || node.parentId === 'root')) {
                logger.warn('Opik onNodeFailure: missing active trace handle for root AgentNode', {
                    nodeId: node.id,
                    traceId: node.traceId,
                    agentName: node.agentName,
                    traceIdToTraceHasEntry: node.traceId ? this.traceIdToTrace.has(node.traceId) : false,
                });
            }
        } catch (err) {
            logger.warn('Opik onNodeFailure error', { error: err });
        }
    }

    onUsageUpdate(_node: TelemetryNode): void {
        // Usage is finalized on end for Opik
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    /**
     * Opik payloads are JSON-sized in practice; trim strings, artifact bodies, and deep trees
     * so a single span does not exceed backend / SDK limits.
     */
    private toOpikRecord(value: unknown): Record<string, unknown> {
        const s = sanitizeForOpikPayload(value);
        if (s === null) {
            return { value: null };
        }
        if (typeof s === 'object' && !Array.isArray(s)) {
            return s as Record<string, unknown>;
        }
        return { value: s };
    }

    private safeInput(input: unknown): Record<string, unknown> | undefined {
        if (input === undefined || input === null) return undefined;
        return this.toOpikRecord(input);
    }

    private safeOutput(output: unknown): Record<string, unknown> | undefined {
        if (output === undefined || output === null) return undefined;
        return this.toOpikRecord(output);
    }

    private getOpikId(nodeId: string): string {
        if (uuidValidate(nodeId) && uuidVersion(nodeId) === 7) {
            return nodeId;
        }
        const existing = this.nodeToOpikId.get(nodeId);
        if (existing) return existing;
        const opikId = uuidv7();
        this.nodeToOpikId.set(nodeId, opikId);
        return opikId;
    }

    // ── Trace lifecycle ─────────────────────────────────────────────────

    private startTrace(node: AgentNode): void {
        if (this.traces.has(node.id)) {
            if (turnOpikDiagEnabled()) {
                logger.info('[CALLAGENT_DEBUG_TURN_OPIK] startTrace SKIP already_open', {
                    agentNodeId: node.id,
                    agentName: node.agentName,
                    traceId: node.traceId,
                });
            }
            return;
        }

        const opikTraceId = this.getOpikId(node.traceId ?? node.id);
        const startTime = node.startTime ? new Date(node.startTime) : new Date();
        const threadId =
            (typeof node.providerData.threadId === 'string' && node.providerData.threadId) ||
            (node.traceId as string | undefined) ||
            opikTraceId;
        const metadata = this.toOpikRecord({
            agentTelemetryId: node.id,
            threadId,
            ...node.providerData,
        });
        const input = this.safeInput(node.input);

        let trace: OpikTrace | undefined =
            node.traceId != null ? this.traceIdToTrace.get(node.traceId) : undefined;

        if (trace) {
            trace.update({
                name: `agent:${node.agentName}`,
                startTime,
                threadId,
                metadata,
                input,
            });
        } else {
            trace = this.client!.trace({
                id: opikTraceId,
                name: `agent:${node.agentName}`,
                startTime,
                threadId,
                metadata,
                input,
            });
            if (node.traceId) {
                this.traceIdToTrace.set(node.traceId, trace);
            }
        }

        this.traces.set(node.id, trace);
        // One trace row = agent; turns omit parentSpanId so they nest under this trace (no duplicate agent span).
        this.parentSpanEmitted.add(node.id);
        // Turns that ran before startTrace (or before parentSpanEmitted) may have queued on this agent id.
        this.afterEmitSpan(node.id);
        if (turnOpikDiagEnabled()) {
            logger.info('[CALLAGENT_DEBUG_TURN_OPIK] startTrace root opened', {
                agentNodeId: node.id,
                logicalTraceId: node.traceId,
                opikTracePayloadId: opikTraceId,
                agentName: node.agentName,
                threadId,
            });
        }
    }

    private endTrace(node: AgentNode): void {
        const trace = this.traces.get(node.id);
        if (!trace) {
            if (!node.parentId || node.parentId === 'root') {
                logger.warn('Opik endTrace: missing active trace handle for root AgentNode', {
                    nodeId: node.id,
                    traceId: node.traceId,
                    agentName: node.agentName,
                    traceIdToTraceHasEntry: node.traceId ? this.traceIdToTrace.has(node.traceId) : false,
                });
            }
            return;
        }
        const closedTraceId = node.traceId;
        if (turnOpikDiagEnabled()) {
            logger.info('[CALLAGENT_DEBUG_TURN_OPIK] endTrace root closing (pre-flush, trace.end, post-flush)', {
                agentNodeId: node.id,
                logicalTraceId: closedTraceId,
                agentName: node.agentName,
            });
        }
        void this.finalizeClosedRootTrace(trace, node.id, closedTraceId, (t) => {
            t.update({
                output: this.safeOutput(node.output),
                endTime: new Date(),
                metadata: this.toOpikRecord({
                    status: node.status,
                    cost: node.pricing?.cost,
                    tokens: node.usage?.totalTokens,
                    traceClosed: true,
                    finalStatus: node.status === 'success' ? 'ok' : node.status,
                }),
            });
        });
    }

    /**
     * Flush queued spans before trace.end() so the backend receives all turn/child spans while the trace is still open.
     * Then update, end, delete handle, flush again, and drop logical trace mapping.
     */
    private async finalizeClosedRootTrace(
        trace: OpikTrace,
        telemetryNodeId: string,
        logicalTraceId: string | undefined,
        applyFinalUpdate: (t: OpikTrace) => void,
    ): Promise<void> {
        try {
            await this.opikFlushAll?.();
        } catch (flushErr) {
            logger.warn('Opik flushAll before root trace close failed', { error: flushErr });
        }
        applyFinalUpdate(trace);
        trace.end();
        this.traces.delete(telemetryNodeId);
        await this.flushAndDropTraceMapping(logicalTraceId);
    }

    /** Flush SDK buffers after trace.end(), then drop traceId mapping so late spans do not open a duplicate trace before flush completes. */
    private async flushAndDropTraceMapping(logicalTraceId: string | undefined): Promise<void> {
        if (turnOpikDiagEnabled()) {
            logger.info('[CALLAGENT_DEBUG_TURN_OPIK] flushAndDropTraceMapping start', {
                logicalTraceId,
                hadLogicalMapping: logicalTraceId
                    ? this.traceIdToTrace.has(logicalTraceId)
                    : false,
                deferredParentsRemaining: this.deferredByParent.size,
            });
        }
        try {
            await this.opikFlushAll?.();
        } catch (flushErr) {
            logger.warn('Opik flushAll failed after root trace end', { error: flushErr });
        }
        if (logicalTraceId) {
            this.traceIdToTrace.delete(logicalTraceId);
        }
        if (turnOpikDiagEnabled()) {
            logger.info('[CALLAGENT_DEBUG_TURN_OPIK] flushAndDropTraceMapping done', {
                logicalTraceId,
                mappingDeleted: !!logicalTraceId,
            });
        }
    }

    private queueDeferred(parentTelemetryId: string, fn: () => void): void {
        const q = this.deferredByParent.get(parentTelemetryId) ?? [];
        q.push(fn);
        this.deferredByParent.set(parentTelemetryId, q);
    }

    /** Call after a span for `nodeId` is fully sent so children can flush. */
    private afterEmitSpan(nodeId: string): void {
        this.parentSpanEmitted.add(nodeId);
        const pending = this.deferredByParent.get(nodeId);
        if (!pending?.length) return;
        if (turnOpikDiagEnabled()) {
            logger.info('[CALLAGENT_DEBUG_TURN_OPIK] afterEmitSpan flushing deferred', {
                parentNodeId: nodeId,
                deferredCount: pending.length,
            });
        }
        this.deferredByParent.delete(nodeId);
        for (const fn of pending) {
            try {
                fn();
            } catch (err) {
                logger.error('Opik deferred span flush error', { error: err, parentNodeId: nodeId });
            }
        }
    }

    /**
     * Create an Opik span with full data and immediately end it.
     * Defers if the parent telemetry node has not been emitted yet (ordering fix for subagents).
     */
    private createSpanOrDefer(node: TelemetryNode): void {
        const parentId = node.parentId;
        if (
            parentId &&
            parentId !== 'root' &&
            !this.parentSpanEmitted.has(parentId)
        ) {
            this.queueDeferred(parentId, () => {
                this.createSpanInternal(node);
                this.afterEmitSpan(node.id);
            });
            return;
        }
        this.createSpanInternal(node);
        this.afterEmitSpan(node.id);
    }

    private createSpanInternal(node: TelemetryNode): void {
        const traceId = this.resolveTraceId(node);
        const trace = this.resolveOpikTrace(traceId);
        if (!trace) {
            logger.warn('Opik: skipping span (unresolved trace)', {
                nodeType: node.type,
                nodeId: node.id,
                parentId: node.parentId,
                resolvedTraceId: traceId,
            });
            return;
        }

        const parentId = node.parentId;
        const baseMetadata: Record<string, unknown> = {
            nodeId: node.id,
            nodeType: node.type,
            // Opik UI exports thread_id from trace; mirroring on spans matches turn spans and
            // keeps sub-agent Agent/Child rows in the same thread view.
            threadId: traceId,
        };
        if (node instanceof TurnNode) {
            const owningAgent = this.resolveOwningAgentName(node);
            baseMetadata.agentName = owningAgent;
        }

        const spanPayload: OpikSpanPayload = {
            id: this.getOpikId(node.id),
            name: this.getSpanName(node),
            type: this.getOpikSpanType(node),
            startTime: node.startTime ? new Date(node.startTime) : new Date(),
            endTime: node.endTime ? new Date(node.endTime) : new Date(),
            input: this.safeInput(node.input),
            output: this.safeOutput(node.output),
            metadata: baseMetadata,
        };

        if (
            parentId &&
            parentId !== 'root' &&
            !this.isRootAgentTelemetryId(parentId)
        ) {
            spanPayload.parentSpanId = this.getOpikId(parentId);
        }

        if (node instanceof LLMNode) {
            spanPayload.usage = {
                prompt_tokens: node.usage?.inputTokens,
                completion_tokens: node.usage?.outputTokens,
                total_tokens: node.usage?.totalTokens,
            };
            if (node.pricing?.cost) {
                spanPayload.totalEstimatedCost = node.pricing.cost;
            }
            spanPayload.model = node.model;
            spanPayload.provider = (node.providerData?.provider as string) ?? undefined;
        }

        const span = trace.span(spanPayload);
        span.end();
    }

    private getOpikSpanType(
        node: TelemetryNode
    ): 'general' | 'tool' | 'llm' {
        if (node instanceof LLMNode) return 'llm';
        if (node instanceof ToolNode) return 'tool';
        return 'general';
    }

    private getSpanName(node: TelemetryNode): string {
        if (node.name) return node.name;
        if (node instanceof AgentNode) return `Agent: ${node.agentName}`;
        if (node instanceof TurnNode) {
            const owningAgent = this.resolveOwningAgentName(node);
            return `${owningAgent} · Turn ${node.turnIndex}`;
        }
        if (node instanceof ToolNode) return `Tool: ${node.toolName}`;
        if (node instanceof LLMNode) {
            const provider =
                (node.providerData?.provider as string)?.toLowerCase() ?? 'llm';
            return `${provider}.chat.completions`;
        }
        if (node instanceof ChildCallNode) {
            if (node.childAgentId) {
                return `Child → ${node.childAgentId}`;
            }
            return `Child: ${node.childToken}`;
        }
        return node.type;
    }
}
