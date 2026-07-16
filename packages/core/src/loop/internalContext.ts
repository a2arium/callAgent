import type { StageTraceEntry } from '../types/stageFacade.js';
import type { TaskContext } from '../shared/types/index.js';
import type { EnvironmentState, ControlState, MentalState } from './types.js';
import type { StopPolicyFanoutTrace } from '../public-types/conversation/schemas.js';
import type { TopicPostBackpressureSample } from '../internal/conversation/BackpressureManager.js';
import type { TurnUsage, ManifestProvenance, JsonValue } from '../types/turnTrace.js';
import type { TurnTraceCollector } from '../telemetry/TurnTraceCollector.js';
import type { ManifestHitlConfig } from './manifestConsent.js';

export type OperatorTurnTraceCapture = {
    enabled?: boolean;
    level?: 'summary' | 'full';
};

export type OperatorMemoryEvent = {
    op: 'read' | 'write' | 'delete';
    keys: string[];
    query?: unknown;
    resultKeys?: string[];
    resultCount?: number;
    status?: 'success' | 'failure';
    backend?: string;
    turnSeq?: number;
    agentId?: string;
    source: 'loop.memory' | 'context.memory';
};

/**
 * Internal extension of TaskContext used by the loop and stage facade.
 * Not exported publicly. Framework code that needs typed access to __activeLoopEnv,
 * controlVars, or __stageTrace uses this type.
 */
export type InternalTaskContext = TaskContext & {
    controlVars?: Record<string, unknown>;
    __activeLoopEnv?: EnvironmentState;
    env?: {
        control?: ControlState;
    };
    M?: MentalState;
    currentTurnNodeId?: string;
    telemetry?: {
        nodeId?: string;
        traceId?: string;
    };
    /** Stage transition trace for TurnTrace. StageFacade writes here on set(); oneTurn/loopRunner read and clear. */
    __stageTrace?: StageTraceEntry;
    /** Per-turn usage accumulator. Reset at turn start, aggregated into TurnTrace at turn end. */
    __turnUsage?: TurnUsage;
    /** Current APLRET module being executed. Fallback attribution only; explicit call-site metadata wins. */
    __currentModule?: string;
    /** LLM call summaries for current turn */
    __turnLlmCalls?: Array<{
        callId?: string;
        model: string;
        provider?: string;
        startedAt?: string;
        deadlineAt?: string;
        terminalAt?: string;
        terminalReason?: 'completed' | 'provider_error' | 'timeout' | 'cancelled';
        errorCode?: string;
        lateCompletion?: boolean;
        durationMs?: number;
        inputTokens?: number;
        outputTokens?: number;
        cost?: number;
        module?: string;
        hasOutputContract?: boolean;
        outputContractName?: string;
        outputContractStatus?: 'matched' | 'failed' | 'not_applicable';
    }>;
    /** Tool call summaries for current turn */
    __turnToolCalls?: Array<{
        tool: string;
        durationMs?: number;
        status?: 'success' | 'failure';
        module?: string;
    }>;
    /** Child call summaries for current turn */
    __turnChildCalls?: Array<{
        token: string;
        agentId?: string;
        childTaskId?: string;
        awaitCompletion?: boolean;
        durationMs?: number;
        status?: 'dispatched' | 'completed' | 'failed' | 'input_required';
        parentTurnId?: string;
        childAgentNodeId?: string;
        childTraceId?: string;
        resultSummary?: JsonValue;
        error?: JsonValue;
        module?: string;
    }>;
    __turnIncomingConversationMessages?: Array<{
        id: string;
        conversationId: string;
        kind: 'thread' | 'topic';
        senderAgentId: string;
        recipientAgentId: string;
        senderMemberId?: string;
        recipientMemberId?: string;
        speechAct: string;
        sequenceNumber?: number;
        correlationId?: string;
        idempotencyKey?: string;
    }>;
    __turnOutgoingConversationMessages?: Array<{
        id: string;
        conversationId: string;
        kind: 'thread' | 'topic';
        senderAgentId: string;
        recipientAgentId: string;
        senderMemberId?: string;
        recipientMemberId?: string;
        speechAct: string;
        sequenceNumber?: number;
        correlationId?: string;
        idempotencyKey?: string;
    }>;
    __turnConversationSummary?: { id: string; kind: 'thread' | 'topic' };
    __turnConversationSequenceNumber?: number;
    __turnConversationDedupeHit?: boolean;
    __turnConversationDeliveryLagMs?: number;
    __turnTopicSelectorDecision?: {
        kind: 'broadcast' | 'round_robin' | 'explicit_recipient' | 'selector_policy';
        resolvedMembers: Array<{ memberId: string; agentId: string }>;
        selectorPolicy?: {
            policyId: string;
            result:
                | 'selected'
                | 'abstained_fallback_broadcast'
                | 'params_invalid'
                | 'not_registered'
                | 'internal_error';
            paramsHash?: string;
        };
    };
    __turnFanoutSummary?: {
        accepted: number;
        rejected: number;
        queued: number;
        dedupeHits: number;
    };
    /** Topic stop-policy outcome after a successful topic `post` (from receipt.stopPolicyTrace). */
    __turnStopPolicy?: StopPolicyFanoutTrace;
    /** Worst backpressure sample observed during topic `post` fan-out (Phase 4b). */
    __turnBackpressure?: TopicPostBackpressureSample;
    __turnInviteAutoJoin?: Record<
        string,
        {
            attempted: boolean;
            error?: {
                type:
                    | 'InviteNotFound'
                    | 'InviteExpired'
                    | 'InviteAlreadyConsumed'
                    | 'InviteTargetMismatch';
                message: string;
            };
        }
    >;
    /** Session-level turn trace collector (test/debug). */
    __turnTraceCollector?: TurnTraceCollector;
    /** Session-level manifest provenance restored from snapshot/session metadata on every turn-entry path */
    __manifestProvenance?: ManifestProvenance;
    /** Runtime-manifest observability settings used by operator event capture. */
    __operatorTurnTraceCapture?: OperatorTurnTraceCapture;
    /** Best-effort memory operation sink installed while a turn is active. */
    __operatorMemoryEvent?: (event: OperatorMemoryEvent) => Promise<void> | void;
    /** True when the context has a real configured LLM and not only a fallback stub. */
    __llmConfigured?: boolean;
    /** Resolved runtime-manifest HITL obligations; never copied into MentalState. */
    __manifestHitl?: ManifestHitlConfig;
    /** Conversation delivery keys consumed by this run, persisted as an internal drain cursor. */
    __conversationConsumedDeliveryKeys?: Set<string>;
};
