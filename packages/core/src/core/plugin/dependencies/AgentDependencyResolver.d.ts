import { AgentManifest } from '@a2arium/callagent-types';
/**
 * Error thrown when dependency resolution fails
 */
export declare class DependencyResolutionError extends Error {
    details?: Record<string, unknown> | undefined;
    constructor(message: string, details?: Record<string, unknown> | undefined);
}
/**
 * Result of dependency resolution
 */
export interface DependencyResolutionResult {
    /** Agents in dependency order (dependencies first, dependents last) */
    loadingOrder: string[];
    /** All agents involved in the resolution */
    allAgents: string[];
    /** Dependency graph representation */
    dependencyGraph: Map<string, string[]>;
    /** Any warnings encountered during resolution */
    warnings: string[];
}
/**
 * Core service for resolving agent dependencies
 * Handles recursive dependency resolution and circular dependency detection
 */
export declare class AgentDependencyResolver {
    /**
     * Resolve dependencies for an agent and return loading order
     * Supports both folder-based and filename-based discovery
     * @param rootAgent - Name of the root agent to resolve dependencies for
     * @param contextPath - Optional context path for same-folder discovery
     * @returns Dependency resolution result with loading order
     * @throws DependencyResolutionError if resolution fails
     */
    static resolveDependencies(rootAgent: string, contextPath?: string): Promise<DependencyResolutionResult>;
    /**
     * Check for circular dependencies in a dependency graph
     * @param dependencyGraph - Map of agent name to its dependencies
     * @returns Array representing circular dependency path, or null if none found
     */
    static detectCircularDependencies(dependencyGraph: Map<string, string[]>): string[] | null;
    /**
     * Load and validate manifest for an agent
     * Supports inline manifests, agent.json files, and same-directory discovery
     * @param agentName - Name of the agent
     * @param contextPath - Optional context path for same-directory discovery
     * @returns Validated agent manifest
     * @throws DependencyResolutionError if manifest cannot be loaded or is invalid
     */
    static loadManifest(agentName: string, contextPath?: string): Promise<AgentManifest>;
    /**
     * Build dependency graph recursively
     * @param agentName - Current agent to process
     * @param visited - Set of already visited agents
     * @param graph - Dependency graph being built
     * @param warnings - Array to collect warnings
     * @param contextPath - Optional context path for same-folder discovery
     */
    private static buildDependencyGraph;
    /**
     * Depth-first search for circular dependency detection
     * @param agent - Current agent being checked
     * @param graph - Dependency graph
     * @param visiting - Set of agents currently being visited (in current path)
     * @param visited - Set of completely processed agents
     * @param path - Current path for tracking cycles
     * @returns Circular dependency path if found, null otherwise
     */
    private static dfsCircularCheck;
    /**
     * Perform topological sort to determine loading order
     * Dependencies come first, dependents come last
     * @param graph - Dependency graph
     * @returns Array of agents in dependency order
     */
    private static topologicalSort;
    /**
     * Get immediate dependencies for an agent (non-recursive)
     * @param agentName - Name of the agent
     * @returns Array of immediate dependencies
     */
    static getImmediateDependencies(agentName: string): Promise<string[]>;
    /**
     * Check if an agent has any dependencies
     * @param agentName - Name of the agent
     * @returns True if agent has dependencies
     */
    static hasDependencies(agentName: string): Promise<boolean>;
}
