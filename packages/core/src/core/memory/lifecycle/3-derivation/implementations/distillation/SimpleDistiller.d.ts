import { IKnowledgeDistiller } from '../../interfaces/IKnowledgeDistiller.js';
import { MemoryItem } from '../../../../../../shared/types/memoryLifecycle.js';
import { ProcessorMetrics } from '../../../interfaces/IStageProcessor.js';
export declare class SimpleDistiller implements IKnowledgeDistiller {
    readonly stageName: "derivation";
    readonly componentName: "distillation";
    readonly stageNumber = 3;
    private logger;
    private metrics;
    private stats;
    /**
     * PHASE 1: No-op knowledge distillation
     *   - Appends stageName, returns the item unchanged.
     *
     * FUTURE (Phase 2+):
     *   - Implement pattern recognition and rule extraction
     *   - Use LLM-based knowledge distillation
     *   - Implement concept hierarchy generation
     *   - Libraries:
     *       • Pattern mining algorithms
     *       • Knowledge graph construction
     *       • LLM-based concept extraction
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    configure(config: {
        enabled?: boolean;
        placeholder?: boolean;
        patternRecognition?: boolean;
        ruleExtraction?: boolean;
        conceptHierarchy?: boolean;
        distillationStrategy?: string;
        qualityThreshold?: number;
        [key: string]: unknown;
    }): void;
    extractKnowledge(item: MemoryItem<unknown>, knowledgeTypes: string[]): Promise<Array<{
        type: string;
        knowledge: unknown;
        confidence: number;
        source: string;
        metadata: Record<string, unknown>;
    }>>;
    identifyPatterns(items: MemoryItem<unknown>[], patternTypes?: string[]): Promise<Array<{
        type: string;
        pattern: string;
        frequency: number;
        examples: MemoryItem<unknown>[];
        confidence: number;
    }>>;
    extractRules(items: MemoryItem<unknown>[]): Promise<Array<{
        rule: string;
        conditions: string[];
        consequences: string[];
        confidence: number;
        supportingEvidence: MemoryItem<unknown>[];
    }>>;
    trackIntents(item: MemoryItem<unknown>): Promise<Array<{
        intent: string;
        confidence: number;
        context: string;
        relatedActions: string[];
    }>>;
    generateRules(patterns: Array<{
        pattern: string;
        support: number;
        confidence: number;
        examples: MemoryItem<unknown>[];
    }>, options?: {
        ruleType?: string;
        minConfidence?: number;
        maxRules?: number;
    }): Promise<Array<{
        rule: string;
        condition: string;
        conclusion: string;
        confidence: number;
        supportingPatterns: string[];
        applicabilityScore: number;
    }>>;
    buildConceptHierarchy(items: MemoryItem<unknown>[], options?: {
        hierarchyType?: string;
        maxDepth?: number;
        clusteringMethod?: string;
    }): Promise<{
        hierarchy: {
            concept: string;
            level: number;
            children: string[];
            parent?: string;
            items: MemoryItem<unknown>[];
            confidence: number;
        }[];
        depth: number;
        totalConcepts: number;
        hierarchyMetadata: Record<string, unknown>;
    }>;
    distillKnowledge(items: MemoryItem<unknown>[], distillationType: 'patterns' | 'rules' | 'concepts' | 'all', options?: {
        qualityThreshold?: number;
        maxOutputs?: number;
        preserveContext?: boolean;
    }): Promise<{
        distilledKnowledge: Array<{
            type: 'pattern' | 'rule' | 'concept';
            content: string;
            confidence: number;
            sourceItems: MemoryItem<unknown>[];
            metadata: Record<string, unknown>;
        }>;
        qualityMetrics: Record<string, number>;
        distillationSummary: string;
    }>;
    validateKnowledge(knowledge: Array<{
        type: string;
        content: string;
        confidence: number;
    }>, validationItems: MemoryItem<unknown>[]): Promise<{
        validatedKnowledge: Array<{
            type: string;
            content: string;
            confidence: number;
            validationScore: number;
            issues: string[];
        }>;
        overallValidationScore: number;
        validationSummary: string;
    }>;
    getDistillationStats(): {
        totalItemsDistilled: number;
        knowledgeExtracted: Record<string, number>;
        patternsIdentified: number;
        rulesExtracted: number;
        intentsTracked: number;
    };
    getMetrics(): ProcessorMetrics;
}
