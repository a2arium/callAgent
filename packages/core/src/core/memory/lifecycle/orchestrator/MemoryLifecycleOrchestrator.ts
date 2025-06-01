import { logger } from '@callagent/utils';
import { MemoryItem, MemoryIntent, MemoryOperationResult, RecallOptions, RememberOptions } from '../../../../shared/types/memoryLifecycle.js';
import { MemoryLifecycleConfig } from '../config/types.js';
import { ProcessorFactory } from '../ProcessorFactory.js';
import { IStageProcessor } from '../interfaces/IStageProcessor.js';
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
export class MemoryLifecycleOrchestrator implements IMemoryLifecycleOrchestrator {
    readonly tenantId: string;
    readonly agentId: string;
    readonly config: MemoryLifecycleConfig;

    // Stage processors (placeholder implementations for Phase 1)
    readonly acquisition: IAcquisitionStage;
    readonly encoding: IEncodingStage;
    readonly derivation: IDerivationStage;
    readonly retrieval: IRetrievalStage;
    readonly neuralMemory: INeuralMemoryStage;
    readonly utilization: IUtilizationStage;

    private logger = logger.createLogger({ prefix: 'MLO' });
    private processorFactory: ProcessorFactory;
    private stageProcessors: Map<MemoryIntent, IStageProcessor[]>;
    private metrics: PipelineMetrics;

    constructor(
        config: MemoryLifecycleConfig,
        tenantId: string,
        agentId: string = 'default'
    ) {
        this.config = config;
        this.tenantId = tenantId;
        this.agentId = agentId;
        this.processorFactory = new ProcessorFactory();
        this.stageProcessors = new Map();
        this.metrics = {
            totalItemsProcessed: 0,
            totalItemsDropped: 0,
            averageProcessingTimeMs: 0,
            stageMetrics: {},
        };

        // Initialize placeholder stage implementations
        this.acquisition = {} as IAcquisitionStage;
        this.encoding = {} as IEncodingStage;
        this.derivation = {} as IDerivationStage;
        this.retrieval = {} as IRetrievalStage;
        this.neuralMemory = {} as INeuralMemoryStage;
        this.utilization = {} as IUtilizationStage;

        this.initializeProcessors();

        this.logger.info('MLO initialized', {
            tenantId: this.tenantId,
            agentId: this.agentId,
            profile: this.config.profile
        });
    }

    /**
     * Initialize processors for each memory type based on configuration
     */
    private initializeProcessors(): void {
        try {
            // Initialize processors for each memory intent
            this.stageProcessors.set('workingMemory', this.buildPipeline(this.config.workingMemory));
            this.stageProcessors.set('semanticLTM', this.buildPipeline(this.config.semanticLTM));
            this.stageProcessors.set('episodicLTM', this.buildPipeline(this.config.episodicLTM));
            this.stageProcessors.set('retrieval', this.buildPipeline(this.config.retrieval));

            this.logger.debug('Processors initialized for all memory types', {
                memoryTypes: Array.from(this.stageProcessors.keys()),
                totalProcessors: Array.from(this.stageProcessors.values()).reduce((sum, processors) => sum + processors.length, 0)
            });
        } catch (error) {
            this.logger.error('Failed to initialize processors', {
                error: error instanceof Error ? error.message : 'Unknown error'
            });
            throw error;
        }
    }

    /**
     * Build processing pipeline for a specific memory type configuration
     */
    private buildPipeline(stageConfig: any): IStageProcessor[] {
        const processors: IStageProcessor[] = [];

        this.logger.debug('Building pipeline', {
            stageConfig: JSON.stringify(stageConfig, null, 2)
        });

        try {
            // Stage 1: Acquisition
            const acquisition = stageConfig.stages?.acquisition || stageConfig.acquisition;
            if (acquisition?.filter) {
                processors.push(this.processorFactory.createFilter(
                    acquisition.filter,
                    { ...acquisition.config?.filter, tenantId: this.tenantId }
                ));
            }
            if (acquisition?.compressor) {
                processors.push(this.processorFactory.createCompressor(
                    acquisition.compressor,
                    acquisition.config?.compressor
                ));
            }
            if (acquisition?.consolidator &&
                acquisition.config?.consolidator?.enabled !== false) {
                processors.push(this.processorFactory.createConsolidator(
                    acquisition.consolidator,
                    acquisition.config?.consolidator
                ));
            }

            // Stage 2: Encoding
            const encoding = stageConfig.stages?.encoding || stageConfig.encoding;
            if (encoding?.attention &&
                encoding.config?.attention?.enabled !== false) {
                processors.push(this.processorFactory.createAttention(
                    encoding.attention,
                    encoding.config?.attention
                ));
            }
            if (encoding?.fusion &&
                encoding.config?.fusion?.enabled !== false) {
                processors.push(this.processorFactory.createFusion(
                    encoding.fusion,
                    encoding.config?.fusion
                ));
            }

            // Stage 3: Derivation
            const derivation = stageConfig.stages?.derivation || stageConfig.derivation;
            if (derivation?.reflection &&
                derivation.config?.reflection?.enabled !== false) {
                processors.push(this.processorFactory.createReflection(
                    derivation.reflection,
                    derivation.config?.reflection
                ));
            }
            if (derivation?.summarization) {
                processors.push(this.processorFactory.createSummarization(
                    derivation.summarization,
                    derivation.config?.summarization
                ));
            }
            if (derivation?.distillation &&
                derivation.config?.distillation?.enabled !== false) {
                processors.push(this.processorFactory.createDistillation(
                    derivation.distillation,
                    derivation.config?.distillation
                ));
            }
            if (derivation?.forgetting) {
                processors.push(this.processorFactory.createForgetting(
                    derivation.forgetting,
                    derivation.config?.forgetting
                ));
            }

            // Stage 4: Retrieval
            const retrieval = stageConfig.stages?.retrieval || stageConfig.retrieval;
            if (retrieval?.indexing) {
                processors.push(this.processorFactory.createIndexing(
                    retrieval.indexing,
                    retrieval.config?.indexing
                ));
            }
            if (retrieval?.matching) {
                processors.push(this.processorFactory.createMatching(
                    retrieval.matching,
                    retrieval.config?.matching
                ));
            }

            // Stage 5: Neural Memory
            const neuralMemory = stageConfig.stages?.neuralMemory || stageConfig.neuralMemory;
            if (neuralMemory?.associative &&
                neuralMemory.config?.associative?.enabled !== false) {
                processors.push(this.processorFactory.createAssociative(
                    neuralMemory.associative,
                    neuralMemory.config?.associative
                ));
            }
            if (neuralMemory?.parameterIntegration &&
                neuralMemory.config?.parameterIntegration?.enabled !== false) {
                processors.push(this.processorFactory.createParameterIntegration(
                    neuralMemory.parameterIntegration,
                    neuralMemory.config?.parameterIntegration
                ));
            }

            // Stage 6: Utilization
            const utilization = stageConfig.stages?.utilization || stageConfig.utilization;
            if (utilization?.rag) {
                processors.push(this.processorFactory.createRAG(
                    utilization.rag,
                    utilization.config?.rag
                ));
            }
            if (utilization?.longContext) {
                processors.push(this.processorFactory.createLongContext(
                    utilization.longContext,
                    utilization.config?.longContext
                ));
            }
            if (utilization?.hallucinationMitigation &&
                utilization.config?.hallucinationMitigation?.enabled !== false) {
                processors.push(this.processorFactory.createHallucinationMitigation(
                    utilization.hallucinationMitigation,
                    utilization.config?.hallucinationMitigation
                ));
            }

            this.logger.debug('Pipeline built', {
                stageCount: processors.length,
                stages: processors.map(p => p.stageName)
            });

            return processors;
        } catch (error) {
            this.logger.error('Failed to build pipeline', {
                error: error instanceof Error ? error.message : 'Unknown error'
            });
            throw error;
        }
    }

    /**
     * Process a memory item through the complete pipeline
     */
    async processMemoryItem(
        item: MemoryItem<unknown>,
        memoryType: 'workingMemory' | 'semanticLTM' | 'episodicLTM' | 'retrieval'
    ): Promise<MemoryOperationResult> {
        const startTime = Date.now();
        const intent = memoryType as MemoryIntent;

        this.logger.debug('Starting memory item processing', {
            itemId: item.id,
            memoryType,
            tenantId: this.tenantId,
            agentId: this.agentId
        });

        try {
            const result = await this.process(item, intent);

            // Update metrics
            this.metrics.totalItemsProcessed++;
            const processingTime = Date.now() - startTime;
            this.metrics.averageProcessingTimeMs =
                (this.metrics.averageProcessingTimeMs * (this.metrics.totalItemsProcessed - 1) + processingTime) /
                this.metrics.totalItemsProcessed;
            this.metrics.lastProcessedAt = new Date().toISOString();

            return result;
        } catch (error) {
            this.logger.error('Memory item processing failed', {
                itemId: item.id,
                memoryType,
                error: error instanceof Error ? error.message : 'Unknown error'
            });

            this.metrics.totalItemsDropped++;

            return {
                success: false,
                processedItems: [],
                metadata: {
                    error: error instanceof Error ? error.message : 'Unknown error',
                    processingTimeMs: Date.now() - startTime
                }
            };
        }
    }

    /**
     * Remember (store) a memory item through the pipeline
     */
    async remember(
        content: unknown,
        options: RememberOptions
    ): Promise<MemoryOperationResult> {
        const memoryItem: MemoryItem<unknown> = {
            id: `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            data: content,
            dataType: typeof content === 'string' ? 'text' : 'json',
            intent: (options.type === 'semantic' ? 'semanticLTM' : 'episodicLTM') as MemoryIntent,
            metadata: {
                tenantId: this.tenantId,
                agentId: this.agentId,
                sourceOperation: 'remember',
                timestamp: new Date().toISOString(),
                processingHistory: []
            }
        };

        this.logger.debug('Remember operation initiated', {
            itemId: memoryItem.id,
            memoryType: options.type,
            contentType: typeof content
        });

        return this.processMemoryItem(memoryItem, memoryItem.intent as 'workingMemory' | 'semanticLTM' | 'episodicLTM' | 'retrieval');
    }

    /**
     * Recall (retrieve) memory items through the pipeline
     */
    async recall(
        query: string,
        options: RecallOptions
    ): Promise<MemoryItem<unknown>[]> {
        const queryItem: MemoryItem<unknown> = {
            id: `query_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            data: query,
            dataType: 'text',
            intent: 'retrieval',
            metadata: {
                tenantId: this.tenantId,
                agentId: this.agentId,
                sourceOperation: 'recall',
                timestamp: new Date().toISOString(),
                processingHistory: [],
                queryOptions: options
            }
        };

        this.logger.debug('Recall operation initiated', {
            queryId: queryItem.id,
            query: query.substring(0, 100),
            memoryType: options.type
        });

        const result = await this.processMemoryItem(queryItem, 'retrieval');

        if (result.success) {
            return result.processedItems || [];
        } else {
            this.logger.warn('Recall operation failed', {
                queryId: queryItem.id,
                error: result.metadata?.error
            });
            return [];
        }
    }

    /**
     * Core processing method that runs items through the pipeline
     */
    private async process(item: MemoryItem<unknown>, intent?: MemoryIntent): Promise<MemoryOperationResult> {
        const effectiveIntent = intent || item.intent;
        const processors = this.stageProcessors.get(effectiveIntent);

        if (!processors) {
            this.logger.error('No processors configured for intent', { intent: effectiveIntent });
            return {
                success: false,
                processedItems: [],
                metadata: { error: 'No processors configured' }
            };
        }

        const startTime = Date.now();
        let currentItems: MemoryItem<unknown>[] = [item];

        this.logger.debug('Starting MLO pipeline', {
            intent: effectiveIntent,
            itemId: item.id,
            sourceOperation: item.metadata.sourceOperation,
            processorCount: processors.length,
            processorNames: processors.map(p => p.constructor.name)
        });

        // Process through all stages
        for (const processor of processors) {
            const stageStart = Date.now();
            const nextItems: MemoryItem<unknown>[] = [];

            for (const currentItem of currentItems) {
                try {
                    const result = await processor.process(currentItem);

                    if (result === null || result === undefined) {
                        this.logger.debug('Item filtered out', {
                            stage: processor.stageName,
                            itemId: currentItem.id
                        });
                        continue;
                    }

                    if (Array.isArray(result)) {
                        nextItems.push(...result);
                    } else {
                        nextItems.push(result);
                    }
                } catch (error) {
                    this.logger.error('Processor error', {
                        stage: processor.stageName,
                        itemId: currentItem.id,
                        error: error instanceof Error ? error.message : 'Unknown error'
                    });
                    // Continue with other items
                }
            }

            const stageDuration = Date.now() - stageStart;

            // Update stage metrics
            const stageKey = processor.stageName;
            if (!this.metrics.stageMetrics[stageKey]) {
                this.metrics.stageMetrics[stageKey] = {
                    itemsProcessed: 0,
                    itemsDropped: 0,
                    processingTimeMs: 0
                };
            }
            this.metrics.stageMetrics[stageKey].itemsProcessed += currentItems.length;
            this.metrics.stageMetrics[stageKey].itemsDropped += (currentItems.length - nextItems.length);
            this.metrics.stageMetrics[stageKey].processingTimeMs += stageDuration;

            this.logger.debug('Stage complete', {
                stage: processor.stageName,
                inputItems: currentItems.length,
                outputItems: nextItems.length,
                durationMs: stageDuration
            });

            currentItems = nextItems;

            // If no items left, stop processing
            if (currentItems.length === 0) {
                this.logger.debug('Pipeline terminated - no items remaining');
                break;
            }
        }

        const totalDuration = Date.now() - startTime;

        this.logger.info('MLO pipeline complete', {
            intent: effectiveIntent,
            inputItemId: item.id,
            outputItems: currentItems.length,
            totalDurationMs: totalDuration,
            stagesProcessed: currentItems[0]?.metadata.processingHistory?.length || 0
        });

        return {
            success: currentItems.length > 0,
            processedItems: currentItems,
            targetStore: this.determineTargetStore(effectiveIntent),
            metadata: {
                processingTimeMs: totalDuration,
                stagesProcessed: processors.length,
                intent: effectiveIntent,
                tenantId: this.tenantId,
                agentId: this.agentId
            }
        };
    }

    /**
     * Determine target storage based on memory intent
     */
    private determineTargetStore(intent: MemoryIntent): string {
        switch (intent) {
            case 'workingMemory':
                return 'workingMemory';
            case 'semanticLTM':
                return 'semanticLTM';
            case 'episodicLTM':
                return 'episodicLTM';
            case 'retrieval':
                return 'queryResult';
            default:
                return 'unknown';
        }
    }

    /**
     * Configure the orchestrator with new settings
     */
    async configure(config: Partial<MemoryLifecycleConfig>): Promise<void> {
        this.logger.info('Reconfiguring MLO', {
            previousProfile: this.config.profile,
            newConfig: config
        });

        // Merge new configuration
        Object.assign(this.config, config);

        // Reinitialize processors with new configuration
        this.stageProcessors.clear();
        this.initializeProcessors();

        this.logger.info('MLO reconfiguration complete');
    }

    /**
     * Get pipeline metrics for observability
     */
    getMetrics(): PipelineMetrics {
        return { ...this.metrics };
    }

    /**
     * Reset pipeline metrics
     */
    resetMetrics(): void {
        this.metrics = {
            totalItemsProcessed: 0,
            totalItemsDropped: 0,
            averageProcessingTimeMs: 0,
            stageMetrics: {},
        };
        this.logger.debug('Metrics reset');
    }

    /**
     * Check if a specific stage is enabled
     */
    isStageEnabled(stageName: string, memoryType: string): boolean {
        const processors = this.stageProcessors.get(memoryType as MemoryIntent);
        if (!processors) return false;

        return processors.some(p => p.stageName === stageName);
    }

    /**
     * Get the current configuration
     */
    getConfiguration(): MemoryLifecycleConfig {
        return { ...this.config };
    }

    /**
     * Shutdown the orchestrator and cleanup resources
     */
    async shutdown(): Promise<void> {
        this.logger.info('Shutting down MLO', {
            tenantId: this.tenantId,
            agentId: this.agentId,
            totalItemsProcessed: this.metrics.totalItemsProcessed
        });

        // Clear processor maps
        this.stageProcessors.clear();

        // Reset metrics
        this.resetMetrics();

        this.logger.info('MLO shutdown complete');
    }
} 