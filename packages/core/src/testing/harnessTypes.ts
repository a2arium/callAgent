import { z } from 'zod';
import type { TransitionOut, ShieldOutcome } from '../loop/oneTurn.js';
import type { Intent } from '../types/intent.js';
import type { MentalState, EnvironmentState } from '../loop/types.js';
import type { Observation } from '../types/observation.js';
import type { TurnTrace, ManifestProvenance } from '../types/turnTrace.js';
import type { SessionManager } from '../orchestration/SessionManager.js';
import type { Clock } from '../internal/conversation/Clock.js';

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
}).strict();

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
