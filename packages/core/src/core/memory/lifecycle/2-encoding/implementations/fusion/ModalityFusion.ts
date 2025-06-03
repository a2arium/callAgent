import { IMultiModalFusion } from '../../interfaces/IMultiModalFusion.js';
import { MemoryItem } from '../../../../../../shared/types/memoryLifecycle.js';
import { ProcessorMetrics } from '../../../interfaces/IStageProcessor.js';
import { logger } from '@callagent/utils';

export class ModalityFusion implements IMultiModalFusion {
    readonly stageName = 'encoding' as const;
    readonly componentName = 'fusion' as const;
    readonly stageNumber = 2;

    private logger = logger.createLogger({ prefix: 'ModalityFusion' });
    private metrics: ProcessorMetrics = {
        itemsProcessed: 0,
        itemsDropped: 0,
        processingTimeMs: 0,
    };

    private fusionStats = {
        totalItemsProcessed: 0,
        modalityDistribution: {} as Record<string, number>,
        averageFusionComplexity: 0,
        successfulFusions: 0,
    };

    private modalityType: string;
    private concatenationStrategy: string;
    private speakerEmbedding: boolean;
    private temporalOrdering: boolean;
    private preserveReferences: boolean;
    private structureAware: boolean;
    private fusionWeights: Record<string, number>;

    constructor(config?: {
        modalityType?: string;
        concatenationStrategy?: string;
        speakerEmbedding?: boolean;
        temporalOrdering?: boolean;
        preserveReferences?: boolean;
        structureAware?: boolean;
        fusionWeights?: Record<string, number>;
    }) {
        this.modalityType = config?.modalityType || 'text';
        this.concatenationStrategy = config?.concatenationStrategy || 'weighted';
        this.speakerEmbedding = config?.speakerEmbedding ?? false;
        this.temporalOrdering = config?.temporalOrdering ?? true;
        this.preserveReferences = config?.preserveReferences ?? true;
        this.structureAware = config?.structureAware ?? true;
        this.fusionWeights = config?.fusionWeights || { text: 1.0, metadata: 0.5 };
    }

    /**
     * PHASE 1: Simple concatenation and weighted fusion
     * FUTURE: Advanced multi-modal fusion with embeddings
     * 
     * @see https://arxiv.org/abs/1908.02265 - Multi-modal fusion techniques
     * @see https://platform.openai.com/docs/guides/vision - Vision and text fusion
     * 
     * ENHANCEMENT: Cross-Modal Attention
     * Consider implementing cross-modal attention mechanisms:
     * - Text-to-image attention for visual content
     * - Audio-to-text alignment for speech
     * - Temporal fusion for time-series data
     */
    async process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>> {
        const startTime = Date.now();
        this.metrics.itemsProcessed++;
        this.fusionStats.totalItemsProcessed++;

        try {
            // Add processing history
            if (!item.metadata.processingHistory) {
                item.metadata.processingHistory = [];
            }
            item.metadata.processingHistory.push(`${this.stageName}:${this.componentName}`);

            // Extract modalities from the item
            const modalities = await this.extractModalities(item);

            // Update modality distribution stats
            for (const modality of modalities) {
                this.fusionStats.modalityDistribution[modality.type] =
                    (this.fusionStats.modalityDistribution[modality.type] || 0) + 1;
            }

            // Perform fusion if multiple modalities detected
            if (modalities.length > 1) {
                const fusionResult = await this.fuseModalities(modalities);

                const fusedItem: MemoryItem<unknown> = {
                    ...item,
                    data: fusionResult.fusedContent,
                    metadata: {
                        ...item.metadata,
                        multiModalFusion: true,
                        modalityTypes: modalities.map(m => m.type),
                        fusionWeights: fusionResult.modalityWeights,
                        fusionMetadata: fusionResult.fusionMetadata,
                        fusionComplexity: modalities.length,
                    }
                };

                this.fusionStats.successfulFusions++;
                this.updateFusionComplexity(modalities.length);

                this.logger.debug('Multi-modal fusion completed', {
                    itemId: item.id,
                    modalityCount: modalities.length,
                    modalityTypes: modalities.map(m => m.type)
                });

                this.metrics.processingTimeMs += Date.now() - startTime;
                this.metrics.lastProcessedAt = new Date().toISOString();

                return fusedItem;
            } else {
                // Single modality, no fusion needed
                this.metrics.processingTimeMs += Date.now() - startTime;
                this.metrics.lastProcessedAt = new Date().toISOString();

                return {
                    ...item,
                    metadata: {
                        ...item.metadata,
                        modalityType: modalities[0]?.type || 'unknown',
                        singleModality: true,
                    }
                };
            }
        } catch (error) {
            this.logger.error('Error in multi-modal fusion', {
                itemId: item.id,
                error: error instanceof Error ? error.message : 'Unknown error'
            });

            this.metrics.processingTimeMs += Date.now() - startTime;
            return item;
        }
    }

    /**
     * Extract modalities from memory item data
     * 
     * This method is designed to be extensible - it can handle any modality type:
     * - text, audio, image, video (media modalities)
     * - metadata, structured, temporal (context modalities) 
     * - sensor, geolocation, biometric (IoT modalities)
     * - custom domain-specific modalities
     * 
     * To add new modality extractors, simply add detection logic below.
     */
    async extractModalities(item: MemoryItem<unknown>): Promise<Array<{
        type: string;
        content: unknown;
        confidence: number;
    }>> {
        const modalities: Array<{ type: string; content: unknown; confidence: number }> = [];

        // Extract text modality
        const textContent = this.extractTextContent(item.data);
        if (textContent) {
            modalities.push({
                type: 'text',
                content: textContent,
                confidence: 0.9
            });
        }

        // Extract image modality (example for future implementation)
        const imageContent = this.extractImageContent(item.data);
        if (imageContent) {
            modalities.push({
                type: 'image',
                content: imageContent,
                confidence: 0.8
            });
        }

        // Extract audio modality (example for future implementation) 
        const audioContent = this.extractAudioContent(item.data);
        if (audioContent) {
            modalities.push({
                type: 'audio',
                content: audioContent,
                confidence: 0.8
            });
        }

        // Extract metadata modality
        if (item.metadata && Object.keys(item.metadata).length > 0) {
            modalities.push({
                type: 'metadata',
                content: item.metadata,
                confidence: 0.7
            });
        }

        // Extract structured data modality
        if (typeof item.data === 'object' && item.data !== null && !Array.isArray(item.data)) {
            const structuredContent = this.extractStructuredContent(item.data);
            if (structuredContent) {
                modalities.push({
                    type: 'structured',
                    content: structuredContent,
                    confidence: 0.8
                });
            }
        }

        // Extract temporal modality (if timestamp information is available)
        if (item.metadata.timestamp) {
            modalities.push({
                type: 'temporal',
                content: {
                    timestamp: item.metadata.timestamp,
                    timeContext: this.extractTimeContext(item.metadata.timestamp)
                },
                confidence: 0.6
            });
        }

        return modalities;
    }

    private extractTextContent(data: unknown): string | null {
        if (typeof data === 'string') {
            return data;
        } else if (typeof data === 'object' && data !== null) {
            const obj = data as Record<string, unknown>;
            const textFields = ['text', 'content', 'message', 'description', 'body'];

            for (const field of textFields) {
                if (obj[field] && typeof obj[field] === 'string') {
                    return obj[field] as string;
                }
            }
        }

        return null;
    }

    private extractImageContent(data: unknown): unknown | null {
        // FUTURE: Implement image content extraction
        // Look for base64 data, image URLs, buffer data, etc.
        if (typeof data === 'object' && data !== null) {
            const obj = data as Record<string, unknown>;
            const imageFields = ['image', 'img', 'imageData', 'imageUrl', 'picture'];

            for (const field of imageFields) {
                if (obj[field]) {
                    return obj[field];
                }
            }
        }
        return null;
    }

    private extractAudioContent(data: unknown): unknown | null {
        // FUTURE: Implement audio content extraction  
        // Look for audio buffers, audio URLs, waveform data, etc.
        if (typeof data === 'object' && data !== null) {
            const obj = data as Record<string, unknown>;
            const audioFields = ['audio', 'audioData', 'audioUrl', 'sound', 'recording'];

            for (const field of audioFields) {
                if (obj[field]) {
                    return obj[field];
                }
            }
        }
        return null;
    }

    private extractStructuredContent(data: unknown): Record<string, unknown> | null {
        if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
            const obj = data as Record<string, unknown>;

            // Filter out text fields to avoid duplication
            const textFields = new Set(['text', 'content', 'message', 'description', 'body']);
            const structuredData: Record<string, unknown> = {};

            for (const [key, value] of Object.entries(obj)) {
                if (!textFields.has(key)) {
                    structuredData[key] = value;
                }
            }

            return Object.keys(structuredData).length > 0 ? structuredData : null;
        }

        return null;
    }

    private extractTimeContext(timestamp: string): Record<string, unknown> {
        const date = new Date(timestamp);

        return {
            hour: date.getHours(),
            dayOfWeek: date.getDay(),
            month: date.getMonth(),
            year: date.getFullYear(),
            isWeekend: date.getDay() === 0 || date.getDay() === 6,
            timeOfDay: this.getTimeOfDay(date.getHours())
        };
    }

    private getTimeOfDay(hour: number): string {
        if (hour < 6) return 'night';
        if (hour < 12) return 'morning';
        if (hour < 18) return 'afternoon';
        return 'evening';
    }

    async fuseModalities(
        modalities: Array<{
            type: string;
            content: unknown;
            weight?: number;
            metadata?: Record<string, unknown>;
        }>
    ): Promise<{
        fusedContent: unknown;
        modalityWeights: Record<string, number>;
        fusionMetadata: Record<string, unknown>;
    }> {
        const modalityWeights: Record<string, number> = {};
        const fusionMetadata: Record<string, unknown> = {
            fusionStrategy: this.concatenationStrategy,
            fusedAt: new Date().toISOString(),
            modalityCount: modalities.length
        };

        // Calculate weights for each modality
        for (const modality of modalities) {
            const baseWeight = this.fusionWeights[modality.type] || 1.0;
            const confidenceWeight = modality.weight || 1.0;
            modalityWeights[modality.type] = baseWeight * confidenceWeight;
        }

        // Apply fusion strategy
        let fusedContent: unknown;

        switch (this.concatenationStrategy) {
            case 'weighted':
                fusedContent = this.weightedFusion(modalities, modalityWeights);
                break;
            case 'concatenation':
                fusedContent = this.concatenationFusion(modalities);
                break;
            case 'hierarchical':
                fusedContent = this.hierarchicalFusion(modalities, modalityWeights);
                break;
            default:
                fusedContent = this.concatenationFusion(modalities);
        }

        return {
            fusedContent,
            modalityWeights,
            fusionMetadata
        };
    }

    private weightedFusion(
        modalities: Array<{ type: string; content: unknown; weight?: number }>,
        weights: Record<string, number>
    ): unknown {
        // Phase 1: Simple weighted combination
        const fusedData: Record<string, unknown> = {};

        for (const modality of modalities) {
            const weight = weights[modality.type] || 1.0;

            if (typeof modality.content === 'string') {
                fusedData[modality.type] = {
                    content: modality.content,
                    weight,
                    length: modality.content.length
                };
            } else if (typeof modality.content === 'object' && modality.content !== null) {
                fusedData[modality.type] = {
                    content: modality.content,
                    weight,
                    complexity: Object.keys(modality.content as Record<string, unknown>).length
                };
            } else {
                fusedData[modality.type] = {
                    content: modality.content,
                    weight
                };
            }
        }

        return fusedData;
    }

    private concatenationFusion(
        modalities: Array<{ type: string; content: unknown }>
    ): unknown {
        // Simple concatenation strategy
        const textParts: string[] = [];
        const structuredParts: Record<string, unknown> = {};

        for (const modality of modalities) {
            if (typeof modality.content === 'string') {
                textParts.push(`[${modality.type.toUpperCase()}] ${modality.content}`);
            } else {
                structuredParts[modality.type] = modality.content;
            }
        }

        if (textParts.length > 0 && Object.keys(structuredParts).length > 0) {
            return {
                text: textParts.join('\n\n'),
                structured: structuredParts
            };
        } else if (textParts.length > 0) {
            return textParts.join('\n\n');
        } else {
            return structuredParts;
        }
    }

    private hierarchicalFusion(
        modalities: Array<{ type: string; content: unknown }>,
        weights: Record<string, number>
    ): unknown {
        // Hierarchical fusion based on weights
        const sortedModalities = modalities.sort((a, b) =>
            (weights[b.type] || 1.0) - (weights[a.type] || 1.0)
        );

        const hierarchy: Record<string, unknown> = {
            primary: sortedModalities[0],
            secondary: sortedModalities.slice(1),
            fusionOrder: sortedModalities.map(m => m.type)
        };

        return hierarchy;
    }

    private updateFusionComplexity(modalityCount: number): void {
        const totalFusions = this.fusionStats.successfulFusions;

        if (totalFusions === 1) {
            this.fusionStats.averageFusionComplexity = modalityCount;
        } else {
            this.fusionStats.averageFusionComplexity =
                (this.fusionStats.averageFusionComplexity * (totalFusions - 1) + modalityCount) / totalFusions;
        }
    }

    configure(config: {
        modalityType?: string;
        concatenationStrategy?: string;
        speakerEmbedding?: boolean;
        temporalOrdering?: boolean;
        preserveReferences?: boolean;
        structureAware?: boolean;
        fusionWeights?: Record<string, number>;
        [key: string]: unknown;
    }): void {
        if (config.modalityType !== undefined) {
            this.modalityType = config.modalityType;
        }
        if (config.concatenationStrategy !== undefined) {
            this.concatenationStrategy = config.concatenationStrategy;
        }
        if (config.speakerEmbedding !== undefined) {
            this.speakerEmbedding = config.speakerEmbedding;
        }
        if (config.temporalOrdering !== undefined) {
            this.temporalOrdering = config.temporalOrdering;
        }
        if (config.preserveReferences !== undefined) {
            this.preserveReferences = config.preserveReferences;
        }
        if (config.structureAware !== undefined) {
            this.structureAware = config.structureAware;
        }
        if (config.fusionWeights !== undefined) {
            this.fusionWeights = config.fusionWeights;
        }
    }

    getMetrics(): ProcessorMetrics {
        return { ...this.metrics };
    }

    getFusionStats() {
        return { ...this.fusionStats };
    }
} 