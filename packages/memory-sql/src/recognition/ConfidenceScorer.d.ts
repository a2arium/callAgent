import { EntityAlignmentService } from '../EntityAlignmentService.js';
/**
 * Scores the confidence level between a candidate object and existing memory entries
 * Uses entity alignment, field matching, and structural similarity
 */
export declare class ConfidenceScorer {
    private entityAlignmentService;
    constructor(entityAlignmentService: EntityAlignmentService);
    /**
     * Calculate confidence score between candidate data and an existing memory entry
     * @param candidateData The new data being compared
     * @param existingData The existing memory data
     * @param entityMappings Field -> entity type mappings for alignment
     * @returns Confidence score between 0 and 1
     */
    calculateConfidence<T>(candidateData: T, existingData: T, entityMappings?: Record<string, string>): Promise<number>;
    /**
     * Calculate confidence based on entity alignment between objects
     */
    private calculateEntityAlignmentScore;
    /**
     * Calculate score based on exact field matches
     */
    private calculateExactFieldMatches;
    /**
     * Calculate structural similarity (field presence, data types, etc.)
     */
    private calculateStructuralSimilarity;
    /**
     * Get nested value from object using dot notation path
     */
    private getNestedValue;
    /**
     * Get all field paths in an object (flattened dot notation)
     */
    private getAllFieldPaths;
    /**
     * Check if two values are equal (handles basic types and arrays)
     */
    private valuesAreEqual;
    /**
     * Calculate similarity between two entity values using generic logic only
     */
    private calculateEntityValueSimilarity;
    /**
     * Generic string similarity using multiple strategies
     */
    private calculateGenericStringSimilarity;
}
