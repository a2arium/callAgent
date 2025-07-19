import { IStageProcessor } from '../../interfaces/IStageProcessor.js';
import { MemoryItem } from '../../../../../shared/types/memoryLifecycle.js';
/**
 * Knowledge Distiller Interface - extracts key patterns, rules, and knowledge
 * Implements topic extraction, intent tracking, and pattern recognition
 */
export type IKnowledgeDistiller = IStageProcessor & {
    readonly stageName: 'derivation';
    readonly componentName: 'distillation';
    /**
     * Extract distilled knowledge from memory items
     * @param item Memory item to distill
     * @returns Memory item with distilled knowledge added
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    /**
     * Configure distillation mechanism
     */
    configure(config: {
        enabled?: boolean;
        placeholder?: boolean;
        extractTopics?: boolean;
        trackIntents?: boolean;
        extractRules?: boolean;
        patternRecognition?: boolean;
        knowledgeTypes?: string[];
        [key: string]: unknown;
    }): void;
    /**
     * Extract specific types of knowledge
     */
    extractKnowledge(item: MemoryItem<unknown>, knowledgeTypes: string[]): Promise<Array<{
        type: string;
        knowledge: unknown;
        confidence: number;
        source: string;
        metadata: Record<string, unknown>;
    }>>;
    /**
     * Identify patterns across multiple items
     */
    identifyPatterns(items: MemoryItem<unknown>[], patternTypes?: string[]): Promise<Array<{
        type: string;
        pattern: string;
        frequency: number;
        examples: MemoryItem<unknown>[];
        confidence: number;
    }>>;
    /**
     * Extract rules and principles
     */
    extractRules(items: MemoryItem<unknown>[]): Promise<Array<{
        rule: string;
        conditions: string[];
        consequences: string[];
        confidence: number;
        supportingEvidence: MemoryItem<unknown>[];
    }>>;
    /**
     * Track intents and goals
     */
    trackIntents(item: MemoryItem<unknown>): Promise<Array<{
        intent: string;
        confidence: number;
        context: string;
        relatedActions: string[];
    }>>;
    /**
     * Get distillation statistics
     */
    getDistillationStats(): {
        totalItemsDistilled: number;
        knowledgeExtracted: Record<string, number>;
        patternsIdentified: number;
        rulesExtracted: number;
        intentsTracked: number;
    };
};
