import { IStageProcessor } from './interfaces/IStageProcessor.js';
/**
 * Factory for creating stage processors by name
 *
 * Provides centralized instantiation of all Memory Lifecycle Orchestrator (MLO) processors.
 * Each processor can be created with optional configuration and implements the IStageProcessor interface.
 *
 * Usage:
 * ```typescript
 * const factory = new ProcessorFactory();
 * const filter = factory.createFilter('TenantAwareFilter', { tenantId: 'tenant1' });
 * const compressor = factory.createCompressor('LLMCompressor', { maxLength: 500 });
 * ```
 */
export declare class ProcessorFactory {
    private processorMap;
    constructor();
    /**
     * Create a processor by name with optional configuration
     * @param name Name of the processor class
     * @param config Optional configuration object
     * @returns Instantiated processor
     * @throws Error if processor name is unknown
     */
    create(name: string, config?: unknown): IStageProcessor;
    /**
     * Get list of all available processor names
     * @returns Array of processor names
     */
    getAvailableProcessors(): string[];
    /**
     * Get processors by stage
     * @param stageName Name of the stage
     * @returns Array of processor names for the stage
     */
    getProcessorsByStage(stageName: string): string[];
    /**
     * Check if a processor exists
     * @param name Processor name
     * @returns True if processor exists
     */
    hasProcessor(name: string): boolean;
    /**
     * Create an acquisition stage filter
     * @param name Filter name
     * @param config Optional configuration
     * @returns Filter processor
     */
    createFilter(name: string, config?: unknown): IStageProcessor;
    /**
     * Create an acquisition stage compressor
     * @param name Compressor name
     * @param config Optional configuration
     * @returns Compressor processor
     */
    createCompressor(name: string, config?: unknown): IStageProcessor;
    /**
     * Create an acquisition stage consolidator
     * @param name Consolidator name
     * @param config Optional configuration
     * @returns Consolidator processor
     */
    createConsolidator(name: string, config?: unknown): IStageProcessor;
    /**
     * Create an encoding stage attention processor
     * @param name Attention processor name
     * @param config Optional configuration
     * @returns Attention processor
     */
    createAttention(name: string, config?: unknown): IStageProcessor;
    /**
     * Create an encoding stage fusion processor
     * @param name Fusion processor name
     * @param config Optional configuration
     * @returns Fusion processor
     */
    createFusion(name: string, config?: unknown): IStageProcessor;
    /**
     * Create a derivation stage reflection processor
     * @param name Reflection processor name
     * @param config Optional configuration
     * @returns Reflection processor
     */
    createReflection(name: string, config?: unknown): IStageProcessor;
    /**
     * Create a derivation stage summarization processor
     * @param name Summarization processor name
     * @param config Optional configuration
     * @returns Summarization processor
     */
    createSummarization(name: string, config?: unknown): IStageProcessor;
    /**
     * Create a derivation stage distillation processor
     * @param name Distillation processor name
     * @param config Optional configuration
     * @returns Distillation processor
     */
    createDistillation(name: string, config?: unknown): IStageProcessor;
    /**
     * Create a derivation stage forgetting processor
     * @param name Forgetting processor name
     * @param config Optional configuration
     * @returns Forgetting processor
     */
    createForgetting(name: string, config?: unknown): IStageProcessor;
    /**
     * Create a retrieval stage indexing processor
     * @param name Indexing processor name
     * @param config Optional configuration
     * @returns Indexing processor
     */
    createIndexing(name: string, config?: unknown): IStageProcessor;
    /**
     * Create a retrieval stage matching processor
     * @param name Matching processor name
     * @param config Optional configuration
     * @returns Matching processor
     */
    createMatching(name: string, config?: unknown): IStageProcessor;
    /**
     * Create a neural memory stage associative processor
     * @param name Associative processor name
     * @param config Optional configuration
     * @returns Associative processor
     */
    createAssociative(name: string, config?: unknown): IStageProcessor;
    /**
     * Create a neural memory stage parameter integration processor
     * @param name Parameter integration processor name
     * @param config Optional configuration
     * @returns Parameter integration processor
     */
    createParameterIntegration(name: string, config?: unknown): IStageProcessor;
    /**
     * Create a utilization stage RAG processor
     * @param name RAG processor name
     * @param config Optional configuration
     * @returns RAG processor
     */
    createRAG(name: string, config?: unknown): IStageProcessor;
    /**
     * Create a utilization stage long context processor
     * @param name Long context processor name
     * @param config Optional configuration
     * @returns Long context processor
     */
    createLongContext(name: string, config?: unknown): IStageProcessor;
    /**
     * Create a utilization stage hallucination mitigation processor
     * @param name Hallucination mitigation processor name
     * @param config Optional configuration
     * @returns Hallucination mitigation processor
     */
    createHallucinationMitigation(name: string, config?: unknown): IStageProcessor;
}
