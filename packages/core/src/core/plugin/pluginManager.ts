import { globalAgentRegistry } from './AgentRegistry.js';
import { AgentPlugin } from './types.js';
import { AgentDependencyResolver, AgentDiscoveryService, DependencyResolutionError } from './dependencies/index.js';
import { logger } from '@callagent/utils';

const pluginLogger = logger.createLogger({ prefix: 'PluginManager' });

/**
 * Load and register agent plugins
 */
export class PluginManager {
    /**
     * Register a single agent plugin
     */
    static registerAgent(agent: AgentPlugin): void {
        try {
            globalAgentRegistry.register(agent);
            pluginLogger.info('Agent plugin registered', {
                name: agent.manifest.name,
                version: agent.manifest.version
            });
        } catch (error) {
            pluginLogger.error('Failed to register agent plugin', error, {
                name: agent.manifest.name
            });
            throw error;
        }
    }

    /**
     * Find agent by name
     */
    static findAgent(name: string): AgentPlugin | null {
        return globalAgentRegistry.findByName(name);
    }

    /**
     * List all registered agents
     */
    static listAgents() {
        return globalAgentRegistry.listAgents();
    }

    /**
     * Load an agent with all its dependencies in the correct order
     * @param agentNameOrPath - Agent name or file path to resolve dependencies for
     * @returns Array of loaded agent plugins in dependency order
     * @throws DependencyResolutionError if resolution fails
     */
    static async loadAgentWithDependencies(agentNameOrPath: string): Promise<AgentPlugin[]> {
        pluginLogger.info('Loading agent with dependencies', { agentNameOrPath });

        try {
            // Extract agent name from file path if necessary
            const agentName = this.extractAgentNameFromPath(agentNameOrPath);
            pluginLogger.debug('Extracted agent name', { original: agentNameOrPath, extracted: agentName });

            // Resolve dependencies and get loading order
            const resolution = await AgentDependencyResolver.resolveDependencies(agentName);
            const loadedAgents: AgentPlugin[] = [];

            pluginLogger.info('Dependency resolution completed', {
                agentNameOrPath,
                agentName,
                loadingOrder: resolution.loadingOrder,
                totalAgents: resolution.allAgents.length,
                warnings: resolution.warnings
            });

            // Load agents in dependency order
            for (const agentName of resolution.loadingOrder) {
                if (!this.isAgentLoaded(agentName)) {
                    const agentPlugin = await this.loadAgent(agentName);
                    if (agentPlugin) {
                        loadedAgents.push(agentPlugin);
                    }
                } else {
                    pluginLogger.debug('Agent already loaded, skipping', { agentName });
                    const existingAgent = this.findAgent(agentName);
                    if (existingAgent) {
                        loadedAgents.push(existingAgent);
                    }
                }
            }

            pluginLogger.info('All dependencies loaded successfully', {
                agentNameOrPath,
                loadedCount: loadedAgents.length
            });

            return loadedAgents;

        } catch (error) {
            pluginLogger.error('Failed to load agent with dependencies', error, { agentNameOrPath });
            throw error;
        }
    }

    /**
     * Load a single agent by name or path
     * @param agentNameOrPath - Agent name or file path
     * @returns Loaded agent plugin or null if not found
     */
    static async loadAgent(agentNameOrPath: string): Promise<AgentPlugin | null> {
        pluginLogger.debug('Loading single agent', { agentNameOrPath });

        try {
            // Find the agent file
            const agentPath = await AgentDiscoveryService.findAgentFile(agentNameOrPath);
            if (!agentPath) {
                pluginLogger.warn('Agent file not found', {
                    agentNameOrPath,
                    searchPaths: AgentDiscoveryService.getAgentSearchPaths()
                });
                return null;
            }

            // Convert to absolute path and file URL for proper importing
            const path = await import('node:path');
            const { pathToFileURL } = await import('node:url');

            const absolutePath = path.resolve(agentPath);
            const fileUrl = pathToFileURL(absolutePath).href;

            pluginLogger.debug('Importing agent module', {
                agentNameOrPath,
                agentPath,
                absolutePath,
                fileUrl
            });

            // Track agents before import to detect newly registered agents
            const agentsBefore = new Set(this.listAgents().map(a => a.name));

            // Dynamically import the agent module
            // The import should trigger createAgent() which registers the agent
            const agentModule = await import(fileUrl);

            // Give the agent a moment to register itself
            await new Promise(resolve => setTimeout(resolve, 10));

            // Find the registered agent - first try by the search name
            let loadedAgent = this.findAgent(agentNameOrPath);

            // If not found by search name, find the newly registered agent
            if (!loadedAgent) {
                const agentsAfter = this.listAgents();
                const newAgents = agentsAfter.filter(a => !agentsBefore.has(a.name));

                if (newAgents.length === 1) {
                    // Exactly one new agent was registered - this must be it
                    loadedAgent = this.findAgent(newAgents[0].name);
                    pluginLogger.debug('Found newly registered agent after import', {
                        searchName: agentNameOrPath,
                        foundName: newAgents[0].name,
                        path: agentPath
                    });
                } else if (newAgents.length > 1) {
                    pluginLogger.warn('Multiple agents registered during import, cannot determine which one to use', {
                        searchName: agentNameOrPath,
                        newAgents: newAgents.map(a => a.name),
                        path: agentPath
                    });
                }
            }

            if (loadedAgent) {
                pluginLogger.info('Agent loaded successfully', {
                    agentName: loadedAgent.manifest.name,
                    version: loadedAgent.manifest.version,
                    path: agentPath
                });
                return loadedAgent;
            }

            pluginLogger.warn('Agent imported but not found in registry', { agentNameOrPath, agentPath });
            return null;

        } catch (error) {
            pluginLogger.error('Failed to load agent', error, { agentNameOrPath });
            return null;
        }
    }

    /**
     * Check if an agent is already loaded (registered)
     * @param agentName - Name of the agent to check
     * @returns True if agent is loaded
     */
    static isAgentLoaded(agentName: string): boolean {
        return this.findAgent(agentName) !== null;
    }

    /**
     * Unload an agent (remove from registry)
     * @param agentName - Name of the agent to unload
     * @returns True if agent was unloaded
     */
    static unloadAgent(agentName: string): boolean {
        const agent = this.findAgent(agentName);
        if (agent) {
            // Note: AgentRegistry doesn't have unregister method yet
            // This would need to be implemented in AgentRegistry
            pluginLogger.info('Agent unloaded', { agentName });
            return true;
        }
        return false;
    }

    /**
     * Get dependency information for an agent
     * @param agentName - Name of the agent
     * @returns Dependency resolution result or null if agent not found
     */
    static async getAgentDependencies(agentName: string): Promise<{ dependencies: string[]; hasDependencies: boolean } | null> {
        try {
            const dependencies = await AgentDependencyResolver.getImmediateDependencies(agentName);
            return {
                dependencies,
                hasDependencies: dependencies.length > 0
            };
        } catch (error) {
            pluginLogger.warn('Failed to get agent dependencies', error, { agentName });
            return null;
        }
    }

    /**
     * List all discoverable agents (not necessarily loaded)
     * @returns Array of discoverable agents with their paths
     */
    static async listDiscoverableAgents(): Promise<Array<{ name: string; agentPath: string; manifestPath: string | null }>> {
        try {
            return await AgentDiscoveryService.listAvailableAgents();
        } catch (error) {
            pluginLogger.error('Failed to list discoverable agents', error);
            return [];
        }
    }

    /**
     * Extract agent name from a file path or return as-is if it's already an agent name
     * @param agentNameOrPath - Agent name or file path
     * @returns Extracted agent name
     * 
     * Examples:
     * - 'hello-agent' -> 'hello-agent'
     * - 'apps/examples/hello-agent/dist/AgentModule.js' -> 'hello-agent'
     * - 'apps/examples/coordinator-agent/AgentModule.ts' -> 'coordinator-agent'
     */
    private static extractAgentNameFromPath(agentNameOrPath: string): string {
        // If it doesn't look like a path (no slashes), return as-is
        if (!agentNameOrPath.includes('/') && !agentNameOrPath.includes('\\')) {
            return agentNameOrPath;
        }

        // Split the path and find the part that looks like an agent directory
        const parts = agentNameOrPath.replace(/\\/g, '/').split('/');

        // Look for common patterns:
        // - apps/examples/{agent-name}/...
        // - examples/{agent-name}/...
        // - {agent-name}/...

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];

            // Skip common path prefixes
            if (part === 'apps' || part === 'examples' || part === 'dist' || part === 'src') {
                continue;
            }

            // Skip file names (containing dots)
            if (part.includes('.')) {
                continue;
            }

            // If this part looks like an agent name (contains dashes or is a simple name)
            if (part && (part.includes('-') || (part.length > 2 && !part.includes('.')))) {
                return part;
            }
        }

        // Fallback: use the last directory name before any file
        const fileNameIndex = parts.findIndex(part => part.includes('.'));
        if (fileNameIndex > 0) {
            return parts[fileNameIndex - 1];
        }

        // Last resort: use the second-to-last part if it exists
        if (parts.length >= 2) {
            return parts[parts.length - 2];
        }

        // Ultimate fallback: return the original string
        return agentNameOrPath;
    }
} 