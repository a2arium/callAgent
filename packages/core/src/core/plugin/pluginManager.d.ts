import { AgentPlugin } from './types.js';
/**
 * Load and register agent plugins
 */
export declare class PluginManager {
    /**
     * Register a single agent plugin
     */
    static registerAgent(agent: AgentPlugin): void;
    /**
     * Find agent by name
     */
    static findAgent(name: string): AgentPlugin | null;
    /**
     * List all registered agents
     */
    static listAgents(): import("../../index.js").AgentManifest[];
    /**
     * Load an agent and all its dependencies in the correct order
     * Supports both folder-based and filename-based discovery
     * @param agentNameOrPath - Agent name or file path
     * @returns Array of loaded agent plugins in dependency order
     */
    static loadAgentWithDependencies(agentNameOrPath: string): Promise<AgentPlugin[]>;
    /**
     * Load a single agent by name or path
     * Supports direct file paths, folder-based discovery, and filename-based discovery
     * @param agentNameOrPath - Agent name or file path
     * @param contextPath - Optional context path for same-folder discovery
     * @returns Loaded agent plugin or null if not found
     */
    static loadAgent(agentNameOrPath: string, contextPath?: string): Promise<AgentPlugin | null>;
    /**
     * Check if an agent is already loaded (registered)
     * @param agentName - Name of the agent to check
     * @returns True if agent is loaded
     */
    static isAgentLoaded(agentName: string): boolean;
    /**
     * Unload an agent (remove from registry)
     * @param agentName - Name of the agent to unload
     * @returns True if agent was unloaded
     */
    static unloadAgent(agentName: string): boolean;
    /**
     * Get dependency information for an agent
     * @param agentName - Name of the agent
     * @returns Dependency resolution result or null if agent not found
     */
    static getAgentDependencies(agentName: string): Promise<{
        dependencies: string[];
        hasDependencies: boolean;
    } | null>;
    /**
     * List all discoverable agents (not necessarily loaded)
     * @returns Array of discoverable agents with their paths
     */
    static listDiscoverableAgents(): Promise<Array<{
        name: string;
        agentPath: string;
        manifestPath: string | null;
    }>>;
}
