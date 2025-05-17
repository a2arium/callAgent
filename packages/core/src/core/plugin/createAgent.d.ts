import type { AgentPlugin, CreateAgentPluginOptions } from './types.js';
/**
 * Creates and registers an agent with the framework
 * @param options - Configuration options for the agent
 * @param metaUrl - import.meta.url from the caller for path resolution
 * @returns The created agent instance
 * @throws {ManifestError} If the manifest cannot be loaded or is invalid
 * @throws {PluginError} If agent creation fails for other reasons
 */
export declare const createAgent: (options: CreateAgentPluginOptions, metaUrl: string) => AgentPlugin;
/**
 * Minimal Agent Discovery & Loading Utility for the Runner
 * This is intentionally left simple/placeholder as the runner will dynamically import.
 * In a full framework, this would be more sophisticated (scanning node_modules, DI containers, etc.)
 * @param pluginDir - Directory to scan for agents
 */
export declare function loadPlugins(pluginDir: string): Promise<void>;
