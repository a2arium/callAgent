import fs from 'node:fs/promises';
import { AgentManifest, isAgentManifest } from '@callagent/types';
import { ManifestValidator } from '../ManifestValidator.js';
import { AgentDiscoveryService } from './AgentDiscoveryService.js';
import { logger } from '@callagent/utils';

const resolverLogger = logger.createLogger({ prefix: 'DependencyResolver' });

/**
 * Error thrown when dependency resolution fails
 */
export class DependencyResolutionError extends Error {
    constructor(message: string, public details?: Record<string, unknown>) {
        super(message);
        this.name = 'DependencyResolutionError';
    }
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
export class AgentDependencyResolver {
    /**
     * Resolve dependencies for an agent and return loading order
     * Supports both folder-based and filename-based discovery
     * @param rootAgent - Name of the root agent to resolve dependencies for
     * @param contextPath - Optional context path for same-folder discovery
     * @returns Dependency resolution result with loading order
     * @throws DependencyResolutionError if resolution fails
     */
    static async resolveDependencies(rootAgent: string, contextPath?: string): Promise<DependencyResolutionResult> {
        resolverLogger.info('Starting dependency resolution', { rootAgent, contextPath });

        const visited = new Set<string>();
        const dependencyGraph = new Map<string, string[]>();
        const warnings: string[] = [];

        try {
            // Build the complete dependency graph
            await this.buildDependencyGraph(rootAgent, visited, dependencyGraph, warnings, contextPath);

            // Check for circular dependencies
            const circularDependency = this.detectCircularDependencies(dependencyGraph);
            if (circularDependency) {
                throw new DependencyResolutionError(
                    `Circular dependency detected: ${circularDependency.join(' -> ')}`,
                    { rootAgent, circularDependency, dependencyGraph: Object.fromEntries(dependencyGraph) }
                );
            }

            // Determine loading order using topological sort
            const loadingOrder = this.topologicalSort(dependencyGraph);
            const allAgents = Array.from(dependencyGraph.keys());

            const result: DependencyResolutionResult = {
                loadingOrder,
                allAgents,
                dependencyGraph,
                warnings
            };

            resolverLogger.info('Dependency resolution completed successfully', {
                rootAgent,
                loadingOrder,
                totalAgents: allAgents.length,
                warningCount: warnings.length
            });

            return result;

        } catch (error) {
            if (error instanceof DependencyResolutionError) {
                resolverLogger.error('Dependency resolution failed', error, { rootAgent });
                throw error;
            }

            const message = error instanceof Error ? error.message : String(error);
            resolverLogger.error('Unexpected error during dependency resolution', error, { rootAgent });
            throw new DependencyResolutionError(
                `Unexpected error during dependency resolution for '${rootAgent}': ${message}`,
                { rootAgent, originalError: error }
            );
        }
    }

    /**
     * Check for circular dependencies in a dependency graph
     * @param dependencyGraph - Map of agent name to its dependencies
     * @returns Array representing circular dependency path, or null if none found
     */
    static detectCircularDependencies(dependencyGraph: Map<string, string[]>): string[] | null {
        const visiting = new Set<string>();
        const visited = new Set<string>();
        const path: string[] = [];

        for (const agent of dependencyGraph.keys()) {
            if (!visited.has(agent)) {
                const cycle = this.dfsCircularCheck(agent, dependencyGraph, visiting, visited, path);
                if (cycle) {
                    return cycle;
                }
            }
        }

        return null;
    }

    /**
     * Load and validate manifest for an agent
     * Supports inline manifests, agent.json files, and same-directory discovery
     * @param agentName - Name of the agent
     * @param contextPath - Optional context path for same-directory discovery
     * @returns Validated agent manifest
     * @throws DependencyResolutionError if manifest cannot be loaded or is invalid
     */
    static async loadManifest(agentName: string, contextPath?: string): Promise<AgentManifest> {
        resolverLogger.debug('Loading manifest', { agentName, contextPath });

        try {
            // First check if agent is already registered with an inline manifest
            const { PluginManager } = await import('../pluginManager.js');
            const registeredAgent = PluginManager.findAgent(agentName);

            if (registeredAgent) {
                resolverLogger.debug('Found registered agent with inline manifest', {
                    agentName,
                    manifestName: registeredAgent.manifest.name
                });

                // Validate the inline manifest content
                const validationResult = ManifestValidator.validate(registeredAgent.manifest);
                if (!validationResult.isValid) {
                    throw new DependencyResolutionError(
                        `Inline manifest validation failed for agent '${agentName}': ${validationResult.errors.join(', ')}`,
                        { agentName, errors: validationResult.errors, source: 'inline' }
                    );
                }

                return registeredAgent.manifest;
            }

            // If we have a context path, try to load the agent from the same directory
            if (contextPath) {
                const agentPath = await AgentDiscoveryService.findAgentFile(agentName, contextPath);
                if (agentPath) {
                    resolverLogger.debug('Found agent file in same directory, attempting to load', {
                        agentName,
                        agentPath,
                        contextPath
                    });

                    // Load the agent to register its inline manifest
                    const loadedAgent = await PluginManager.loadAgent(agentName, contextPath);
                    if (loadedAgent) {
                        resolverLogger.debug('Successfully loaded agent from same directory', {
                            agentName,
                            manifestName: loadedAgent.manifest.name
                        });

                        // Validate the inline manifest content
                        const validationResult = ManifestValidator.validate(loadedAgent.manifest);
                        if (!validationResult.isValid) {
                            throw new DependencyResolutionError(
                                `Inline manifest validation failed for agent '${agentName}': ${validationResult.errors.join(', ')}`,
                                { agentName, errors: validationResult.errors, source: 'same-directory' }
                            );
                        }

                        return loadedAgent.manifest;
                    }
                }
            }

            // Fall back to agent.json discovery (only in folders matching agent name)
            const manifestPath = await AgentDiscoveryService.findManifestFile(agentName, contextPath);
            if (!manifestPath) {
                throw new DependencyResolutionError(
                    `Manifest not found for agent '${agentName}'. ` +
                    `Agent must either be registered with inline manifest or have agent.json in folder named '${agentName}'.`,
                    { agentName, searchPaths: AgentDiscoveryService.getManifestSearchPaths(), contextPath }
                );
            }

            const manifestContent = await fs.readFile(manifestPath, 'utf8');
            const manifest = JSON.parse(manifestContent);

            // Validate manifest structure
            if (!isAgentManifest(manifest)) {
                throw new DependencyResolutionError(
                    `Invalid manifest structure for agent '${agentName}'`,
                    { agentName, manifestPath }
                );
            }

            // Validate that agent name matches folder structure for agent.json
            // Support both traditional and category-based naming
            const validateAgentNameStructure = (manifestName: string, expectedName: string): boolean => {
                // Direct match (traditional)
                if (manifestName === expectedName) {
                    return true;
                }

                // Category-based match: if expectedName is 'category/agent', 
                // manifestName should also be 'category/agent'
                if (expectedName.includes('/') && manifestName === expectedName) {
                    return true;
                }

                return false;
            };

            if (!validateAgentNameStructure(manifest.name, agentName)) {
                const expectedStructure = agentName.includes('/')
                    ? `category-based name '${agentName}'`
                    : `simple name '${agentName}'`;

                throw new DependencyResolutionError(
                    `agent.json can only be used when agent name matches expected structure. ` +
                    `Expected ${expectedStructure}, got '${manifest.name}'.`,
                    { agentName, manifestPath, expectedName: agentName, actualName: manifest.name }
                );
            }

            // Validate manifest content
            const validationResult = ManifestValidator.validate(manifest);
            if (!validationResult.isValid) {
                throw new DependencyResolutionError(
                    `Manifest validation failed for agent '${agentName}': ${validationResult.errors.join(', ')}`,
                    { agentName, manifestPath, errors: validationResult.errors }
                );
            }

            resolverLogger.debug('Manifest loaded successfully from agent.json', { agentName, manifestPath });
            return manifest;

        } catch (error) {
            if (error instanceof DependencyResolutionError) {
                throw error;
            }

            throw new DependencyResolutionError(
                `Failed to load manifest for agent '${agentName}': ${error instanceof Error ? error.message : String(error)}`,
                { agentName, originalError: error }
            );
        }
    }

    /**
     * Build dependency graph recursively
     * @param agentName - Current agent to process
     * @param visited - Set of already visited agents
     * @param graph - Dependency graph being built
     * @param warnings - Array to collect warnings
     * @param contextPath - Optional context path for same-folder discovery
     */
    private static async buildDependencyGraph(
        agentName: string,
        visited: Set<string>,
        graph: Map<string, string[]>,
        warnings: string[],
        contextPath?: string
    ): Promise<void> {
        if (visited.has(agentName)) {
            return; // Already processed
        }

        visited.add(agentName);
        resolverLogger.debug('Processing agent dependencies', { agentName });

        try {
            const manifest = await this.loadManifest(agentName, contextPath);
            const dependencies = manifest.dependencies?.agents || [];

            // Add agent to graph with its dependencies
            graph.set(agentName, [...dependencies]); // Copy array to avoid mutations

            // Recursively process each dependency
            for (const dependency of dependencies) {
                if (dependency === agentName) {
                    // Self-reference should have been caught by ManifestValidator, but double-check
                    throw new DependencyResolutionError(
                        `Agent '${agentName}' cannot depend on itself`,
                        { agentName, dependency }
                    );
                }

                // Validate dependency exists
                const dependencyStructure = await AgentDiscoveryService.validateAgentStructure(dependency, contextPath);
                if (!dependencyStructure.isValid) {
                    throw new DependencyResolutionError(
                        `Dependency '${dependency}' not found for agent '${agentName}'`,
                        {
                            agentName,
                            dependency,
                            errors: dependencyStructure.errors,
                            searchPaths: AgentDiscoveryService.getAgentSearchPaths()
                        }
                    );
                }

                // Recursively resolve dependencies
                await this.buildDependencyGraph(dependency, visited, graph, warnings, contextPath);
            }

            if (dependencies.length > 0) {
                resolverLogger.debug('Agent dependencies processed', {
                    agentName,
                    dependencies,
                    dependencyCount: dependencies.length
                });
            }

        } catch (error) {
            if (error instanceof DependencyResolutionError) {
                throw error;
            }

            throw new DependencyResolutionError(
                `Failed to process dependencies for agent '${agentName}': ${error instanceof Error ? error.message : String(error)}`,
                { agentName, originalError: error }
            );
        }
    }

    /**
     * Depth-first search for circular dependency detection
     * @param agent - Current agent being checked
     * @param graph - Dependency graph
     * @param visiting - Set of agents currently being visited (in current path)
     * @param visited - Set of completely processed agents
     * @param path - Current path for tracking cycles
     * @returns Circular dependency path if found, null otherwise
     */
    private static dfsCircularCheck(
        agent: string,
        graph: Map<string, string[]>,
        visiting: Set<string>,
        visited: Set<string>,
        path: string[]
    ): string[] | null {
        if (visiting.has(agent)) {
            // Found a cycle - return the cycle path
            const cycleStart = path.indexOf(agent);
            return path.slice(cycleStart);
        }

        if (visited.has(agent)) {
            return null; // Already processed this branch
        }

        visiting.add(agent);
        path.push(agent);

        const dependencies = graph.get(agent) || [];
        for (const dependency of dependencies) {
            const cycle = this.dfsCircularCheck(dependency, graph, visiting, visited, path);
            if (cycle) {
                return cycle;
            }
        }

        visiting.delete(agent);
        visited.add(agent);
        path.pop();

        return null;
    }

    /**
     * Perform topological sort to determine loading order
     * Dependencies come first, dependents come last
     * @param graph - Dependency graph
     * @returns Array of agents in dependency order
     */
    private static topologicalSort(graph: Map<string, string[]>): string[] {
        const result: string[] = [];
        const visited = new Set<string>();
        const temp = new Set<string>();

        const visit = (agent: string): void => {
            if (temp.has(agent)) {
                // This should not happen if circular dependency check passed
                throw new DependencyResolutionError(`Circular dependency detected during topological sort involving '${agent}'`);
            }

            if (!visited.has(agent)) {
                temp.add(agent);

                const dependencies = graph.get(agent) || [];
                for (const dependency of dependencies) {
                    visit(dependency);
                }

                temp.delete(agent);
                visited.add(agent);
                result.push(agent); // Add after visiting dependencies
            }
        };

        // Visit all agents in the graph
        for (const agent of graph.keys()) {
            if (!visited.has(agent)) {
                visit(agent);
            }
        }

        // Reverse to get correct order: dependencies first, dependents last
        return result.reverse();
    }

    /**
     * Get immediate dependencies for an agent (non-recursive)
     * @param agentName - Name of the agent
     * @returns Array of immediate dependencies
     */
    static async getImmediateDependencies(agentName: string): Promise<string[]> {
        try {
            const manifest = await this.loadManifest(agentName);
            return manifest.dependencies?.agents || [];
        } catch (error) {
            resolverLogger.warn('Failed to get immediate dependencies', error, { agentName });
            return [];
        }
    }

    /**
     * Check if an agent has any dependencies
     * @param agentName - Name of the agent
     * @returns True if agent has dependencies
     */
    static async hasDependencies(agentName: string): Promise<boolean> {
        const dependencies = await this.getImmediateDependencies(agentName);
        return dependencies.length > 0;
    }
} 