import { z } from 'zod';

const uniqueNonEmptyStrings = z.array(z.string().trim().min(1)).superRefine((values, ctx) => {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Values must be unique' });
  }
});

const declarableIntentIdentifiers = uniqueNonEmptyStrings.superRefine((values, ctx) => {
  const wrappers = new Set(['prompt_user', 'answer_with_llm', 'call_tool', 'delegate_to_child']);
  values.forEach((value, index) => {
    if (wrappers.has(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Generic intent wrapper "${value}" cannot be configured as a domain intent`, path: [index] });
    }
  });
});

/**
 * Agent Runtime Manifest Schema (Internal Execution Contract)
 *
 * Normative spec: apps/docs/2-manifest_spec_agent_card_runtime_manifest.md
 *
 * NOTE: This schema uses .strict() to ensure internal configuration
 * is precisely defined and to prevent accidental property name typos.
 * Per spec, custom settings should be placed under 'config' rather than
 * as ad-hoc top-level fields.
 */
export const AgentRuntimeManifestSchema = z.object({
  /** MUST match AgentCard.name */
  name: z.string().min(1),
  /** MUST match AgentCard.version */
  version: z.string().min(1),

  /** Spec amendment: execution mode */
  runMode: z.enum(['loop', 'legacy']).optional().default('loop'),

  /** Optional reference to the public Agent Card URL */
  agentCardRef: z.string().url().optional(),

  /** Loop budgets (control-plane constraints) */
  budgets: z.object({
    maxTurns: z.number().int().positive().optional(),
    latencyMs: z.number().int().positive().optional(),
    maxConcurrentEffects: z.number().int().positive().optional(),
  }).strict().optional(),

  /** Human-in-the-loop policy */
  hitl: z.object({
    level: z.enum(['advise', 'consent', 'guardrails']).optional(),
    consentTtlMs: z.number().int().positive().optional().default(86_400_000),
    requireConsentFor: z.object({
      intents: declarableIntentIdentifiers.optional(),
      tools: uniqueNonEmptyStrings.optional(),
    }).strict().optional(),
  }).strict().optional(),

  /** Safety configuration */
  safety: z.object({
    sanitize: z.boolean().optional(),
    piiPatterns: z.array(z.string()).optional(),
    costLimitUsd: z.number().positive().optional(),
    mode: z.enum(['transform', 'reject']).optional(),
  }).strict().optional(),

  /** Result caching behavior */
  cache: z.object({
    enabled: z.boolean().optional(),
    ttlSeconds: z.number().int().positive().optional(),
    excludePaths: z.array(z.string()).optional(),
  }).strict().optional(),

  /** Runtime feature flags and internal knobs */
  config: z.object({
    enableValidation: z.boolean().optional(),
    validationCoverageThreshold: z.number().min(0).max(1).optional(),
    featureFlags: z.record(z.string(), z.boolean()).optional(),
  }).passthrough().optional(), // passthrough here for arbitrary internal data

  /** Internal dependencies for deployment/packaging */
  dependencies: z.object({
    agents: z.array(z.string()).optional(),
  }).strict().optional(),

  /** Explicit orchestration privileges granted to this agent. */
  orchestration: z.object({
    rootTaskSubmission: z.object({
      allowAgents: uniqueNonEmptyStrings,
    }).strict().optional(),
  }).strict().optional(),

  /** Memory configuration */
  memory: z.object({
    profile: z.string().optional(),
  }).strict().optional(),

  /** Observability toggles */
  observability: z.object({
    turnTrace: z.object({
      enabled: z.boolean().optional(),
      level: z.enum(['summary', 'full']).optional(),
    }).strict().optional(),
    logs: z.object({
      level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
    }).strict().optional(),
  }).strict().optional(),

  /** Communication behavior hints for framework-level conversation handling */
  communication: z.object({
    autoJoinInvitedTopics: z.boolean().optional().default(false),
    /**
     * Idle TTL for conversation threads in milliseconds.
     * When omitted, the framework default (1 hour) applies.
     * When `null`, TTL is disabled for this agent (threads never auto-expire).
     */
    threadTtlMs: z.union([z.number().int().positive(), z.null()]).optional(),
    /**
     * While an agent loop is running, periodically auto-archive **closed** topics older than
     * `autoArchiveAfterMs` (requires a registered framework `TaskEngine`).
     * Omit `topicSweeper` to disable scheduled sweeps (manual `triggerTopicLifecycleSweep` still works).
     */
    topicSweeper: z
      .object({
        intervalMs: z.number().int().positive(),
        batchSize: z.number().int().positive().max(10_000).optional(),
        autoArchiveAfterMs: z.number().int().positive(),
      })
      .strict()
      .optional(),
    /** When false, other agents cannot open threads targeting this agent (Phase 4d). Default: allow. */
    threadable: z.boolean().optional(),
    /**
     * When true, a topic message delivery cold-starts a turn on this agent. Default false (observation
     * is queued for the next natural wake).
     */
    wakeOnTopicMessage: z.boolean().optional().default(false),
    /** If set, only these speech acts are accepted for inbound thread/topic deliveries. */
    acceptedSpeechActs: z
      .array(
        z.enum([
          'question',
          'answer',
          'inform',
          'request',
          'task',
          'followup',
          'signal',
          'vote',
          'system',
        ])
      )
      .optional(),
    /** If set, inbound content must declare a matching `mimeType` when provided as an object. */
    acceptedContentTypes: z.array(z.string().min(1)).optional(),
    /** Optional JSON Schema blobs keyed by a stable id (validation hooks may use these in future). */
    jsonSchemas: z.record(z.string(), z.unknown()).optional(),
    /** Declared policy capability tokens (e.g. `selector_policy:my.policy`, `stop_custom:my.stop`). */
    topicPoliciesSupported: z.array(z.string().min(1)).optional(),
  }).strict().optional(),
}).strict();

export type AgentRuntimeManifest = z.infer<typeof AgentRuntimeManifestSchema>;
