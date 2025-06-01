import { IStageProcessor } from '../../interfaces/IStageProcessor.js';
import { MemoryItem } from '../../../../../shared/types/memoryLifecycle.js';

/**
 * Reflection Engine Interface - generates insights and meta-cognition about memory items
 * Implements conversation-aware reflection and insight extraction
 */
export type IReflectionEngine = IStageProcessor & {
    readonly stageName: 'derivation';
    readonly componentName: 'reflection';

    /**
     * Generate reflective insights about memory items
     * @param item Memory item to reflect on
     * @returns Memory item with reflection metadata added
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;

    /**
     * Configure reflection mechanism
     */
    configure(config: {
        enabled?: boolean;
        placeholder?: boolean;
        conversationAware?: boolean;
        trackMisunderstandings?: boolean;
        insightExtraction?: boolean;
        llmProvider?: string;
        reflectionDepth?: 'shallow' | 'medium' | 'deep';
        [key: string]: unknown;
    }): void;

    /**
     * Generate specific insights about a memory item
     */
    generateInsights(
        item: MemoryItem<unknown>,
        insightTypes?: string[]
    ): Promise<Array<{
        type: string;
        insight: string;
        confidence: number;
        evidence: string[];
    }>>;

    /**
     * Reflect on patterns across multiple memory items
     */
    reflectOnPatterns(
        items: MemoryItem<unknown>[]
    ): Promise<Array<{
        pattern: string;
        description: string;
        frequency: number;
        significance: number;
        examples: MemoryItem<unknown>[];
    }>>;

    /**
     * Track misunderstandings and conflicts
     */
    trackMisunderstandings(
        item: MemoryItem<unknown>,
        context: MemoryItem<unknown>[]
    ): Promise<Array<{
        type: 'contradiction' | 'ambiguity' | 'gap';
        description: string;
        severity: number;
        suggestedResolution: string;
    }>>;

    /**
     * Get reflection statistics
     */
    getReflectionStats(): {
        totalItemsReflected: number;
        insightsGenerated: number;
        patternsIdentified: number;
        misunderstandingsTracked: number;
        averageReflectionDepth: number;
    };
}; 