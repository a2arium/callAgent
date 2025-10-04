import { AgentPlugin } from './types.js';
import { AgentManifest } from '../../shared/types/index.js';
/**
 * Registry for managing loaded agent plugins
 * Follows the same pattern as memory registries
 */
export declare class AgentRegistry {
    private agents;
    private aliases;
    /**
     * Register an agent plugin
     */
    register(agent: AgentPlugin): void;
    /**
     * Find agent by name or alias
     */
    findByName(nameOrAlias: string): AgentPlugin | null;
    /**
     * List all registered agents
     */
    listAgents(): AgentManifest[];
    /**
     * Get all aliases for an agent
     */
    private getAliases;
    /**
     * Fuzzy matching for agent names
     */
    private findFuzzyMatch;
}
export declare const globalAgentRegistry: AgentRegistry;
