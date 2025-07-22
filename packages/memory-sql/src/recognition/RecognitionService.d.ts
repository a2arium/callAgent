import { PrismaClient } from '@prisma/client';
import { EntityAlignmentService } from '../EntityAlignmentService.js';
type RecognitionOptions = {
    threshold?: number;
    llmLowerBound?: number;
    llmUpperBound?: number;
    entities?: Record<string, string>;
    tags?: string[];
    customPrompt?: string;
    limit?: number;
};
type RecognitionResult<T> = {
    isMatch: boolean;
    confidence: number;
    matchingKey?: string;
    matchingData?: T;
    usedLLM: boolean;
    explanation?: string;
};
/**
 * Service that implements the recognize() functionality for semantic memory
 */
export declare class RecognitionService {
    private prisma;
    private entityAlignmentService;
    private confidenceScorer;
    private llmDisambiguator;
    private entityFinder;
    constructor(prisma: PrismaClient, entityAlignmentService: EntityAlignmentService);
    /**
     * Recognize if a candidate object exists in memory using entity alignment and LLM disambiguation
     */
    recognize<T>(candidateData: T, taskContext: any, // TaskContext from @a2arium/core
    options?: RecognitionOptions): Promise<RecognitionResult<T>>;
    /**
     * Find potential matches using entity alignment and tag filtering
     */
    private findPotentialMatches;
    /**
     * Find matches based on entity alignment using the shared EntityFinder service
     */
    private findMatchesByEntities;
    /**
     * NEW: Find matches for array patterns using cross-product comparison
     */
    private findMatchesByArrayPattern;
    /**
     * NEW: Extract all values from array using pattern
     */
    private extractAllArrayValues;
    /**
     * NEW: Find alignments by pattern
     */
    private findAlignmentsByPattern;
    /**
     * Find matches based on tags
     */
    private findMatchesByTags;
    /**
     * Find matches using broad similarity search
     */
    private findMatchesBySimilarity;
    /**
     * Score all potential matches using the ConfidenceScorer
     */
    private scorePotentialMatches;
    /**
     * Get the agent's goal from the task context
     */
    private getAgentGoal;
    /**
     * Get nested value from object using dot notation path
     */
    private getNestedValue;
}
export {};
