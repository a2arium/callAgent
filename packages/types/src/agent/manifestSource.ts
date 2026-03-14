import { AgentCard } from './agentCard.js';
import { AgentRuntimeManifest } from './agentRuntimeManifest.js';

/**
 * Common source type for manifests
 */
export type ManifestSource<T> = 
  | { path: string } 
  | { inline: T };

/**
 * Identifies where a manifest was resolved from (for TurnTrace/provenance)
 */
export type ManifestResolutionSource = 'inline' | 'pathOverride' | 'defaultPath';

/**
 * Result of manifest resolution and validation
 */
export interface ResolvedManifests {
  agentCard: AgentCard;
  agentCardSource: ManifestResolutionSource;
  agentCardHash: string;
  
  runtimeManifest: AgentRuntimeManifest;
  runtimeManifestSource: ManifestResolutionSource;
  runtimeManifestHash: string;
}

/**
 * Result of manifest path discovery
 */
export interface DiscoveredManifestPaths {
  agentCardPath: string | null;
  runtimeManifestPath: string | null;
}
