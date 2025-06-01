import { ISelectiveAttention } from '../../interfaces/ISelectiveAttention.js';
import { MemoryItem } from '../../../../../../shared/types/memoryLifecycle.js';
import { ProcessorMetrics } from '../../../interfaces/IStageProcessor.js';
import { logger } from '@callagent/utils';

export class ConversationAttention implements ISelectiveAttention {
    readonly stageName = 'encoding' as const;
    readonly componentName = 'attention' as const;
    readonly stageNumber = 2;

    private logger = logger.createLogger({ prefix: 'ConversationAttention' });
    private metrics: ProcessorMetrics = {
        itemsProcessed: 0,
        itemsDropped: 0,
        processingTimeMs: 0,
    };

    private attentionStats = {
        totalItemsProcessed: 0,
        averageAttentionScore: 0,
        topFocusAreas: [] as Array<{
            area: string;
            frequency: number;
            averageScore: number;
        }>,
    };

    private passThrough: boolean;
    private preserveOrder: boolean;
    private conversationAware: boolean;
    private speakerTracking: boolean;
    private turnBoundaries: boolean;
    private llmProvider: string;
    private scoringCriteria: string[];
    private attentionWindowSize: number;

    // Focus area tracking
    private focusAreaStats = new Map<string, { count: number; totalScore: number }>();

    constructor(config?: {
        passThrough?: boolean;
        preserveOrder?: boolean;
        conversationAware?: boolean;
        speakerTracking?: boolean;
        turnBoundaries?: boolean;
        llmProvider?: string;
        scoringCriteria?: string[];
        attentionWindowSize?: number;
    }) {
        this.passThrough = config?.passThrough ?? false;
        this.preserveOrder = config?.preserveOrder ?? true;
        this.conversationAware = config?.conversationAware ?? true;
        this.speakerTracking = config?.speakerTracking ?? true;
        this.turnBoundaries = config?.turnBoundaries ?? true;
        this.llmProvider = config?.llmProvider || 'placeholder';
        this.scoringCriteria = config?.scoringCriteria || ['relevance', 'novelty', 'importance'];
        this.attentionWindowSize = config?.attentionWindowSize || 512;
    }

    /**
     * PHASE 1: Rule-based attention scoring
     * FUTURE: LLM-based attention mechanisms
     * 
     * @see https://arxiv.org/abs/1706.03762 - Attention Is All You Need
     * @see https://platform.openai.com/docs/guides/prompt-engineering - Prompt engineering for attention
     * 
     * ENHANCEMENT: Multi-Head Attention
     * Consider implementing multi-head attention patterns:
     * - Content attention: focus on semantic content
     * - Speaker attention: focus on speaker changes
     * - Temporal attention: focus on time-sensitive information
     * - Emotional attention: focus on emotional content
     */
    async process(item: MemoryItem<unknown>): Promise<MemoryItem<unknown>> {
        const startTime = Date.now();
        this.metrics.itemsProcessed++;
        this.attentionStats.totalItemsProcessed++;

        try {
            if (this.passThrough) {
                return item;
            }

            // Add processing history
            if (!item.metadata.processingHistory) {
                item.metadata.processingHistory = [];
            }
            item.metadata.processingHistory.push(`${this.stageName}:${this.componentName}`);

            // Compute attention scores
            const attentionScores = await this.computeAttentionScores(
                this.extractText(item.data),
                []
            );

            // Calculate overall attention score
            const overallScore = attentionScores.length > 0
                ? attentionScores.reduce((sum, score) => sum + score.score, 0) / attentionScores.length
                : 0.5;

            // Update statistics
            this.updateAttentionStats(overallScore, attentionScores);

            // Create enhanced item with attention metadata
            const enhancedItem: MemoryItem<unknown> = {
                ...item,
                metadata: {
                    ...item.metadata,
                    attentionScore: overallScore,
                    attentionSegments: attentionScores,
                    attentionProcessedAt: new Date().toISOString(),
                }
            };

            this.metrics.processingTimeMs += Date.now() - startTime;
            this.metrics.lastProcessedAt = new Date().toISOString();

            this.logger.debug('Attention processing completed', {
                itemId: item.id,
                overallScore,
                segmentCount: attentionScores.length
            });

            return enhancedItem;
        } catch (error) {
            this.logger.error('Error in attention processing', {
                itemId: item.id,
                error: error instanceof Error ? error.message : 'Unknown error'
            });

            this.metrics.processingTimeMs += Date.now() - startTime;
            return item;
        }
    }

    async computeAttentionScores(
        content: string,
        context?: MemoryItem<unknown>[]
    ): Promise<Array<{
        segment: string;
        score: number;
        reasoning: string;
    }>> {
        if (!content) {
            return [];
        }

        // Split content into segments
        const segments = this.segmentContent(content);
        const scores: Array<{ segment: string; score: number; reasoning: string }> = [];

        for (const segment of segments) {
            const score = this.calculateSegmentScore(segment, context);
            const reasoning = this.generateReasoning(segment, score);

            scores.push({
                segment,
                score,
                reasoning
            });
        }

        return scores;
    }

    private segmentContent(content: string): string[] {
        // Phase 1: Simple sentence-based segmentation
        if (this.conversationAware && this.turnBoundaries) {
            return this.segmentConversation(content);
        }

        // Split by sentences
        const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 0);

        // Group sentences into attention windows
        const segments: string[] = [];
        let currentSegment = '';

        for (const sentence of sentences) {
            if (currentSegment.length + sentence.length > this.attentionWindowSize) {
                if (currentSegment) {
                    segments.push(currentSegment.trim());
                }
                currentSegment = sentence;
            } else {
                currentSegment += (currentSegment ? '. ' : '') + sentence;
            }
        }

        if (currentSegment) {
            segments.push(currentSegment.trim());
        }

        return segments;
    }

    private segmentConversation(content: string): string[] {
        // Conversation-aware segmentation
        const lines = content.split('\n');
        const segments: string[] = [];
        let currentTurn = '';
        let currentSpeaker = '';

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;

            // Detect speaker changes
            const speakerMatch = trimmedLine.match(/^([^:]+):\s*(.*)$/);
            if (speakerMatch && this.speakerTracking) {
                const [, speaker, message] = speakerMatch;

                if (currentSpeaker && currentSpeaker !== speaker && currentTurn) {
                    segments.push(currentTurn.trim());
                    currentTurn = '';
                }

                currentSpeaker = speaker;
                currentTurn += (currentTurn ? '\n' : '') + trimmedLine;
            } else {
                currentTurn += (currentTurn ? '\n' : '') + trimmedLine;
            }

            // Check segment size
            if (currentTurn.length > this.attentionWindowSize) {
                segments.push(currentTurn.trim());
                currentTurn = '';
                currentSpeaker = '';
            }
        }

        if (currentTurn) {
            segments.push(currentTurn.trim());
        }

        return segments;
    }

    private calculateSegmentScore(segment: string, context?: MemoryItem<unknown>[]): number {
        let score = 0.5; // Base score

        // Apply scoring criteria
        for (const criterion of this.scoringCriteria) {
            switch (criterion) {
                case 'relevance':
                    score += this.scoreRelevance(segment) * 0.3;
                    break;
                case 'novelty':
                    score += this.scoreNovelty(segment, context) * 0.3;
                    break;
                case 'importance':
                    score += this.scoreImportance(segment) * 0.4;
                    break;
            }
        }

        // Conversation-specific scoring
        if (this.conversationAware) {
            score += this.scoreConversationalImportance(segment) * 0.2;
        }

        return Math.min(Math.max(score, 0), 1);
    }

    private scoreRelevance(segment: string): number {
        // Phase 1: Keyword-based relevance
        const importantKeywords = [
            'important', 'critical', 'urgent', 'key', 'main', 'primary',
            'question', 'answer', 'problem', 'solution', 'decision'
        ];

        const words = segment.toLowerCase().split(/\s+/);
        const keywordCount = words.filter(word =>
            importantKeywords.some(keyword => word.includes(keyword))
        ).length;

        return Math.min(keywordCount / words.length * 10, 0.5);
    }

    private scoreNovelty(segment: string, context?: MemoryItem<unknown>[]): number {
        // Phase 1: Simple novelty based on uniqueness
        if (!context || context.length === 0) {
            return 0.3; // Default novelty
        }

        // Check similarity with context
        const segmentWords = new Set(segment.toLowerCase().split(/\s+/));
        let maxSimilarity = 0;

        for (const contextItem of context) {
            const contextText = this.extractText(contextItem.data);
            const contextWords = new Set(contextText.toLowerCase().split(/\s+/));

            const intersection = new Set([...segmentWords].filter(word => contextWords.has(word)));
            const union = new Set([...segmentWords, ...contextWords]);
            const similarity = intersection.size / union.size;

            maxSimilarity = Math.max(maxSimilarity, similarity);
        }

        return 1 - maxSimilarity; // Higher novelty for lower similarity
    }

    private scoreImportance(segment: string): number {
        // Phase 1: Length and structure-based importance
        let importance = 0;

        // Longer segments might be more important
        importance += Math.min(segment.length / 200, 0.3);

        // Questions are important
        if (segment.includes('?')) {
            importance += 0.2;
        }

        // Exclamations might indicate importance
        if (segment.includes('!')) {
            importance += 0.1;
        }

        // Capitalized words might indicate importance
        const capitalizedWords = segment.match(/\b[A-Z][a-z]+/g) || [];
        importance += Math.min(capitalizedWords.length / 10, 0.2);

        return importance;
    }

    private scoreConversationalImportance(segment: string): number {
        let score = 0;

        // Speaker changes are important
        if (segment.includes(':')) {
            score += 0.3;
        }

        // Direct questions are important
        if (segment.match(/\b(what|how|why|when|where|who)\b/i)) {
            score += 0.2;
        }

        // Responses to questions are important
        if (segment.match(/\b(because|since|therefore|so|thus)\b/i)) {
            score += 0.1;
        }

        return score;
    }

    private generateReasoning(segment: string, score: number): string {
        const reasons: string[] = [];

        if (score > 0.8) {
            reasons.push('High attention score');
        } else if (score > 0.6) {
            reasons.push('Medium attention score');
        } else {
            reasons.push('Low attention score');
        }

        if (segment.includes('?')) {
            reasons.push('Contains question');
        }

        if (segment.includes(':')) {
            reasons.push('Speaker turn');
        }

        if (segment.length > 100) {
            reasons.push('Substantial content');
        }

        return reasons.join(', ');
    }

    private extractText(data: unknown): string {
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

            return JSON.stringify(data);
        }

        return String(data);
    }

    private updateAttentionStats(overallScore: number, segments: Array<{ segment: string; score: number; reasoning: string }>): void {
        // Update average attention score
        const totalProcessed = this.attentionStats.totalItemsProcessed;
        this.attentionStats.averageAttentionScore =
            (this.attentionStats.averageAttentionScore * (totalProcessed - 1) + overallScore) / totalProcessed;

        // Update focus area statistics
        for (const segment of segments) {
            const focusAreas = this.extractFocusAreas(segment.reasoning);

            for (const area of focusAreas) {
                const existing = this.focusAreaStats.get(area) || { count: 0, totalScore: 0 };
                existing.count++;
                existing.totalScore += segment.score;
                this.focusAreaStats.set(area, existing);
            }
        }

        // Update top focus areas
        this.attentionStats.topFocusAreas = Array.from(this.focusAreaStats.entries())
            .map(([area, stats]) => ({
                area,
                frequency: stats.count,
                averageScore: stats.totalScore / stats.count
            }))
            .sort((a, b) => b.frequency - a.frequency)
            .slice(0, 10);
    }

    private extractFocusAreas(reasoning: string): string[] {
        const areas: string[] = [];

        if (reasoning.includes('question')) areas.push('questions');
        if (reasoning.includes('speaker')) areas.push('speaker_turns');
        if (reasoning.includes('content')) areas.push('substantial_content');
        if (reasoning.includes('High attention')) areas.push('high_attention');
        if (reasoning.includes('Medium attention')) areas.push('medium_attention');
        if (reasoning.includes('Low attention')) areas.push('low_attention');

        return areas;
    }

    async focusAttention(
        item: MemoryItem<unknown>,
        focusAreas: string[]
    ): Promise<MemoryItem<unknown>> {
        // Apply focused attention to specific areas
        const content = this.extractText(item.data);
        const segments = this.segmentContent(content);

        const focusedSegments = segments.map(segment => {
            let boostedScore = this.calculateSegmentScore(segment);

            // Boost scores for focus areas
            for (const area of focusAreas) {
                if (this.segmentMatchesFocusArea(segment, area)) {
                    boostedScore = Math.min(boostedScore + 0.2, 1.0);
                }
            }

            return {
                segment,
                score: boostedScore,
                reasoning: `Focused on: ${focusAreas.join(', ')}`
            };
        });

        return {
            ...item,
            metadata: {
                ...item.metadata,
                focusedAttention: true,
                focusAreas,
                attentionSegments: focusedSegments,
            }
        };
    }

    private segmentMatchesFocusArea(segment: string, focusArea: string): boolean {
        switch (focusArea.toLowerCase()) {
            case 'questions':
                return segment.includes('?');
            case 'speaker_turns':
                return segment.includes(':');
            case 'important':
                return /\b(important|critical|urgent|key)\b/i.test(segment);
            case 'decisions':
                return /\b(decide|decision|choose|select)\b/i.test(segment);
            default:
                return segment.toLowerCase().includes(focusArea.toLowerCase());
        }
    }

    configure(config: {
        passThrough?: boolean;
        preserveOrder?: boolean;
        conversationAware?: boolean;
        speakerTracking?: boolean;
        turnBoundaries?: boolean;
        llmProvider?: string;
        scoringCriteria?: string[];
        attentionWindowSize?: number;
        [key: string]: unknown;
    }): void {
        if (config.passThrough !== undefined) {
            this.passThrough = config.passThrough;
        }
        if (config.preserveOrder !== undefined) {
            this.preserveOrder = config.preserveOrder;
        }
        if (config.conversationAware !== undefined) {
            this.conversationAware = config.conversationAware;
        }
        if (config.speakerTracking !== undefined) {
            this.speakerTracking = config.speakerTracking;
        }
        if (config.turnBoundaries !== undefined) {
            this.turnBoundaries = config.turnBoundaries;
        }
        if (config.llmProvider !== undefined) {
            this.llmProvider = config.llmProvider;
        }
        if (config.scoringCriteria !== undefined) {
            this.scoringCriteria = config.scoringCriteria;
        }
        if (config.attentionWindowSize !== undefined) {
            this.attentionWindowSize = config.attentionWindowSize;
        }
    }

    getMetrics(): ProcessorMetrics {
        return { ...this.metrics };
    }

    getAttentionStats() {
        return { ...this.attentionStats };
    }
} 