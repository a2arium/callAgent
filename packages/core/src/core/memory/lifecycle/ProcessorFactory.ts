import { IStageProcessor } from './interfaces/IStageProcessor.js';

// Import all implementations
// Stage 1: Acquisition
import { TenantAwareFilter } from './1-acquisition/implementations/filters/TenantAwareFilter.js';
import { LLMCompressor } from './1-acquisition/implementations/compressors/LLMCompressor.js';
import { TextTruncationCompressor } from './1-acquisition/implementations/compressors/TextTruncationCompressor.js';
import { NoveltyConsolidator } from './1-acquisition/implementations/consolidators/NoveltyConsolidator.js';

// Stage 2: Encoding
import { ConversationAttention } from './2-encoding/implementations/attention/ConversationAttention.js';
import { ModalityFusion } from './2-encoding/implementations/fusion/ModalityFusion.js';

// Stage 3: Derivation
import { ConversationReflection } from './3-derivation/implementations/reflection/ConversationReflection.js';
import { SimpleSummarizer } from './3-derivation/implementations/summarization/SimpleSummarizer.js';
import { SimpleDistiller } from './3-derivation/implementations/distillation/SimpleDistiller.js';
import { TimeDecayForgetter } from './3-derivation/implementations/forgetting/TimeDecayForgetter.js';

// Stage 4: Retrieval
import { DirectMemoryIndexer } from './4-retrieval/implementations/indexing/DirectMemoryIndexer.js';
import { SimpleTopKMatcher } from './4-retrieval/implementations/matching/SimpleTopKMatcher.js';

// Stage 5: Neural Memory
import { PlaceholderAssociative } from './5-neural-memory/implementations/associative/PlaceholderAssociative.js';
import { PlaceholderParameterIntegration } from './5-neural-memory/implementations/parameter/PlaceholderParameterIntegration.js';

// Stage 6: Utilization
import { SimpleRAG } from './6-utilization/implementations/rag/SimpleRAG.js';
import { SimpleLongContextManager } from './6-utilization/implementations/context/SimpleLongContextManager.js';
import { SimpleHallucinationMitigator } from './6-utilization/implementations/hallucination/SimpleHallucinationMitigator.js';

/**
 * Processor constructor type - flexible to handle different config types
 */
type ProcessorConstructor = new (config?: any) => IStageProcessor;

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
export class ProcessorFactory {
    private processorMap: Map<string, ProcessorConstructor>;

    constructor() {
        this.processorMap = new Map<string, ProcessorConstructor>([
            // Stage 1: Acquisition
            ['TenantAwareFilter', TenantAwareFilter],
            ['LLMCompressor', LLMCompressor],
            ['TextTruncationCompressor', TextTruncationCompressor],
            ['NoveltyConsolidator', NoveltyConsolidator],

            // Stage 2: Encoding
            ['ConversationAttention', ConversationAttention],
            ['ModalityFusion', ModalityFusion],

            // Stage 3: Derivation
            ['ConversationReflection', ConversationReflection],
            ['SimpleSummarizer', SimpleSummarizer],
            ['SimpleDistiller', SimpleDistiller],
            ['TimeDecayForgetter', TimeDecayForgetter],

            // Stage 4: Retrieval
            ['DirectMemoryIndexer', DirectMemoryIndexer],
            ['SimpleTopKMatcher', SimpleTopKMatcher],

            // Stage 5: Neural Memory
            ['PlaceholderAssociative', PlaceholderAssociative],
            ['PlaceholderParameterIntegration', PlaceholderParameterIntegration],

            // Stage 6: Utilization
            ['SimpleRAG', SimpleRAG],
            ['SimpleLongContextManager', SimpleLongContextManager],
            ['SimpleHallucinationMitigator', SimpleHallucinationMitigator],
        ]);
    }

    /**
     * Create a processor by name with optional configuration
     * @param name Name of the processor class
     * @param config Optional configuration object
     * @returns Instantiated processor
     * @throws Error if processor name is unknown
     */
    create(name: string, config?: unknown): IStageProcessor {
        const ProcessorClass = this.processorMap.get(name);
        if (!ProcessorClass) {
            throw new Error(`Unknown processor: ${name}. Available processors: ${Array.from(this.processorMap.keys()).join(', ')}`);
        }
        return new ProcessorClass(config);
    }

    /**
     * Get list of all available processor names
     * @returns Array of processor names
     */
    getAvailableProcessors(): string[] {
        return Array.from(this.processorMap.keys());
    }

    /**
     * Get processors by stage
     * @param stageName Name of the stage
     * @returns Array of processor names for the stage
     */
    getProcessorsByStage(stageName: string): string[] {
        const stageMap: Record<string, string[]> = {
            acquisition: ['TenantAwareFilter', 'LLMCompressor', 'TextTruncationCompressor', 'NoveltyConsolidator'],
            encoding: ['ConversationAttention', 'ModalityFusion'],
            derivation: ['ConversationReflection', 'SimpleSummarizer', 'SimpleDistiller', 'TimeDecayForgetter'],
            retrieval: ['DirectMemoryIndexer', 'SimpleTopKMatcher'],
            neuralMemory: ['PlaceholderAssociative', 'PlaceholderParameterIntegration'],
            utilization: ['SimpleRAG', 'SimpleLongContextManager', 'SimpleHallucinationMitigator'],
        };
        return stageMap[stageName] || [];
    }

    /**
     * Check if a processor exists
     * @param name Processor name
     * @returns True if processor exists
     */
    hasProcessor(name: string): boolean {
        return this.processorMap.has(name);
    }

    // Convenience methods for each stage

    /**
     * Create an acquisition stage filter
     * @param name Filter name
     * @param config Optional configuration
     * @returns Filter processor
     */
    createFilter(name: string, config?: unknown): IStageProcessor {
        if (!this.getProcessorsByStage('acquisition').includes(name)) {
            throw new Error(`${name} is not a valid acquisition filter. Available: ${this.getProcessorsByStage('acquisition').join(', ')}`);
        }
        return this.create(name, config);
    }

    /**
     * Create an acquisition stage compressor
     * @param name Compressor name
     * @param config Optional configuration
     * @returns Compressor processor
     */
    createCompressor(name: string, config?: unknown): IStageProcessor {
        if (!['LLMCompressor', 'TextTruncationCompressor'].includes(name)) {
            throw new Error(`${name} is not a valid compressor. Available: LLMCompressor, TextTruncationCompressor`);
        }
        return this.create(name, config);
    }

    /**
     * Create an acquisition stage consolidator
     * @param name Consolidator name
     * @param config Optional configuration
     * @returns Consolidator processor
     */
    createConsolidator(name: string, config?: unknown): IStageProcessor {
        if (!['NoveltyConsolidator'].includes(name)) {
            throw new Error(`${name} is not a valid consolidator. Available: NoveltyConsolidator`);
        }
        return this.create(name, config);
    }

    /**
     * Create an encoding stage attention processor
     * @param name Attention processor name
     * @param config Optional configuration
     * @returns Attention processor
     */
    createAttention(name: string, config?: unknown): IStageProcessor {
        if (!['ConversationAttention'].includes(name)) {
            throw new Error(`${name} is not a valid attention processor. Available: ConversationAttention`);
        }
        return this.create(name, config);
    }

    /**
     * Create an encoding stage fusion processor
     * @param name Fusion processor name
     * @param config Optional configuration
     * @returns Fusion processor
     */
    createFusion(name: string, config?: unknown): IStageProcessor {
        if (!['ModalityFusion'].includes(name)) {
            throw new Error(`${name} is not a valid fusion processor. Available: ModalityFusion`);
        }
        return this.create(name, config);
    }

    /**
     * Create a derivation stage reflection processor
     * @param name Reflection processor name
     * @param config Optional configuration
     * @returns Reflection processor
     */
    createReflection(name: string, config?: unknown): IStageProcessor {
        if (!['ConversationReflection'].includes(name)) {
            throw new Error(`${name} is not a valid reflection processor. Available: ConversationReflection`);
        }
        return this.create(name, config);
    }

    /**
     * Create a derivation stage summarization processor
     * @param name Summarization processor name
     * @param config Optional configuration
     * @returns Summarization processor
     */
    createSummarization(name: string, config?: unknown): IStageProcessor {
        if (!['SimpleSummarizer'].includes(name)) {
            throw new Error(`${name} is not a valid summarization processor. Available: SimpleSummarizer`);
        }
        return this.create(name, config);
    }

    /**
     * Create a derivation stage distillation processor
     * @param name Distillation processor name
     * @param config Optional configuration
     * @returns Distillation processor
     */
    createDistillation(name: string, config?: unknown): IStageProcessor {
        if (!['SimpleDistiller'].includes(name)) {
            throw new Error(`${name} is not a valid distillation processor. Available: SimpleDistiller`);
        }
        return this.create(name, config);
    }

    /**
     * Create a derivation stage forgetting processor
     * @param name Forgetting processor name
     * @param config Optional configuration
     * @returns Forgetting processor
     */
    createForgetting(name: string, config?: unknown): IStageProcessor {
        if (!['TimeDecayForgetter'].includes(name)) {
            throw new Error(`${name} is not a valid forgetting processor. Available: TimeDecayForgetter`);
        }
        return this.create(name, config);
    }

    /**
     * Create a retrieval stage indexing processor
     * @param name Indexing processor name
     * @param config Optional configuration
     * @returns Indexing processor
     */
    createIndexing(name: string, config?: unknown): IStageProcessor {
        if (!['DirectMemoryIndexer'].includes(name)) {
            throw new Error(`${name} is not a valid indexing processor. Available: DirectMemoryIndexer`);
        }
        return this.create(name, config);
    }

    /**
     * Create a retrieval stage matching processor
     * @param name Matching processor name
     * @param config Optional configuration
     * @returns Matching processor
     */
    createMatching(name: string, config?: unknown): IStageProcessor {
        if (!['SimpleTopKMatcher'].includes(name)) {
            throw new Error(`${name} is not a valid matching processor. Available: SimpleTopKMatcher`);
        }
        return this.create(name, config);
    }

    /**
     * Create a neural memory stage associative processor
     * @param name Associative processor name
     * @param config Optional configuration
     * @returns Associative processor
     */
    createAssociative(name: string, config?: unknown): IStageProcessor {
        if (!['PlaceholderAssociative'].includes(name)) {
            throw new Error(`${name} is not a valid associative processor. Available: PlaceholderAssociative`);
        }
        return this.create(name, config);
    }

    /**
     * Create a neural memory stage parameter integration processor
     * @param name Parameter integration processor name
     * @param config Optional configuration
     * @returns Parameter integration processor
     */
    createParameterIntegration(name: string, config?: unknown): IStageProcessor {
        if (!['PlaceholderParameterIntegration'].includes(name)) {
            throw new Error(`${name} is not a valid parameter integration processor. Available: PlaceholderParameterIntegration`);
        }
        return this.create(name, config);
    }

    /**
     * Create a utilization stage RAG processor
     * @param name RAG processor name
     * @param config Optional configuration
     * @returns RAG processor
     */
    createRAG(name: string, config?: unknown): IStageProcessor {
        if (!['SimpleRAG'].includes(name)) {
            throw new Error(`${name} is not a valid RAG processor. Available: SimpleRAG`);
        }
        return this.create(name, config);
    }

    /**
     * Create a utilization stage long context processor
     * @param name Long context processor name
     * @param config Optional configuration
     * @returns Long context processor
     */
    createLongContext(name: string, config?: unknown): IStageProcessor {
        if (!['SimpleLongContextManager'].includes(name)) {
            throw new Error(`${name} is not a valid long context processor. Available: SimpleLongContextManager`);
        }
        return this.create(name, config);
    }

    /**
     * Create a utilization stage hallucination mitigation processor
     * @param name Hallucination mitigation processor name
     * @param config Optional configuration
     * @returns Hallucination mitigation processor
     */
    createHallucinationMitigation(name: string, config?: unknown): IStageProcessor {
        if (!['SimpleHallucinationMitigator'].includes(name)) {
            throw new Error(`${name} is not a valid hallucination mitigation processor. Available: SimpleHallucinationMitigator`);
        }
        return this.create(name, config);
    }
} 