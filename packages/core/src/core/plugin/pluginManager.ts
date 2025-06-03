import { globalAgentRegistry } from './AgentRegistry.js';
import { AgentPlugin } from './types.js';
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
} 