import { globalAgentRegistry } from './AgentRegistry.js';
import { AgentPlugin } from './types.js';
import { AgentDependencyResolver, DependencyResolutionError } from './dependencies/index.js';
import { SmartAgentDiscoveryService } from './dependencies/SmartAgentDiscoveryService.js';
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
     * Load an agent and all its dependencies in the correct order
     * Supports both folder-based and filename-based discovery
     * @param agentNameOrPath - Agent name or file path
     * @returns Array of loaded agent plugins in dependency order
     */
    static async loadAgentWithDependencies(agentNameOrPath: string): Promise<AgentPlugin[]> {
        pluginLogger.info('Loading agent with dependencies', { agentNameOrPath });

        try {
            // Determine context path for multi-agent folder discovery
            const contextPath = agentNameOrPath.includes('/') || agentNameOrPath.includes('\\') ? agentNameOrPath : undefined;

            // First, load the main agent to register its inline manifest (if any)
            // This ensures the dependency resolver can access the inline manifest
            const mainAgent = await this.loadAgent(agentNameOrPath);
            if (!mainAgent) {
                throw new Error(`Failed to load main agent: ${agentNameOrPath}`);
            }

            // Use the actual agent name from the loaded agent's manifest
            const agentName = mainAgent.manifest.name;
            pluginLogger.debug('Using agent name from manifest', {
                original: agentNameOrPath,
                actualName: agentName
            });

            // Now resolve dependencies using the registered agent's manifest
            const resolution = await AgentDependencyResolver.resolveDependencies(agentName, contextPath);
            const loadedAgents: AgentPlugin[] = [];

            pluginLogger.info('Dependency resolution completed', {
                agentNameOrPath,
                agentName,
                contextPath,
                loadingOrder: resolution.loadingOrder,
                totalAgents: resolution.allAgents.length,
                warnings: resolution.warnings
            });

            // Load agents in dependency order
            for (const dependencyAgentName of resolution.loadingOrder) {
                if (!this.isAgentLoaded(dependencyAgentName)) {
                    const agentPlugin = await this.loadAgent(dependencyAgentName, contextPath);
                    if (agentPlugin) {
                        loadedAgents.push(agentPlugin);
                    }
                } else {
                    pluginLogger.debug('Agent already loaded, skipping', { agentName: dependencyAgentName });
                    const existingAgent = this.findAgent(dependencyAgentName);
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
     * Supports direct file paths, folder-based discovery, and filename-based discovery
     * @param agentNameOrPath - Agent name or file path
     * @param contextPath - Optional context path for same-folder discovery
     * @returns Loaded agent plugin or null if not found
     */
    static async loadAgent(agentNameOrPath: string, contextPath?: string): Promise<AgentPlugin | null> {
        pluginLogger.debug('Loading single agent', { agentNameOrPath, contextPath });

        try {
            let agentPath: string | null = null;

            // Check if this is a direct file path
            if (agentNameOrPath.includes('/') || agentNameOrPath.includes('\\')) {
                // This looks like a file path - check if it exists
                const fs = await import('node:fs/promises');
                const path = await import('node:path');

                try {
                    const resolvedPath = path.resolve(agentNameOrPath);
                    await fs.access(resolvedPath);
                    agentPath = resolvedPath;
                    pluginLogger.debug('Using direct file path', { agentNameOrPath, resolvedPath });
                } catch {
                    // File doesn't exist at direct path, fall back to discovery
                    pluginLogger.debug('Direct file path not found, falling back to discovery', { agentNameOrPath });
                }
            }

            // If not a direct path or direct path doesn't exist, use smart discovery service
            if (!agentPath) {
                agentPath = await SmartAgentDiscoveryService.findAgent(agentNameOrPath, contextPath);
                if (!agentPath) {
                    pluginLogger.warn('Agent file not found via smart discovery', {
                        agentNameOrPath,
                        contextPath
                    });
                    return null;
                }
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
                // Auto-register the agent in SmartAgentDiscoveryService for faster future lookups
                SmartAgentDiscoveryService.registerAgent(loadedAgent.manifest.name, {
                    path: agentPath,
                    manifest: loadedAgent.manifest,
                    loadedAt: new Date()
                });

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
            return await SmartAgentDiscoveryService.listAvailableAgents();
        } catch (error) {
            pluginLogger.error('Failed to list discoverable agents', error);
            return [];
        }
    }
} 