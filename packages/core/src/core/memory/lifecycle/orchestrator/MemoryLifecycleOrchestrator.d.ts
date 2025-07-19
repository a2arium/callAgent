import { MemoryItem, MemoryOperationResult, RecallOptions, RememberOptions } from '../../../../shared/types/memoryLifecycle.js';
import { MemoryLifecycleConfig } from '../config/types.js';
import { IMemoryLifecycleOrchestrator, PipelineMetrics } from '../interfaces/IMemoryLifecycleOrchestrator.js';
import { IAcquisitionStage } from '../interfaces/IAcquisitionStage.js';
import { IEncodingStage } from '../interfaces/IEncodingStage.js';
import { IDerivationStage } from '../interfaces/IDerivationStage.js';
import { IRetrievalStage } from '../interfaces/IRetrievalStage.js';
import { INeuralMemoryStage } from '../interfaces/INeuralMemoryStage.js';
import { IUtilizationStage } from '../interfaces/IUtilizationStage.js';
/**
 * Memory Lifecycle Orchestrator (MLO)
 *
 * Coordinates the complete 6-stage memory pipeline:
 * 1. Acquisition - Filter, compress, consolidate
 * 2. Encoding - Attention, multi-modal fusion
 * 3. Derivation - Reflection, summarization, distillation, forgetting
 * 4. Retrieval - Indexing, matching
 * 5. Neural Memory - Associative memory, parameter integration
 * 6. Utilization - RAG, long context, hallucination mitigation
 *
 * Supports multiple memory types (working, semantic, episodic, retrieval) with
 * tenant-aware processing and comprehensive observability.
 */
export declare class MemoryLifecycleOrchestrator implements IMemoryLifecycleOrchestrator {
    readonly tenantId: string;
    readonly agentId: string;
    readonly config: MemoryLifecycleConfig;
    readonly acquisition: IAcquisitionStage;
    readonly encoding: IEncodingStage;
    readonly derivation: IDerivationStage;
    readonly retrieval: IRetrievalStage;
    readonly neuralMemory: INeuralMemoryStage;
    readonly utilization: IUtilizationStage;
    private logger;
    private processorFactory;
    private stageProcessors;
    private metrics;
    constructor(config: MemoryLifecycleConfig, tenantId: string, agentId?: string);
    /**
     * Initialize processors for each memory type based on configuration
     */
    private initializeProcessors;
    /**
     * Build processing pipeline for a specific memory type configuration
     */
    private buildPipeline;
    /**
     * Process a memory item through the complete pipeline
     */
    processMemoryItem(item: MemoryItem<unknown>, memoryType: 'workingMemory' | 'semanticLTM' | 'episodicLTM' | 'retrieval'): Promise<MemoryOperationResult>;
    /**
     * Remember (store) a memory item through the pipeline
     */
    remember(content: unknown, options: RememberOptions): Promise<MemoryOperationResult>;
    /**
     * Recall (retrieve) memory items through the pipeline
     */
    recall(query: string, options: RecallOptions): Promise<MemoryItem<unknown>[]>;
    /**
     * Core processing method that runs items through the pipeline
     */
    private process;
    /**
     * Determine target storage based on memory intent
     */
    private determineTargetStore;
    /**
     * Configure the orchestrator with new settings
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
}
