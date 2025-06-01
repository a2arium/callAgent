import { WorkingMemoryBackend, ThoughtEntry, DecisionEntry, WorkingMemoryState, MemoryQueryResult } from '@callagent/types';
import { logger } from '@callagent/utils';
import { UnifiedMemoryService } from './UnifiedMemoryService.js';

/**
 * MLO Working Memory Backend
 * 
 * Routes all working memory operations through the Memory Lifecycle Orchestrator (MLO)
 * while maintaining the standard WorkingMemoryBackend interface.
 * 
 * This ensures working memory benefits from:
 * - 6-stage MLO processing pipeline
 * - Acquisition filtering and compression
 * - Encoding and attention mechanisms
 * - Derivation and reflection
 * - Retrieval optimization
 * - Neural memory integration
 * - Utilization context enhancement
 */
export class MLOWorkingMemoryBackend implements WorkingMemoryBackend {
    private logger = logger.createLogger({ prefix: 'MLOWorkingMemory' });

    constructor(
        private unifiedMemory: UnifiedMemoryService,
        private underlyingAdapter?: WorkingMemoryBackend
    ) { }

    // ========================================
    // Goal Management
    // ========================================

    async setGoal(goal: string, agentId: string, tenantId: string): Promise<void> {
        this.logger.debug('Setting goal through MLO pipeline', { agentId, tenantId });

        // Route through MLO for processing
        await this.unifiedMemory.setWorkingMemory(
            `goal:${agentId}`,
            { content: goal, timestamp: new Date().toISOString() },
            'goal',
            tenantId
        );
    }

    async getGoal(agentId: string, tenantId: string): Promise<string | null> {
        // Direct retrieval bypasses MLO for performance
        if (this.underlyingAdapter) {
            return this.underlyingAdapter.getGoal(agentId, tenantId);
        }

        // Fallback to MLO retrieval
        const goalData = await this.unifiedMemory.getWorkingMemory(`goal:${agentId}`, tenantId);
        return goalData ? (goalData as { content: string }).content : null;
    }

    // ========================================
    // Thought Chain Management
    // ========================================

    async addThought(thought: ThoughtEntry, agentId: string, tenantId: string): Promise<void> {
        this.logger.debug('Adding thought through MLO pipeline', {
            agentId,
            tenantId,
            type: thought.type
        });

        // Route through MLO for processing (acquisition, encoding, etc.)
        await this.unifiedMemory.setWorkingMemory(
            `thought:${agentId}:${Date.now()}`,
            thought,
            'thought',
            tenantId
        );
    }

    async getThoughts(agentId: string, tenantId: string): Promise<ThoughtEntry[]> {
        // Direct retrieval bypasses MLO for performance
        if (this.underlyingAdapter) {
            return this.underlyingAdapter.getThoughts(agentId, tenantId);
        }

        // Fallback to MLO retrieval with pattern matching
        const thoughts = await this.unifiedMemory.getManyWorkingMemory(
            `thought:${agentId}:*`,
            { limit: 1000 },
            tenantId
        );

        return thoughts
            .map((result: MemoryQueryResult<unknown>) => result.value as ThoughtEntry)
            .sort((a: ThoughtEntry, b: ThoughtEntry) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    }

    // ========================================
    // Decision Tracking
    // ========================================

    async makeDecision(key: string, decision: DecisionEntry, agentId: string, tenantId: string): Promise<void> {
        this.logger.debug('Making decision through MLO pipeline', {
            agentId,
            tenantId,
            key
        });

        // Route through MLO for processing
        await this.unifiedMemory.setWorkingMemory(
            `decision:${agentId}:${key}`,
            decision,
            'decision',
            tenantId
        );
    }

    async getDecision(key: string, agentId: string, tenantId: string): Promise<DecisionEntry | null> {
        // Direct retrieval bypasses MLO for performance
        if (this.underlyingAdapter) {
            return this.underlyingAdapter.getDecision(key, agentId, tenantId);
        }

        // Fallback to MLO retrieval
        const decisionData = await this.unifiedMemory.getWorkingMemory(`decision:${agentId}:${key}`, tenantId);
        return decisionData ? (decisionData as DecisionEntry) : null;
    }

    // ========================================
    // Variable Storage
    // ========================================

    async setVariable(key: string, value: unknown, agentId: string, tenantId: string): Promise<void> {
        this.logger.debug('Setting variable through MLO pipeline', {
            agentId,
            tenantId,
            key,
            valueType: typeof value
        });

        // Route through MLO for processing
        await this.unifiedMemory.setWorkingMemory(
            `variable:${agentId}:${key}`,
            value,
            'variable',
            tenantId
        );
    }

    async getVariable(key: string, agentId: string, tenantId: string): Promise<unknown> {
        // Direct retrieval bypasses MLO for performance
        if (this.underlyingAdapter) {
            return this.underlyingAdapter.getVariable(key, agentId, tenantId);
        }

        // Fallback to MLO retrieval
        return this.unifiedMemory.getWorkingMemory(`variable:${agentId}:${key}`, tenantId);
    }

    // ========================================
    // Session Management
    // ========================================

    async clearSession(agentId: string, tenantId: string): Promise<void> {
        this.logger.info('Clearing working memory session', { agentId, tenantId });

        // Direct operation bypasses MLO for administrative tasks
        if (this.underlyingAdapter) {
            await this.underlyingAdapter.clearSession(agentId, tenantId);
            return;
        }

        // Fallback: Clear all working memory keys for this agent
        // Note: This is less efficient but provides basic functionality
        const patterns = [
            `goal:${agentId}`,
            `thought:${agentId}:*`,
            `decision:${agentId}:*`,
            `variable:${agentId}:*`
        ];

        for (const pattern of patterns) {
            try {
                const items = await this.unifiedMemory.getManyWorkingMemory(pattern, {}, tenantId);
                for (const item of items) {
                    await this.unifiedMemory.deleteWorkingMemory(item.key, tenantId);
                }
            } catch (error) {
                this.logger.warn('Failed to clear pattern', { pattern, error });
            }
        }
    }

    async getSessionState(agentId: string, tenantId: string): Promise<WorkingMemoryState> {
        // Direct retrieval bypasses MLO for performance
        if (this.underlyingAdapter) {
            return this.underlyingAdapter.getSessionState(agentId, tenantId);
        }

        // Fallback: Reconstruct state from MLO storage
        const [goal, thoughts, decisions, variables] = await Promise.all([
            this.getGoal(agentId, tenantId),
            this.getThoughts(agentId, tenantId),
            this.getDecisionEntries(agentId, tenantId),
            this.getVariableEntries(agentId, tenantId)
        ]);

        return {
            currentGoal: goal ? {
                content: goal,
                timestamp: new Date().toISOString()
            } : null,
            thoughtChain: thoughts,
            decisions,
            variables,
            loadedLongTermMemories: [], // Not implemented yet
            meta: {
                lastUpdatedAt: new Date().toISOString(),
                version: '1.0.0',
                agentId
            }
        };
    }

    // ========================================
    // Private Helper Methods
    // ========================================

    private async getDecisionEntries(agentId: string, tenantId: string): Promise<Record<string, DecisionEntry>> {
        const decisions: Record<string, DecisionEntry> = {};

        try {
            const decisionItems = await this.unifiedMemory.getManyWorkingMemory(
                `decision:${agentId}:*`,
                {},
                tenantId
            );

            for (const item of decisionItems) {
                // Extract decision key from the full key: "decision:agentId:key" -> "key"
                const keyParts = item.key.split(':');
                if (keyParts.length >= 3) {
                    const decisionKey = keyParts.slice(2).join(':');
                    decisions[decisionKey] = item.value as DecisionEntry;
                }
            }
        } catch (error) {
            this.logger.warn('Failed to get decision entries', { agentId, tenantId, error });
        }

        return decisions;
    }

    private async getVariableEntries(agentId: string, tenantId: string): Promise<Record<string, unknown>> {
        const variables: Record<string, unknown> = {};

        try {
            const variableItems = await this.unifiedMemory.getManyWorkingMemory(
                `variable:${agentId}:*`,
                {},
                tenantId
            );

            for (const item of variableItems) {
                // Extract variable key from the full key: "variable:agentId:key" -> "key"
                const keyParts = item.key.split(':');
                if (keyParts.length >= 3) {
                    const variableKey = keyParts.slice(2).join(':');
                    variables[variableKey] = item.value;
                }
            }
        } catch (error) {
            this.logger.warn('Failed to get variable entries', { agentId, tenantId, error });
        }

        return variables;
    }

    // ========================================
    // Lifecycle Management
    // ========================================

    async initialize(): Promise<void> {
        this.logger.info('MLOWorkingMemoryBackend initialized');

        if (this.underlyingAdapter?.initialize) {
            await this.underlyingAdapter.initialize();
        }
    }

    async shutdown(): Promise<void> {
        this.logger.info('MLOWorkingMemoryBackend shutting down');

        if (this.underlyingAdapter?.shutdown) {
            await this.underlyingAdapter.shutdown();
        }
    }
} 