import { z } from 'zod';

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
    requireConsentFor: z.object({
      intents: z.array(z.string()).optional(),
      tools: z.array(z.string()).optional(),
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
}).strict();

export type AgentRuntimeManifest = z.infer<typeof AgentRuntimeManifestSchema>;
