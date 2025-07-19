import { MemoryItem, MemoryOperationResult, RecallOptions, RememberOptions } from '../../../../shared/types/memoryLifecycle.js';
import { MemoryLifecycleConfig } from '../config/types.js';
import { IAcquisitionStage } from './IAcquisitionStage.js';
import { IEncodingStage } from './IEncodingStage.js';
import { IDerivationStage } from './IDerivationStage.js';
import { IRetrievalStage } from './IRetrievalStage.js';
import { INeuralMemoryStage } from './INeuralMemoryStage.js';
import { IUtilizationStage } from './IUtilizationStage.js';
/**
 * Pipeline metrics for observability
 */
export type PipelineMetrics = {
    totalItemsProcessed: number;
    totalItemsDropped: number;
    averageProcessingTimeMs: number;
    stageMetrics: Record<string, {
        itemsProcessed: number;
        itemsDropped: number;
        processingTimeMs: number;
    }>;
    lastProcessedAt?: string;
};
/**
 * Memory Lifecycle Orchestrator - coordinates the complete 6-stage memory pipeline
 */
export type IMemoryLifecycleOrchestrator = {
    readonly tenantId: string;
    readonly agentId: string;
    readonly config: MemoryLifecycleConfig;
    readonly acquisition: IAcquisitionStage;
    readonly encoding: IEncodingStage;
    readonly derivation: IDerivationStage;
    readonly retrieval: IRetrievalStage;
    readonly neuralMemory: INeuralMemoryStage;
    readonly utilization: IUtilizationStage;
    /**
     * Process a memory item through the complete pipeline
     * @param item Memory item to process
     * @param memoryType Type of memory (working, semantic, episodic, retrieval)
     * @returns Result of the pipeline processing
     */
    processMemoryItem(item: MemoryItem<unknown>, memoryType: 'workingMemory' | 'semanticLTM' | 'episodicLTM' | 'retrieval'): Promise<MemoryOperationResult>;
    /**
     * Remember (store) a memory item through the pipeline
     * @param content Content to remember
     * @param options Remember options including memory type and metadata
     * @returns Result of the remember operation
     */
    remember(content: unknown, options: RememberOptions): Promise<MemoryOperationResult>;
    /**
     * Recall (retrieve) memory items through the pipeline
     * @param query Query for retrieval
     * @param options Recall options including memory type and filters
     * @returns Retrieved memory items
     */
    recall(query: string, options: RecallOptions): Promise<MemoryItem<unknown>[]>;
    /**
     * Configure the orchestrator with new settings
     * @param config New configuration to apply
     */
    configure(config: Partial<MemoryLifecycleConfig>): Promise<void>;
    /**
     * Get pipeline metrics for observability
     */
    getMetrics(): PipelineMetrics;
    /**
     * Reset pipeline metrics
     */
    resetMetrics(): void;
    /**
     * Check if a specific stage is enabled
     */
    isStageEnabled(stageName: string, memoryType: string): boolean;
    /**
     * Get the current configuration
     */
    getConfiguration(): MemoryLifecycleConfig;
    /**
     * Shutdown the orchestrator and cleanup resources
     */
    shutdown(): Promise<void>;
};
