import { AgentPlugin } from './types.js';
import { AgentCard } from '@a2arium/callagent-types';
import { logger } from '@a2arium/callagent-utils';

const registryLogger = logger.createLogger({ prefix: 'AgentRegistry' });

/**
 * Registry for managing loaded agent plugins
 * Follows the same pattern as memory registries
 */
export class AgentRegistry {
    private agents = new Map<string, AgentPlugin>();
    private aliases = new Map<string, string>(); // nickname -> canonical name

    /**
     * Register an agent plugin
     */
    register(agent: AgentPlugin): void {
        const name = agent.resolved.agentCard.name;

        if (this.agents.has(name)) {
            registryLogger.warn('Agent already registered, overwriting', { name });
        }

        this.agents.set(name, agent);

        // Create common aliases
        const shortName = name.replace(/[-_]agent$/i, '');
        if (shortName !== name) {
            this.aliases.set(shortName, name);
        }

        registryLogger.info('Agent registered', {
            name,
            version: agent.resolved.agentCard.version,
            aliases: this.getAliases(name)
        });
    }

    /**
     * Find agent by name or alias
     */
    findByName(nameOrAlias: string): AgentPlugin | null {
        // Try exact name first
        let agent = this.agents.get(nameOrAlias);
        if (agent) return agent;

        // Try alias
        const canonicalName = this.aliases.get(nameOrAlias);
        if (canonicalName) {
            agent = this.agents.get(canonicalName);
            if (agent) return agent;
        }

        // Try fuzzy matching
        const fuzzyMatch = this.findFuzzyMatch(nameOrAlias);
        if (fuzzyMatch) return fuzzyMatch;

        return null;
    }

    /**
     * List all registered agents (cards)
     */
    listAgents(): AgentCard[] {
        return Array.from(this.agents.values()).map(plugin => plugin.resolved.agentCard);
    }

    /**
     * Get all aliases for an agent
     */
    private getAliases(canonicalName: string): string[] {
        const aliases: string[] = [];
        for (const [alias, name] of this.aliases.entries()) {
            if (name === canonicalName) {
                aliases.push(alias);
            }
        }
        return aliases;
    }

    /**
     * Fuzzy matching for agent names
     */
    private findFuzzyMatch(searchName: string): AgentPlugin | null {
        const normalizedSearch = searchName.toLowerCase().replace(/[-_]/g, '');

        for (const [name, agent] of this.agents.entries()) {
            const normalizedName = name.toLowerCase().replace(/[-_]/g, '');
            if (normalizedName.includes(normalizedSearch) ||
                normalizedSearch.includes(normalizedName)) {
                return agent;
            }
        }

        return null;
    }
}

// Global registry instance with ESM-safe singleton pattern
const REGISTRY_KEY = Symbol.for('callagent.agentRegistry');
export const globalAgentRegistry: AgentRegistry = (globalThis as any)[REGISTRY_KEY] || new AgentRegistry();

if (!(globalThis as any)[REGISTRY_KEY]) {
    (globalThis as any)[REGISTRY_KEY] = globalAgentRegistry;
}
