import { IReflectionEngine } from '../../interfaces/IReflectionEngine.js';
import { MemoryItem } from '../../../../../../shared/types/memoryLifecycle.js';
import { ProcessorMetrics } from '../../../interfaces/IStageProcessor.js';
export declare class ConversationReflection implements IReflectionEngine {
    readonly stageName: "derivation";
    readonly componentName: "reflection";
    readonly stageNumber = 3;
    private logger;
    private metrics;
    private stats;
    private enabled;
    private placeholder;
    private conversationAware;
    private enableMisunderstandingTracking;
    private insightExtraction;
    private llmProvider;
    private reflectionDepth;
    constructor(config?: {
        enabled?: boolean;
        placeholder?: boolean;
        conversationAware?: boolean;
        trackMisunderstandings?: boolean;
        insightExtraction?: boolean;
        llmProvider?: string;
        reflectionDepth?: 'shallow' | 'medium' | 'deep';
    });
    /**
     * PHASE 1: Rule-based insight generation
     * FUTURE: LLM-based reflection and meta-cognition
     *
     * @see https://arxiv.org/abs/2303.11366 - Reflexion: Language Agents with Verbal Reinforcement Learning
     * @see https://platform.openai.com/docs/guides/prompt-engineering - Prompt engineering for reflection
     *
     * ENHANCEMENT: Meta-Cognitive Reflection
     * Consider implementing meta-cognitive reflection patterns:
     * - Self-assessment of understanding quality
     * - Confidence calibration for insights
     * - Learning from reflection outcomes
     */
    process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>>;
    generateInsights(item: MemoryItem<unknown>, insightTypes?: string[]): Promise<Array<{
        type: string;
        insight: string;
        confidence: number;
        evidence: string[];
    }>>;
    private generateInsightForType;
    private generateContentInsight;
    private generateStructureInsight;
    private generateConversationInsight;
    private calculateReflectionScore;
    private getDepthScore;
    private extractText;
    reflectOnPatterns(items: MemoryItem<unknown>[]): Promise<Array<{
        pattern: string;
        description: string;
        frequency: number;
        significance: number;
        examples: MemoryItem<unknown>[];
    }>>;
    trackMisunderstandings(item: MemoryItem<unknown>, context: MemoryItem<unknown>[]): Promise<Array<{
        type: 'contradiction' | 'ambiguity' | 'gap';
        description: string;
        severity: number;
        suggestedResolution: string;
    }>>;
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
    getMetrics(): ProcessorMetrics;
    getReflectionStats(): {
        totalItemsReflected: number;
        insightsGenerated: number;
        patternsIdentified: number;
        misunderstandingsTracked: number;
        averageReflectionDepth: number;
    };
}
