import { logger } from '@callagent/utils';
import { MemoryLifecycleOrchestrator } from './lifecycle/orchestrator/MemoryLifecycleOrchestrator.js';
import { WorkingMemoryStore } from './stores/WorkingMemoryStore.js';
import { MemoryLifecycleConfig } from './lifecycle/config/types.js';
import {
    MemoryItem,
    MemoryIntent,
    createMemoryItem,
    RecallOptions,
    RememberOptions
} from '../../shared/types/memoryLifecycle.js';
import { ThoughtEntry, DecisionEntry } from '../../shared/types/workingMemory.js';
import {
    MemoryQueryOptions,
    MemoryQueryResult,
    MemorySetOptions,
    GetManyInput,
    GetManyOptions
} from '@callagent/types';

/**
 * Semantic Memory Adapter Interface
 * Represents the existing semantic memory adapter interface
 */
export type SemanticMemoryAdapter = {
    set(key: string, value: unknown, namespace?: string, tenantId?: string): Promise<void>;
    get(key: string, namespace?: string, tenantId?: string): Promise<unknown>;
    getMany?(input: GetManyInput, options?: GetManyOptions, tenantId?: string): Promise<Array<MemoryQueryResult<unknown>>>;
    delete?(key: string, namespace?: string, tenantId?: string): Promise<void>;
    clear?(namespace?: string, tenantId?: string): Promise<void>;
    // Entity alignment methods (optional)
    entities?: {
        unlink(memoryKey: string, fieldPath: string, tenantId?: string): Promise<void>;
        realign(memoryKey: string, fieldPath: string, newEntityId: string, tenantId?: string): Promise<void>;
        stats(entityType?: string, tenantId?: string): Promise<{
            totalEntities: number;
            totalAlignments: number;
            entitiesByType: Record<string, number>;
        }>;
    };
};

/**
 * Episodic Memory Adapter Interface
 * Represents the existing episodic memory adapter interface
 */
export type EpisodicMemoryAdapter = {
    append(event: unknown, opts?: { tags?: string[] }, tenantId?: string): Promise<void>;
    getEvents(filter?: MemoryQueryOptions, tenantId?: string): Promise<Array<MemoryQueryResult<unknown>>>;
    deleteEvent?(id: string, tenantId?: string): Promise<void>;
    clear?(tenantId?: string): Promise<void>;
};

/**
 * Embed Memory Adapter Interface
 * Represents the existing embed memory adapter interface
 */
export type EmbedMemoryAdapter = {
    upsert(key: string, embedding: number[], value: unknown, tenantId?: string): Promise<void>;
    queryByVector(vector: number[], opts?: { limit?: number }, tenantId?: string): Promise<Array<MemoryQueryResult<unknown>>>;
    delete(key: string, tenantId?: string): Promise<void>;
    clear?(tenantId?: string): Promise<void>;
};

/**
 * Unified Memory Service Configuration
 */
export type UnifiedMemoryServiceConfig = {
    /** Memory lifecycle configuration */
    memoryLifecycleConfig: MemoryLifecycleConfig;
    /** Existing semantic memory adapter (optional for backward compatibility) */
    semanticAdapter?: SemanticMemoryAdapter;
    /** Existing episodic memory adapter (optional for backward compatibility) */
    episodicAdapter?: EpisodicMemoryAdapter;
    /** Existing embed memory adapter (optional for backward compatibility) */
    embedAdapter?: EmbedMemoryAdapter;
    /** Agent ID for this service instance */
    agentId?: string;
};

/**
 * Unified interface for all memory operations
 * 
 * Routes all memory operations through the Memory Lifecycle Orchestrator (MLO) pipeline
 * while maintaining backward compatibility with existing semantic and episodic memory adapters.
 * 
 * Key Features:
 * - All memory operations go through 6-stage MLO pipeline
 * - Working memory operations with cognitive context
 * - Backward compatible with existing semantic/episodic adapters
 * - Tenant-aware processing with agent isolation
 * - Comprehensive observability and metrics
 * - Unified recall/remember operations across memory types
 */
export class UnifiedMemoryService {
    private logger = logger.createLogger({ prefix: 'UnifiedMemory' });
    private mlo: MemoryLifecycleOrchestrator;
    private workingMemoryStore: WorkingMemoryStore;
    private semanticMemoryAdapter?: SemanticMemoryAdapter;
    private episodicMemoryAdapter?: EpisodicMemoryAdapter;
    private embedMemoryAdapter?: EmbedMemoryAdapter;
    private defaultAgentId: string;

    constructor(
        private tenantId: string,
        config: UnifiedMemoryServiceConfig
    ) {
        this.defaultAgentId = config.agentId || 'default';
        this.mlo = new MemoryLifecycleOrchestrator(
            config.memoryLifecycleConfig,
            tenantId,
            this.defaultAgentId
        );
        this.workingMemoryStore = new WorkingMemoryStore();
        this.semanticMemoryAdapter = config.semanticAdapter;
        this.episodicMemoryAdapter = config.episodicAdapter;
        this.embedMemoryAdapter = config.embedAdapter;

        this.logger.info('UnifiedMemoryService initialized', {
            tenantId: this.tenantId,
            agentId: this.defaultAgentId,
            hasSemanticAdapter: !!this.semanticMemoryAdapter,
            hasEpisodicAdapter: !!this.episodicMemoryAdapter,
            hasEmbedAdapter: !!this.embedMemoryAdapter,
            profile: config.memoryLifecycleConfig.profile
        });
    }

    // ========================================
    // Working Memory Operations
    // ========================================

    /**
     * Set working memory value (generic method for MLO backend)
     */
    async setWorkingMemory(key: string, value: unknown, type: string, tenantId?: string): Promise<void> {
        const effectiveTenantId = tenantId || this.tenantId;

        // Route to appropriate working memory method based on type
        if (type === 'goal') {
            const goalData = value as { content: string; timestamp: string };
            await this.setGoal(goalData.content);
        } else if (type === 'thought') {
            const thoughtData = value as ThoughtEntry;
            await this.addThought(thoughtData.content);
        } else if (type === 'decision') {
            const decisionData = value as DecisionEntry;
            const keyParts = key.split(':');
            const decisionKey = keyParts.length >= 3 ? keyParts.slice(2).join(':') : key;
            await this.makeDecision(decisionKey, decisionData.decision, decisionData.reasoning);
        } else if (type === 'variable') {
            const keyParts = key.split(':');
            const variableKey = keyParts.length >= 3 ? keyParts.slice(2).join(':') : key;
            await this.setWorkingVariable(variableKey, value);
        } else {
            throw new Error(`Unsupported working memory type: ${type}`);
        }
    }

    /**
     * Get working memory value (generic method for MLO backend)
     */
    async getWorkingMemory(key: string, tenantId?: string): Promise<unknown> {
        const effectiveTenantId = tenantId || this.tenantId;

        if (key.startsWith('goal:')) {
            const goal = await this.getGoal();
            return goal ? { content: goal, timestamp: new Date().toISOString() } : null;
        } else if (key.startsWith('decision:')) {
            const keyParts = key.split(':');
            const decisionKey = keyParts.length >= 3 ? keyParts.slice(2).join(':') : key;
            return this.getDecision(decisionKey);
        } else if (key.startsWith('variable:')) {
            const keyParts = key.split(':');
            const variableKey = keyParts.length >= 3 ? keyParts.slice(2).join(':') : key;
            return this.getWorkingVariable(variableKey);
        } else {
            throw new Error(`Unsupported working memory key pattern: ${key}`);
        }
    }

    /**
     * Get many working memory values (generic method for MLO backend)
     */
    async getManyWorkingMemory(pattern: string, options?: { limit?: number }, tenantId?: string): Promise<Array<MemoryQueryResult<unknown>>> {
        const effectiveTenantId = tenantId || this.tenantId;
        const results: Array<MemoryQueryResult<unknown>> = [];

        if (pattern.startsWith('thought:')) {
            const thoughts = await this.getThoughts();
            thoughts.forEach((thought, index) => {
                const agentId = this.defaultAgentId;
                results.push({
                    key: `thought:${agentId}:${new Date(thought.timestamp).getTime()}`,
                    value: thought
                });
            });
        } else if (pattern.startsWith('decision:')) {
            // For decisions, we'd need to track them differently
            // This is a simplified implementation
            this.logger.warn('getManyWorkingMemory for decisions not fully implemented');
        } else if (pattern.startsWith('variable:')) {
            // For variables, we'd need to track them differently
            // This is a simplified implementation
            this.logger.warn('getManyWorkingMemory for variables not fully implemented');
        }

        return options?.limit ? results.slice(0, options.limit) : results;
    }

    /**
     * Delete working memory value (generic method for MLO backend)
     */
    async deleteWorkingMemory(key: string, tenantId?: string): Promise<void> {
        const effectiveTenantId = tenantId || this.tenantId;

        // Working memory deletion is typically handled by clearing sessions
        // Individual item deletion is not commonly needed
        this.logger.warn('Individual working memory deletion not implemented', { key });
    }

    /**
     * Set the current goal for an agent
     */
    async setGoal(goal: string, agentId?: string): Promise<void> {
        const effectiveAgentId = agentId || this.defaultAgentId;

        this.logger.debug('Setting goal', {
            goal: goal.substring(0, 100),
            agentId: effectiveAgentId,
            tenantId: this.tenantId
        });

        const item = createMemoryItem(goal, 'workingMemory', 'setGoal', this.tenantId, effectiveAgentId);
        const result = await this.mlo.processMemoryItem(item, 'workingMemory');

        if (result.success && result.processedItems.length > 0) {
            const processedData = result.processedItems[0].data;

            // Extract the actual goal text from structured data if needed
            let goalText: string;
            if (typeof processedData === 'string') {
                goalText = processedData;
            } else if (processedData && typeof processedData === 'object' && 'text' in processedData) {
                goalText = (processedData as any).text;
            } else {
                goalText = JSON.stringify(processedData);
            }

            // Remove [TEXT] prefix if present (added by MLO processors)
            if (goalText.startsWith('[TEXT] ')) {
                goalText = goalText.substring(7);
            }

            await this.workingMemoryStore.storeGoal(
                { content: goalText, timestamp: item.metadata.timestamp },
                this.tenantId,
                effectiveAgentId
            );

            this.logger.debug('Goal set successfully', {
                originalLength: goal.length,
                processedLength: goalText.length,
                agentId: effectiveAgentId
            });
        } else {
            this.logger.warn('Failed to process goal', {
                goal: goal.substring(0, 100),
                agentId: effectiveAgentId,
                error: result.metadata?.error
            });
            throw new Error(`Failed to set goal: ${result.metadata?.error || 'Unknown error'}`);
        }
    }

    /**
     * Get the current goal for an agent
     */
    async getGoal(agentId?: string): Promise<string | null> {
        const effectiveAgentId = agentId || this.defaultAgentId;
        return this.workingMemoryStore.getGoal(this.tenantId, effectiveAgentId);
    }

    /**
     * Add a thought to working memory
     */
    async addThought(thought: string, agentId?: string): Promise<void> {
        const effectiveAgentId = agentId || this.defaultAgentId;

        this.logger.debug('Adding thought', {
            thought: thought.substring(0, 100),
            agentId: effectiveAgentId,
            tenantId: this.tenantId
        });

        const item = createMemoryItem(thought, 'workingMemory', 'addThought', this.tenantId, effectiveAgentId);
        const result = await this.mlo.processMemoryItem(item, 'workingMemory');

        if (result.success && result.processedItems.length > 0) {
            const processedThought = result.processedItems[0];

            // Extract the actual thought text from structured data if needed
            let thoughtText: string;
            const processedData = processedThought.data;
            if (typeof processedData === 'string') {
                thoughtText = processedData;
            } else if (processedData && typeof processedData === 'object' && 'text' in processedData) {
                thoughtText = (processedData as any).text;
            } else {
                thoughtText = JSON.stringify(processedData);
            }

            // Remove [TEXT] prefix if present (added by MLO processors)
            if (thoughtText.startsWith('[TEXT] ')) {
                thoughtText = thoughtText.substring(7);
            }

            await this.workingMemoryStore.addThought(
                {
                    content: thoughtText,
                    timestamp: processedThought.metadata.timestamp,
                    type: 'thought',
                    processingMetadata: {
                        processingHistory: processedThought.metadata.processingHistory,
                        compressed: processedThought.metadata.compressed,
                        summarized: processedThought.metadata.summarized
                    }
                },
                this.tenantId,
                effectiveAgentId
            );

            this.logger.debug('Thought added successfully', {
                originalLength: thought.length,
                processedLength: thoughtText.length,
                agentId: effectiveAgentId
            });
        } else {
            this.logger.warn('Failed to process thought', {
                thought: thought.substring(0, 100),
                agentId: effectiveAgentId,
                error: result.metadata?.error
            });
            // Don't throw for thoughts - they're less critical
        }
    }

    /**
     * Get all thoughts for an agent
     */
    async getThoughts(agentId?: string): Promise<ThoughtEntry[]> {
        const effectiveAgentId = agentId || this.defaultAgentId;
        return this.workingMemoryStore.getThoughts(this.tenantId, effectiveAgentId);
    }

    /**
     * Make a decision and store it in working memory
     */
    async makeDecision(key: string, decision: string, reasoning?: string, agentId?: string): Promise<void> {
        const effectiveAgentId = agentId || this.defaultAgentId;

        this.logger.debug('Making decision', {
            key,
            decision: decision.substring(0, 100),
            hasReasoning: !!reasoning,
            agentId: effectiveAgentId,
            tenantId: this.tenantId
        });

        const item = createMemoryItem(
            { key, decision, reasoning },
            'workingMemory',
            'makeDecision',
            this.tenantId,
            effectiveAgentId
        );
        const result = await this.mlo.processMemoryItem(item, 'workingMemory');

        if (result.success && result.processedItems.length > 0) {
            const processedData = result.processedItems[0].data;

            // Extract key, decision, reasoning from potentially transformed data
            let extractedKey: string;
            let extractedDecision: string;
            let extractedReasoning: string | undefined;

            if (processedData && typeof processedData === 'object' && 'key' in processedData) {
                // Direct structure
                const directData = processedData as { key: string; decision: string; reasoning?: string };
                extractedKey = directData.key;
                extractedDecision = directData.decision;
                extractedReasoning = directData.reasoning;
            } else if (processedData && typeof processedData === 'object' && 'structured' in processedData) {
                // Fusion transformed structure
                const fusedData = processedData as { structured: { key: string; decision: string; reasoning?: string } };
                extractedKey = fusedData.structured.key;
                extractedDecision = fusedData.structured.decision;
                extractedReasoning = fusedData.structured.reasoning;
            } else {
                // Fallback: use original parameters
                this.logger.warn('Could not extract decision structure from processed data, using original parameters', {
                    processedDataType: typeof processedData,
                    hasKey: processedData && typeof processedData === 'object' && 'key' in processedData
                });
                extractedKey = key;
                extractedDecision = decision;
                extractedReasoning = reasoning;
            }

            await this.workingMemoryStore.makeDecision(
                extractedKey,
                extractedDecision,
                extractedReasoning,
                this.tenantId,
                effectiveAgentId
            );

            this.logger.debug('Decision made successfully', {
                key: extractedKey,
                agentId: effectiveAgentId
            });
        } else {
            this.logger.warn('Failed to process decision', {
                key,
                agentId: effectiveAgentId,
                error: result.metadata?.error
            });
            throw new Error(`Failed to make decision: ${result.metadata?.error || 'Unknown error'}`);
        }
    }

    /**
     * Get a specific decision by key
     */
    async getDecision(key: string, agentId?: string): Promise<DecisionEntry | null> {
        const effectiveAgentId = agentId || this.defaultAgentId;
        return this.workingMemoryStore.getDecision(key, this.tenantId, effectiveAgentId);
    }

    /**
     * Set a working memory variable
     */
    async setWorkingVariable(key: string, value: unknown, agentId?: string): Promise<void> {
        const effectiveAgentId = agentId || this.defaultAgentId;

        this.logger.debug('Setting working variable', {
            key,
            valueType: typeof value,
            agentId: effectiveAgentId,
            tenantId: this.tenantId
        });

        const item = createMemoryItem(
            { key, value },
            'workingMemory',
            'setVariable',
            this.tenantId,
            effectiveAgentId
        );
        const result = await this.mlo.processMemoryItem(item, 'workingMemory');

        if (result.success && result.processedItems.length > 0) {
            const processedData = result.processedItems[0].data;

            // Extract key, value from potentially transformed data
            let extractedKey: string;
            let extractedValue: unknown;

            if (processedData && typeof processedData === 'object' && 'key' in processedData) {
                // Direct structure
                const directData = processedData as { key: string; value: unknown };
                extractedKey = directData.key;
                extractedValue = directData.value;
            } else if (processedData && typeof processedData === 'object' && 'structured' in processedData) {
                // Fusion transformed structure
                const fusedData = processedData as { structured: { key: string; value: unknown } };
                extractedKey = fusedData.structured.key;
                extractedValue = fusedData.structured.value;
            } else {
                // Fallback: use original parameters
                this.logger.warn('Could not extract working variable structure from processed data, using original parameters', {
                    processedDataType: typeof processedData,
                    hasKey: processedData && typeof processedData === 'object' && 'key' in processedData
                });
                extractedKey = key;
                extractedValue = value;
            }

            await this.workingMemoryStore.setVariable(
                extractedKey,
                extractedValue,
                this.tenantId,
                effectiveAgentId
            );

            this.logger.debug('Working variable set successfully', {
                key: extractedKey,
                agentId: effectiveAgentId
            });
        } else {
            this.logger.warn('Failed to process working variable', {
                key,
                agentId: effectiveAgentId,
                error: result.metadata?.error
            });
            throw new Error(`Failed to set working variable: ${result.metadata?.error || 'Unknown error'}`);
        }
    }

    /**
     * Get a working memory variable
     */
    async getWorkingVariable(key: string, agentId?: string): Promise<unknown> {
        const effectiveAgentId = agentId || this.defaultAgentId;
        return this.workingMemoryStore.getVariable(key, this.tenantId, effectiveAgentId);
    }

    // ========================================
    // Semantic Memory Operations (Backward Compatible)
    // ========================================

    /**
     * Set semantic memory (backward compatible with existing adapters)
     */
    async setSemanticMemory(key: string, value: unknown, namespace?: string): Promise<void> {
        this.logger.debug('Setting semantic memory', {
            key,
            namespace,
            valueType: typeof value,
            tenantId: this.tenantId
        });

        const item = createMemoryItem(
            { key, value, namespace },
            'semanticLTM',
            'semantic.set',
            this.tenantId
        );
        const result = await this.mlo.processMemoryItem(item, 'semanticLTM');

        if (result.success && result.processedItems.length > 0) {
            const processedData = result.processedItems[0].data;

            // Extract key, value, namespace from potentially transformed data
            let extractedKey: string;
            let extractedValue: unknown;
            let extractedNamespace: string | undefined;

            if (processedData && typeof processedData === 'object' && 'key' in processedData) {
                // Direct structure
                const directData = processedData as { key: string; value: unknown; namespace?: string };
                extractedKey = directData.key;
                extractedValue = directData.value;
                extractedNamespace = directData.namespace;
            } else if (processedData && typeof processedData === 'object' && 'structured' in processedData) {
                // Fusion transformed structure
                const fusedData = processedData as { structured: { key: string; value: unknown; namespace?: string } };
                extractedKey = fusedData.structured.key;
                extractedValue = fusedData.structured.value;
                extractedNamespace = fusedData.structured.namespace;
            } else {
                // Fallback: use original parameters
                this.logger.warn('Could not extract semantic memory structure from processed data, using original parameters', {
                    processedDataType: typeof processedData,
                    hasKey: processedData && typeof processedData === 'object' && 'key' in processedData
                });
                extractedKey = key;
                extractedValue = value;
                extractedNamespace = namespace;
            }

            // Use existing adapter if available
            if (this.semanticMemoryAdapter) {
                await this.semanticMemoryAdapter.set(
                    extractedKey,
                    extractedValue,
                    extractedNamespace,
                    this.tenantId
                );

                this.logger.debug('Semantic memory set via adapter', {
                    key: extractedKey,
                    namespace: extractedNamespace
                });
            } else {
                this.logger.warn('No semantic memory adapter configured', {
                    key: extractedKey
                });
                throw new Error('No semantic memory adapter configured');
            }
        } else {
            this.logger.warn('Failed to process semantic memory', {
                key,
                error: result.metadata?.error
            });
            throw new Error(`Failed to set semantic memory: ${result.metadata?.error || 'Unknown error'}`);
        }
    }

    /**
     * Get semantic memory (direct adapter access - no processing needed)
     */
    async getSemanticMemory(key: string, namespace?: string): Promise<unknown> {
        if (!this.semanticMemoryAdapter) {
            throw new Error('No semantic memory adapter configured');
        }

        this.logger.debug('Getting semantic memory', {
            key,
            namespace,
            tenantId: this.tenantId
        });

        return this.semanticMemoryAdapter.get(key, namespace, this.tenantId);
    }

    /**
     * Get many semantic memory entries with MLO processing
     */
    async getManySemanticMemory<T>(input: GetManyInput, options?: GetManyOptions): Promise<Array<MemoryQueryResult<T>>> {
        this.logger.debug('Getting many semantic memory entries', {
            input: typeof input === 'string' ? input.substring(0, 100) : 'query object',
            hasOptions: !!options,
            tenantId: this.tenantId
        });

        const item = createMemoryItem(
            { input, options },
            'retrieval',
            'semantic.getMany',
            this.tenantId
        );
        const result = await this.mlo.processMemoryItem(item, 'retrieval');

        if (!this.semanticMemoryAdapter?.getMany) {
            throw new Error('No semantic memory adapter configured or getMany not supported');
        }

        // Use existing adapter for actual query execution
        // The MLO processing above may have enhanced/processed the query
        const processedInput = result.success && result.processedItems.length > 0
            ? (result.processedItems[0].data as { input: GetManyInput }).input
            : input;

        return this.semanticMemoryAdapter.getMany(processedInput, options, this.tenantId) as Promise<Array<MemoryQueryResult<T>>>;
    }

    /**
     * Delete semantic memory entry with MLO processing
     */
    async deleteSemanticMemory(key: string, namespace?: string): Promise<void> {
        this.logger.debug('Deleting semantic memory', {
            key,
            namespace,
            tenantId: this.tenantId
        });

        const item = createMemoryItem(
            { key, namespace },
            'semanticLTM',
            'semantic.delete',
            this.tenantId
        );
        const result = await this.mlo.processMemoryItem(item, 'semanticLTM');

        if (result.success && result.processedItems.length > 0) {
            const processedData = result.processedItems[0].data;

            // Extract key, namespace from potentially transformed data
            let extractedKey: string;
            let extractedNamespace: string | undefined;

            if (processedData && typeof processedData === 'object' && 'key' in processedData) {
                const directData = processedData as { key: string; namespace?: string };
                extractedKey = directData.key;
                extractedNamespace = directData.namespace;
            } else {
                extractedKey = key;
                extractedNamespace = namespace;
            }

            if (this.semanticMemoryAdapter?.delete) {
                await this.semanticMemoryAdapter.delete(extractedKey, extractedNamespace, this.tenantId);

                this.logger.debug('Semantic memory deleted via adapter', {
                    key: extractedKey,
                    namespace: extractedNamespace
                });
            } else {
                throw new Error('Semantic memory adapter does not support delete operation');
            }
        } else {
            this.logger.warn('Failed to process semantic memory deletion', {
                key,
                error: result.metadata?.error
            });
            throw new Error(`Failed to delete semantic memory: ${result.metadata?.error || 'Unknown error'}`);
        }
    }

    // ========================================
    // Episodic Memory Operations
    // ========================================

    /**
     * Append an event to episodic memory
     */
    async appendEpisodic(event: unknown): Promise<void> {
        this.logger.debug('Appending episodic event', {
            eventType: typeof event,
            tenantId: this.tenantId
        });

        const item = createMemoryItem(
            event,
            'episodicLTM',
            'episodic.append',
            this.tenantId
        );
        const result = await this.mlo.processMemoryItem(item, 'episodicLTM');

        if (result.success && result.processedItems.length > 0) {
            const processedEvent = result.processedItems[0].data;

            if (this.episodicMemoryAdapter) {
                await this.episodicMemoryAdapter.append(processedEvent, {}, this.tenantId);

                this.logger.debug('Episodic event appended via adapter');
            } else {
                this.logger.warn('No episodic memory adapter configured');
                throw new Error('No episodic memory adapter configured');
            }
        } else {
            this.logger.warn('Failed to process episodic event', {
                error: result.metadata?.error
            });
            throw new Error(`Failed to append episodic event: ${result.metadata?.error || 'Unknown error'}`);
        }
    }

    /**
     * Get episodic events with MLO processing
     */
    async getEpisodicEvents<T>(filter?: MemoryQueryOptions): Promise<Array<MemoryQueryResult<T>>> {
        this.logger.debug('Getting episodic events', {
            hasFilter: !!filter,
            tenantId: this.tenantId
        });

        const item = createMemoryItem(
            { filter },
            'retrieval',
            'episodic.getEvents',
            this.tenantId
        );
        const result = await this.mlo.processMemoryItem(item, 'retrieval');

        if (!this.episodicMemoryAdapter) {
            throw new Error('No episodic memory adapter configured');
        }

        // Use existing adapter for actual query execution
        const processedFilter = result.success && result.processedItems.length > 0
            ? (result.processedItems[0].data as { filter?: MemoryQueryOptions }).filter
            : filter;

        return this.episodicMemoryAdapter.getEvents(processedFilter, this.tenantId) as Promise<Array<MemoryQueryResult<T>>>;
    }

    /**
     * Delete episodic event with MLO processing
     */
    async deleteEpisodicEvent(id: string): Promise<void> {
        this.logger.debug('Deleting episodic event', {
            id,
            tenantId: this.tenantId
        });

        const item = createMemoryItem(
            { id },
            'episodicLTM',
            'episodic.deleteEvent',
            this.tenantId
        );
        const result = await this.mlo.processMemoryItem(item, 'episodicLTM');

        if (result.success && result.processedItems.length > 0) {
            const processedData = result.processedItems[0].data;

            // Extract id from potentially transformed data
            let extractedId: string;

            if (processedData && typeof processedData === 'object' && 'id' in processedData) {
                extractedId = (processedData as { id: string }).id;
            } else {
                extractedId = id;
            }

            if (this.episodicMemoryAdapter?.deleteEvent) {
                await this.episodicMemoryAdapter.deleteEvent(extractedId, this.tenantId);

                this.logger.debug('Episodic event deleted via adapter', {
                    id: extractedId
                });
            } else {
                throw new Error('Episodic memory adapter does not support deleteEvent operation');
            }
        } else {
            this.logger.warn('Failed to process episodic event deletion', {
                id,
                error: result.metadata?.error
            });
            throw new Error(`Failed to delete episodic event: ${result.metadata?.error || 'Unknown error'}`);
        }
    }

    // ========================================
    // Embed Memory Operations
    // ========================================

    /**
     * Upsert embed memory with MLO processing
     */
    async upsertEmbedMemory<T>(key: string, embedding: number[], value: T): Promise<void> {
        this.logger.debug('Upserting embed memory', {
            key,
            embeddingLength: embedding.length,
            valueType: typeof value,
            tenantId: this.tenantId
        });

        const item = createMemoryItem(
            { key, embedding, value },
            'semanticLTM', // Embed operations use semantic LTM intent
            'embed.upsert',
            this.tenantId
        );
        const result = await this.mlo.processMemoryItem(item, 'semanticLTM');

        if (result.success && result.processedItems.length > 0) {
            const processedData = result.processedItems[0].data;

            // Extract key, embedding, value from potentially transformed data
            let extractedKey: string;
            let extractedEmbedding: number[];
            let extractedValue: T;

            if (processedData && typeof processedData === 'object' && 'key' in processedData) {
                const directData = processedData as { key: string; embedding: number[]; value: T };
                extractedKey = directData.key;
                extractedEmbedding = directData.embedding;
                extractedValue = directData.value;
            } else {
                extractedKey = key;
                extractedEmbedding = embedding;
                extractedValue = value;
            }

            if (this.embedMemoryAdapter) {
                await this.embedMemoryAdapter.upsert(extractedKey, extractedEmbedding, extractedValue, this.tenantId);

                this.logger.debug('Embed memory upserted via adapter', {
                    key: extractedKey,
                    embeddingLength: extractedEmbedding.length
                });
            } else {
                throw new Error('No embed memory adapter configured');
            }
        } else {
            this.logger.warn('Failed to process embed memory upsert', {
                key,
                error: result.metadata?.error
            });
            throw new Error(`Failed to upsert embed memory: ${result.metadata?.error || 'Unknown error'}`);
        }
    }

    /**
     * Query embed memory by vector with MLO processing
     */
    async queryEmbedMemoryByVector<T>(vector: number[], opts?: { limit?: number }): Promise<Array<MemoryQueryResult<T>>> {
        this.logger.debug('Querying embed memory by vector', {
            vectorLength: vector.length,
            limit: opts?.limit,
            tenantId: this.tenantId
        });

        const item = createMemoryItem(
            { vector, opts },
            'retrieval',
            'embed.queryByVector',
            this.tenantId
        );
        const result = await this.mlo.processMemoryItem(item, 'retrieval');

        if (!this.embedMemoryAdapter) {
            throw new Error('No embed memory adapter configured');
        }

        // Use existing adapter for actual query execution
        const processedVector = result.success && result.processedItems.length > 0
            ? (result.processedItems[0].data as { vector: number[] }).vector
            : vector;

        return this.embedMemoryAdapter.queryByVector(processedVector, opts, this.tenantId) as Promise<Array<MemoryQueryResult<T>>>;
    }

    /**
     * Delete embed memory entry with MLO processing
     */
    async deleteEmbedMemory(key: string): Promise<void> {
        this.logger.debug('Deleting embed memory', {
            key,
            tenantId: this.tenantId
        });

        const item = createMemoryItem(
            { key },
            'semanticLTM',
            'embed.delete',
            this.tenantId
        );
        const result = await this.mlo.processMemoryItem(item, 'semanticLTM');

        if (result.success && result.processedItems.length > 0) {
            const processedData = result.processedItems[0].data;

            // Extract key from potentially transformed data
            let extractedKey: string;

            if (processedData && typeof processedData === 'object' && 'key' in processedData) {
                extractedKey = (processedData as { key: string }).key;
            } else {
                extractedKey = key;
            }

            if (this.embedMemoryAdapter) {
                await this.embedMemoryAdapter.delete(extractedKey, this.tenantId);

                this.logger.debug('Embed memory deleted via adapter', {
                    key: extractedKey
                });
            } else {
                throw new Error('No embed memory adapter configured');
            }
        } else {
            this.logger.warn('Failed to process embed memory deletion', {
                key,
                error: result.metadata?.error
            });
            throw new Error(`Failed to delete embed memory: ${result.metadata?.error || 'Unknown error'}`);
        }
    }

    // ========================================
    // Unified Operations
    // ========================================

    /**
     * Unified recall operation across all memory types
     */
    async recall(query: string, options?: RecallOptions): Promise<unknown[]> {
        this.logger.debug('Unified recall operation', {
            query: query.substring(0, 100),
            type: options?.type,
            tenantId: this.tenantId
        });

        const item = createMemoryItem(
            { query, options },
            'retrieval',
            'recall',
            this.tenantId
        );
        const result = await this.mlo.processMemoryItem(item, 'retrieval');

        // Phase 1: Simple implementation using existing adapters
        if (options?.type === 'semantic') {
            if (!this.semanticMemoryAdapter?.getMany) {
                this.logger.warn('Semantic recall requested but no adapter configured');
                return [];
            }
            const results = await this.semanticMemoryAdapter.getMany(query, options as GetManyOptions, this.tenantId);
            return results.map(r => r.value);
        }

        if (options?.type === 'episodic') {
            if (!this.episodicMemoryAdapter) {
                this.logger.warn('Episodic recall requested but no adapter configured');
                return [];
            }
            const results = await this.episodicMemoryAdapter.getEvents(options as MemoryQueryOptions, this.tenantId);
            return results.map(r => r.value);
        }

        // Default: search working memory
        const thoughts = await this.getThoughts();
        const matchingThoughts = thoughts
            .filter(t => {
                // Handle both string and structured content
                const content = typeof t.content === 'string' ? t.content :
                    (t.content && typeof t.content === 'object' && 'text' in t.content) ?
                        (t.content as any).text : JSON.stringify(t.content);
                return content.toLowerCase().includes(query.toLowerCase());
            })
            .map(t => {
                // Return the actual text content
                return typeof t.content === 'string' ? t.content :
                    (t.content && typeof t.content === 'object' && 'text' in t.content) ?
                        (t.content as any).text : JSON.stringify(t.content);
            });

        this.logger.debug('Working memory recall complete', {
            query: query.substring(0, 100),
            matchingThoughts: matchingThoughts.length
        });

        return matchingThoughts;
    }

    /**
     * Unified remember operation across all memory types
     */
    async remember(key: string, value: unknown, options?: RememberOptions): Promise<void> {
        this.logger.debug('Unified remember operation', {
            key,
            valueType: typeof value,
            type: options?.type,
            persist: options?.persist,
            tenantId: this.tenantId
        });

        const intent: MemoryIntent =
            options?.type === 'semantic' ? 'semanticLTM' :
                options?.type === 'episodic' ? 'episodicLTM' : 'workingMemory';

        const item = createMemoryItem(
            { key, value, options },
            intent,
            'remember',
            this.tenantId
        );
        const result = await this.mlo.processMemoryItem(item, intent as 'workingMemory' | 'semanticLTM' | 'episodicLTM' | 'retrieval');

        if (result.success && result.processedItems.length > 0) {
            const processedData = result.processedItems[0].data;

            // Extract key, value, options from potentially transformed data
            let extractedKey: string;
            let extractedValue: unknown;
            let extractedOptions: RememberOptions | undefined;

            if (processedData && typeof processedData === 'object' && 'key' in processedData) {
                // Direct structure
                const directData = processedData as { key: string; value: unknown; options?: RememberOptions };
                extractedKey = directData.key;
                extractedValue = directData.value;
                extractedOptions = directData.options;
            } else if (processedData && typeof processedData === 'object' && 'structured' in processedData) {
                // Fusion transformed structure
                const fusedData = processedData as { structured: { key: string; value: unknown; options?: RememberOptions } };
                extractedKey = fusedData.structured.key;
                extractedValue = fusedData.structured.value;
                extractedOptions = fusedData.structured.options;
            } else {
                // Fallback: use original parameters
                this.logger.warn('Could not extract remember structure from processed data, using original parameters', {
                    processedDataType: typeof processedData,
                    hasKey: processedData && typeof processedData === 'object' && 'key' in processedData
                });
                extractedKey = key;
                extractedValue = value;
                extractedOptions = options;
            }

            if (intent === 'semanticLTM' && (extractedOptions?.persist || options?.persist)) {
                if (!this.semanticMemoryAdapter) {
                    throw new Error('No semantic memory adapter configured');
                }
                await this.semanticMemoryAdapter.set(
                    extractedKey,
                    extractedValue,
                    (extractedOptions?.namespace || options?.namespace),
                    this.tenantId
                );

                this.logger.debug('Remembered to semantic memory', {
                    key: extractedKey,
                    namespace: (extractedOptions?.namespace || options?.namespace)
                });
            } else if (intent === 'episodicLTM') {
                if (!this.episodicMemoryAdapter) {
                    throw new Error('No episodic memory adapter configured');
                }
                await this.episodicMemoryAdapter.append(
                    { key: extractedKey, value: extractedValue },
                    {},
                    this.tenantId
                );

                this.logger.debug('Remembered to episodic memory', {
                    key: extractedKey
                });
            } else {
                // Store in working memory variables
                await this.setWorkingVariable(extractedKey, extractedValue);

                this.logger.debug('Remembered to working memory', {
                    key: extractedKey
                });
            }
        } else {
            this.logger.warn('Failed to process remember operation', {
                key,
                intent,
                error: result.metadata?.error
            });
            throw new Error(`Failed to remember: ${result.metadata?.error || 'Unknown error'}`);
        }
    }

    // ========================================
    // Observability and Management
    // ========================================

    /**
     * Get MLO metrics for observability
     */
    getMetrics(): Record<string, unknown> {
        const mloMetrics = this.mlo.getMetrics();

        return {
            mlo: mloMetrics,
            service: {
                tenantId: this.tenantId,
                agentId: this.defaultAgentId,
                hasSemanticAdapter: !!this.semanticMemoryAdapter,
                hasEpisodicAdapter: !!this.episodicMemoryAdapter,
                hasEmbedAdapter: !!this.embedMemoryAdapter,
                profile: this.mlo.getConfiguration().profile
            }
        };
    }

    /**
     * Get current configuration
     */
    getConfiguration(): MemoryLifecycleConfig {
        return this.mlo.getConfiguration();
    }

    /**
     * Update configuration at runtime
     */
    async configure(config: Partial<MemoryLifecycleConfig>): Promise<void> {
        this.logger.info('Updating configuration', {
            tenantId: this.tenantId,
            agentId: this.defaultAgentId,
            newProfile: config.profile
        });

        await this.mlo.configure(config);

        this.logger.info('Configuration updated successfully');
    }

    /**
     * Check if a specific stage is enabled for a memory type
     */
    isStageEnabled(stageName: string, memoryType: string): boolean {
        return this.mlo.isStageEnabled(stageName, memoryType);
    }

    /**
     * Reset metrics
     */
    resetMetrics(): void {
        this.mlo.resetMetrics();
        this.logger.debug('Metrics reset');
    }

    /**
     * Shutdown the service and cleanup resources
     */
    async shutdown(): Promise<void> {
        this.logger.info('Shutting down UnifiedMemoryService', {
            tenantId: this.tenantId,
            agentId: this.defaultAgentId
        });

        await this.mlo.shutdown();

        this.logger.info('UnifiedMemoryService shutdown complete');
    }
} 