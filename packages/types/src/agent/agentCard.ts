import { z } from 'zod';

/**
 * Agent Card Schema (A2A Discovery Contract)
 *
 * Normative spec: apps/docs/2-manifest_spec_agent_card_runtime_manifest.md
 * A2A Protocol spec: https://a2a-protocol.org/v1.0.0/specification
 *
 * NOTE: This schema does NOT use .strict() because A2A allows for
 * unknown fields and extensions that the framework should ignore but preserve.
 */
export const AgentCardSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),

  supportedInterfaces: z.array(z.object({
    url: z.string().url(),
    protocolBinding: z.enum(['JSONRPC', 'GRPC', 'HTTP+JSON']),
    protocolVersion: z.string(),
  })).min(1),

  capabilities: z.object({
    streaming: z.boolean().optional(),
    pushNotifications: z.boolean().optional(),
    extendedAgentCard: z.boolean().optional(),
    stateTransitionHistory: z.boolean().optional(),
    extensions: z.array(z.object({
      uri: z.string().url(),
      required: z.boolean(),
    })).optional(),
  }),

  defaultInputModes: z.array(z.string()),  // Media types like "text/plain", "application/json"
  defaultOutputModes: z.array(z.string()), // Media types like "text/plain", "application/json"

  skills: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    tags: z.array(z.string()).optional(),
    examples: z.array(z.string()).optional(),
    inputModes: z.array(z.string()).optional(),
    outputModes: z.array(z.string()).optional(),
  })).min(1),

  // Optional A2A metadata
  url: z.string().optional(),
  provider: z.object({
    organization: z.string(),
    url: z.string().optional(),
  }).optional(),
  documentationUrl: z.string().optional(),
  iconUrl: z.string().optional(),
});

export type AgentCard = z.infer<typeof AgentCardSchema>;
