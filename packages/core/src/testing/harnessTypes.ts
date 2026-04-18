import { z } from 'zod';
import type { TransitionOut, ShieldOutcome } from '../loop/oneTurn.js';
import type { Intent } from '../types/intent.js';
import type { MentalState, EnvironmentState } from '../loop/types.js';
import type { Observation } from '../types/observation.js';
import type { TurnTrace, ManifestProvenance } from '../types/turnTrace.js';
import type { AgentRuntimeManifest } from '@a2arium/callagent-types';
import type { SessionManager } from '../orchestration/SessionManager.js';
import type { Clock } from '../internal/conversation/Clock.js';
import type { TopicSelectorPolicyRegistry } from '../internal/conversation/TopicSelectorPolicyRegistry.js';
import type { StopPolicyRegistry } from '../public-types/conversation/stopPolicy.js';
import type { MessageLog } from '../public-types/messageLog/types.js';
import type { IEventBus } from '../public-types/eventbus/types.js';

/** Deep-merge patch for `AgentRuntimeManifest.communication` (harness-only; drives TTL, auto-join, topic sweeper). */
export type HarnessCommunicationManifestPatch = Partial<
    NonNullable<AgentRuntimeManifest['communication']>
>;

// --- DeepPartial utility ---
export type DeepPartial<T> = T extends object
    ? { [P in keyof T]?: DeepPartial<T[P]> }
    : T;

// --- Harness configuration ---
export const HarnessConfigSchema = z.object({
    deterministicTime: z.boolean().default(true),
    seedTokens: z.boolean().default(true),
    manifestProvenance: z.custom<ManifestProvenance>().optional(),
    maxTurns: z.number().int().positive().default(1),
    autoJoinInvitedTopics: z.boolean().default(false),
    /**
     * When true (default), topic selector / stop policies registered on the harness conversation service
     * must not call `Date.now`, `Date#getTime`, or `Math.random` inside `select` / `evaluate`.
     */
    policyPurityStrict: z.boolean().optional(),
    /** Alias for `policyPurityStrict` (documentation naming). */
    strictPolicies: z.boolean().optional(),
    /** Alias for `policyPurityStrict` (legacy spec token). */
    __strict__: z.boolean().optional(),
    /** Passed to `runLoop`: schedules `TaskEngine.triggerTopicLifecycleSweep` while the loop runs (requires `EngineLocator.setEngine`). */
    topicSweeper: z
        .object({
            intervalMs: z.number().int().positive(),
            batchSize: z.number().int().positive().max(10_000).optional(),
            autoArchiveAfterMs: z.number().int().positive(),
        })
        .strict()
        .optional(),
})
    .strict()
    .transform((v) => {
        const policyPurityStrict = v.__strict__ ?? v.strictPolicies ?? v.policyPurityStrict ?? true;
        return {
            ...v,
            policyPurityStrict,
        };
    });

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

// --- Deterministic LLM stub config ---
export const LLMStubResponseSchema = z.object({
    content: z.string(),
    role: z.string().default('assistant'),
    contentObject: z.unknown().optional(),
}).strict();

export type LLMStubResponse = z.infer<typeof LLMStubResponseSchema>;

// --- Harness internal state ---
export type HarnessState<Sensory = unknown> = {
    m: MentalState<Sensory>;
    env: EnvironmentState;
    inboxAll: Observation[];
    traces: TurnTrace[];
    replies: unknown[];
    errors: Error[];
    turnCount: number;
    childDispatches: Array<{ agent: string; input: unknown }>;
    /** When set, merges conversation deliveries from the session snapshot into `env.inbox` before each `runTurn`. */
    pullPersistedConversationObservations?: () => Promise<void>;
    /** Create a `conversation_threads` row so `conversation.send` works in harness (mirrors `startThread`). */
    seedConversationThread?: (params: {
        conversationId: string;
        ownerAgentId: string;
        participantAgentId: string;
    }) => Promise<void>;
    /** Deterministic instant for `ConversationService` invite TTL/expiry (via {@link import('../internal/conversation/Clock.js').Clock}). */
    inviteClockNowMs?: number;
    conversationTenantId?: string;
    conversationSessionManager?: SessionManager;
    inviteClock?: Clock;
    /** Same registries wired into the harness `ConversationService` (for `registerTopicSelectorPolicy` / `registerStopPolicy`). */
    harnessTopicSelectorPolicyRegistry?: TopicSelectorPolicyRegistry;
    harnessStopPolicyRegistry?: StopPolicyRegistry;
    /** Merged by `setCommunicationManifest` / `setCommunicationCapabilities`; read by `ConversationService` + `runLoop`. */
    harnessCommunication?: HarnessCommunicationManifestPatch;
    /** When set, `ConversationService` publishes invite events through this bus. */
    harnessEventBus?: IEventBus;
    /** When set, replaces the default DB-backed message log for the harness `ConversationService`. */
    harnessMessageLogOverride?: MessageLog;
    /** Reserved for future deterministic backpressure wiring (no runtime effect yet). */
    harnessDeterministicBackpressure?: boolean;
};

// --- Turn assertion context ---
export type TurnAssertionContext = {
    trace: TurnTrace;
    expectIntent(kind: Intent['kind']): TurnAssertionContext;
    expectShield(action: ShieldOutcome['action']): TurnAssertionContext;
    expectTransition(kind: TransitionOut['kind']): TurnAssertionContext;
    expectAwaitToken(token: string): TurnAssertionContext;
    expectStageTransition(from: string, to: string): TurnAssertionContext;
    expectStageBefore(stage: string): TurnAssertionContext;
    expectStageAfter(stage: string): TurnAssertionContext;
    expectInboxKinds(kinds: string[]): TurnAssertionContext;
    expectMemoryChanged(): TurnAssertionContext;
};
