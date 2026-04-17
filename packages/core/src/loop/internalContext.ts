import type { StageTraceEntry } from '../types/stageFacade.js';
import type { TaskContext } from '../shared/types/index.js';
import type { EnvironmentState, ControlState, MentalState } from './types.js';
import type { TurnUsage, ManifestProvenance, JsonValue } from '../types/turnTrace.js';
import type { TurnTraceCollector } from '../telemetry/TurnTraceCollector.js';

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
        model: string;
        provider?: string;
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
        kind: 'broadcast' | 'round_robin' | 'explicit_recipient';
        resolvedMembers: Array<{ memberId: string; agentId: string }>;
    };
    __turnFanoutSummary?: {
        accepted: number;
        rejected: number;
        queued: number;
        dedupeHits: number;
    };
    /** Session-level turn trace collector (test/debug). */
    __turnTraceCollector?: TurnTraceCollector;
    /** Session-level manifest provenance restored from snapshot/session metadata on every turn-entry path */
    __manifestProvenance?: ManifestProvenance;
    /** True when the context has a real configured LLM and not only a fallback stub. */
    __llmConfigured?: boolean;
};
