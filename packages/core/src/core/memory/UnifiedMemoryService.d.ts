import { MemoryLifecycleConfig } from './lifecycle/config/types.js';
import { RecallOptions, RememberOptions } from '../../shared/types/memoryLifecycle.js';
import { ThoughtEntry, DecisionEntry, WorkingMemoryBackend } from '@callagent/types';
import { MemoryQueryOptions, MemoryQueryResult, GetManyInput, GetManyOptions } from '@callagent/types';
/**
 * Semantic Memory Adapter Interface
 * Represents the existing semantic memory adapter interface
 */
export type SemanticMemoryAdapter = {
    set(key: string, value: unknown, namespace?: string, tenantId?: string): Promise<void>;
    get(key: string, namespace?: string, tenantId?: string): Promise<unknown>;
    getMany?(input: GetManyInput, options?: GetManyOptions, tenantId?: string): Promise<Array<MemoryQueryResult<unknown>>>;
    delete?(key: string, namespace?: string, tenantId?: string): Promise<void>;
    deleteMany?(input: GetManyInput, options?: GetManyOptions, tenantId?: string): Promise<number>;
    clear?(namespace?: string, tenantId?: string): Promise<void>;
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
    append(event: unknown, opts?: {
        tags?: string[];
    }, tenantId?: string): Promise<void>;
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
    queryByVector(vector: number[], opts?: {
        limit?: number;
    }, tenantId?: string): Promise<Array<MemoryQueryResult<unknown>>>;
    delete(key: string, tenantId?: string): Promise<void>;
    clear?(tenantId?: string): Promise<void>;
};
/**
 * Unified Memory Service Configuration
 */
export type UnifiedMemoryServiceConfig = {
    /** Memory lifecycle configuration */
    memoryLifecycleConfig: MemoryLifecycleConfig;
    /** Working memory backend adapter */
    workingMemoryAdapter?: WorkingMemoryBackend;
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
export declare class UnifiedMemoryService {
    private tenantId;
    private logger;
    private mlo;
    private workingMemoryAdapter?;
    private semanticMemoryAdapter?;
    private episodicMemoryAdapter?;
    private embedMemoryAdapter?;
    private defaultAgentId;
    constructor(tenantId: string, config: UnifiedMemoryServiceConfig);
    /**
     * Set working memory value (generic method for MLO backend)
     */
    setWorkingMemory(key: string, value: unknown, type: string, tenantId?: string): Promise<void>;
    /**
     * Get working memory value (generic method for MLO backend)
     */
    getWorkingMemory(key: string, tenantId?: string): Promise<unknown>;
    /**
     * Get many working memory values (generic method for MLO backend)
     */
    getManyWorkingMemory(pattern: string, options?: {
        limit?: number;
    }, tenantId?: string): Promise<Array<MemoryQueryResult<unknown>>>;
    /**
     * Delete working memory value (generic method for MLO backend)
     */
    deleteWorkingMemory(key: string, tenantId?: string): Promise<void>;
    /**
     * Set the current goal for an agent
     */
    setGoal(goal: string, agentId?: string): Promise<void>;
    /**
     * Get the current goal for an agent
     */
    getGoal(agentId?: string): Promise<string | null>;
    /**
     * Add a thought to working memory
     */
    addThought(thought: string, agentId?: string): Promise<void>;
    /**
     * Get all thoughts for an agent
     */
    getThoughts(agentId?: string): Promise<ThoughtEntry[]>;
    /**
     * Make a decision and store it in working memory
     */
    makeDecision(key: string, decision: string, reasoning?: string, agentId?: string): Promise<void>;
    /**
     * Get a specific decision by key
     */
    getDecision(key: string, agentId?: string): Promise<DecisionEntry | null>;
    /**
     * Get all decisions for an agent (for A2A context transfer)
     * This method should be a first-class, typed member of the service.
     */
    getAllDecisions(agentId?: string): Promise<Record<string, DecisionEntry>>;
    /**
     * Set a working memory variable
     */
    setWorkingVariable(key: string, value: unknown, agentId?: string): Promise<void>;
    /**
     * Get a working memory variable
     */
    getWorkingVariable(key: string, agentId?: string): Promise<unknown>;
    /**
     * Set semantic memory (backward compatible with existing adapters)
     */
    setSemanticMemory(key: string, value: unknown, namespace?: string): Promise<void>;
    /**
     * Get semantic memory (direct adapter access - no processing needed)
     */
    getSemanticMemory(key: string, namespace?: string): Promise<unknown>;
    /**
     * Get many semantic memory entries with MLO processing
     */
    getManySemanticMemory<T>(input: GetManyInput, options?: GetManyOptions): Promise<Array<MemoryQueryResult<T>>>;
    /**
     * Delete semantic memory entry with MLO processing
     */
    deleteSemanticMemory(key: string, namespace?: string): Promise<void>;
    /**
 * Delete multiple semantic memory entries with MLO processing
 */
    deleteManySemanticMemory(input: GetManyInput, options?: GetManyOptions): Promise<number>;
    /**
     * Append an event to episodic memory
     */
    appendEpisodic(event: unknown): Promise<void>;
    /**
     * Get episodic events with MLO processing
     */
    getEpisodicEvents<T>(filter?: MemoryQueryOptions): Promise<Array<MemoryQueryResult<T>>>;
    /**
     * Delete episodic event with MLO processing
     */
    deleteEpisodicEvent(id: string): Promise<void>;
    /**
     * Upsert embed memory with MLO processing
     */
    upsertEmbedMemory<T>(key: string, embedding: number[], value: T): Promise<void>;
    /**
     * Query embed memory by vector with MLO processing
     */
    queryEmbedMemoryByVector<T>(vector: number[], opts?: {
        limit?: number;
    }): Promise<Array<MemoryQueryResult<T>>>;
    /**
     * Delete embed memory entry with MLO processing
     */
    deleteEmbedMemory(key: string): Promise<void>;
    /**
     * Unified recall operation across all memory types
     */
    recall(query: string, options?: RecallOptions): Promise<unknown[]>;
    /**
     * Unified remember operation across all memory types
     */
    remember(key: string, value: unknown, options?: RememberOptions): Promise<void>;
    /**
     * Get MLO metrics for observability
     */
    getMetrics(): Record<string, unknown>;
    /**
     * Get current configuration
     */
    getConfiguration(): MemoryLifecycleConfig;
    /**
     * Update configuration at runtime
     */
    configure(config: Partial<MemoryLifecycleConfig>): Promise<void>;
    /**
     * Check if a specific stage is enabled for a memory type
     */
    isStageEnabled(stageName: string, memoryType: string): boolean;
    /**
     * Reset metrics
     */
    resetMetrics(): void;
    /**
     * Shutdown the service and cleanup resources
     */
    shutdown(): Promise<void>;
    /**
     * Dynamically extract content from ModalityFusion output
     * Supports any modality type (text, audio, image, video, sensor, etc.)
     */
    private extractContentFromModalityFusion;
}
