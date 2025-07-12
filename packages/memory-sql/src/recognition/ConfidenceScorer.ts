import { EntityAlignmentService } from '../EntityAlignmentService.js';

/**
 * Scores the confidence level between a candidate object and existing memory entries
 * Uses entity alignment, field matching, and structural similarity
 */
export class ConfidenceScorer {
    constructor(
        private entityAlignmentService: EntityAlignmentService
    ) { }

    /**
     * Calculate confidence score between candidate data and an existing memory entry
     * @param candidateData The new data being compared
     * @param existingData The existing memory data
     * @param entityMappings Field -> entity type mappings for alignment
     * @returns Confidence score between 0 and 1
     */
    async calculateConfidence<T>(
        candidateData: T,
        existingData: T,
        entityMappings?: Record<string, string>
    ): Promise<number> {
        let totalScore = 0;
        let weights = 0;

        // 1. Entity Alignment Score (highest weight)
        if (entityMappings) {
            const entityScore = await this.calculateEntityAlignmentScore(
                candidateData,
                existingData,
                entityMappings
            );
            if (entityScore !== null) {
                totalScore += entityScore * 0.6; // 60% weight for entity alignment
                weights += 0.6;
            }
        }

        // 2. Exact Field Matches (medium weight)
        const exactMatchScore = this.calculateExactFieldMatches(candidateData, existingData);
        totalScore += exactMatchScore * 0.25; // 25% weight for exact matches
        weights += 0.25;

        // 3. Structural Similarity (lower weight)
        const structuralScore = this.calculateStructuralSimilarity(candidateData, existingData);
        totalScore += structuralScore * 0.15; // 15% weight for structural similarity
        weights += 0.15;

        // Normalize by total weights
        return weights > 0 ? totalScore / weights : 0;
    }

    /**
     * Calculate confidence based on entity alignment between objects
     */
    private async calculateEntityAlignmentScore<T>(
        candidateData: T,
        existingData: T,
        entityMappings: Record<string, string>
    ): Promise<number | null> {
        const candidateObj = candidateData as any;
        const existingObj = existingData as any;

        let totalEntityScore = 0;
        let entityCount = 0;

        for (const [fieldPath, entityType] of Object.entries(entityMappings)) {
            const candidateValue = this.getNestedValue(candidateObj, fieldPath);
            const existingValue = this.getNestedValue(existingObj, fieldPath);

            if (candidateValue && existingValue) {
                // Calculate similarity score for these entity values
                const similarity = await this.calculateEntityValueSimilarity(
                    candidateValue,
                    existingValue,
                    entityType
                );

                if (similarity !== null) {
                    totalEntityScore += similarity;
                    entityCount++;
                }
            }
        }

        return entityCount > 0 ? totalEntityScore / entityCount : null;
    }

    /**
     * Calculate score based on exact field matches
     */
    private calculateExactFieldMatches<T>(candidateData: T, existingData: T): number {
        const candidateObj = candidateData as any;
        const existingObj = existingData as any;

        const candidateFields = this.getAllFieldPaths(candidateObj);
        const existingFields = this.getAllFieldPaths(existingObj);

        // Find common fields
        const commonFields = candidateFields.filter(field => existingFields.includes(field));

        if (commonFields.length === 0) return 0;

        let matches = 0;
        for (const field of commonFields) {
            const candidateValue = this.getNestedValue(candidateObj, field);
            const existingValue = this.getNestedValue(existingObj, field);

            if (this.valuesAreEqual(candidateValue, existingValue)) {
                matches++;
            }
        }

        return matches / commonFields.length;
    }

    /**
     * Calculate structural similarity (field presence, data types, etc.)
     */
    private calculateStructuralSimilarity<T>(candidateData: T, existingData: T): number {
        const candidateObj = candidateData as any;
        const existingObj = existingData as any;

        const candidateFields = this.getAllFieldPaths(candidateObj);
        const existingFields = this.getAllFieldPaths(existingObj);

        // Jaccard similarity: intersection / union
        const intersection = candidateFields.filter(field => existingFields.includes(field));
        const union = [...new Set([...candidateFields, ...existingFields])];

        return union.length > 0 ? intersection.length / union.length : 0;
    }

    /**
     * Get nested value from object using dot notation path
     */
    private getNestedValue(obj: any, path: string): any {
        return path.split('.').reduce((current, key) => {
            if (current === null || current === undefined) return undefined;

            // Handle array access
            if (Array.isArray(current) && !isNaN(Number(key))) {
                return current[Number(key)];
            }

            // For arrays without index, try to get first element
            if (Array.isArray(current) && current.length > 0) {
                return current[0][key];
            }

            return current[key];
        }, obj);
    }

    /**
     * Get all field paths in an object (flattened dot notation)
     */
    private getAllFieldPaths(obj: any, prefix = ''): string[] {
        const paths: string[] = [];

        if (obj === null || typeof obj !== 'object') {
            return [];
        }

        if (Array.isArray(obj)) {
            // For arrays, include paths from first element
            if (obj.length > 0) {
                const firstElementPaths = this.getAllFieldPaths(obj[0], prefix);
                paths.push(...firstElementPaths);
            }
        } else {
            for (const [key, value] of Object.entries(obj)) {
                const currentPath = prefix ? `${prefix}.${key}` : key;
                paths.push(currentPath);

                if (value && typeof value === 'object') {
                    const nestedPaths = this.getAllFieldPaths(value, currentPath);
                    paths.push(...nestedPaths);
                }
            }
        }

        return paths;
    }

    /**
     * Check if two values are equal (handles basic types and arrays)
     */
    private valuesAreEqual(value1: any, value2: any): boolean {
        if (value1 === value2) return true;

        // Handle arrays
        if (Array.isArray(value1) && Array.isArray(value2)) {
            if (value1.length !== value2.length) return false;
            return value1.every((item, index) => this.valuesAreEqual(item, value2[index]));
        }

        // Handle objects
        if (value1 && value2 && typeof value1 === 'object' && typeof value2 === 'object') {
            const keys1 = Object.keys(value1);
            const keys2 = Object.keys(value2);

            if (keys1.length !== keys2.length) return false;

            return keys1.every(key =>
                keys2.includes(key) && this.valuesAreEqual(value1[key], value2[key])
            );
        }

        return false;
    }

    /**
     * Calculate similarity between two entity values using generic logic only
     */
    private async calculateEntityValueSimilarity(
        value1: string,
        value2: string,
        entityType: string
    ): Promise<number | null> {
        // Direct string comparison (case-insensitive)
        if (value1.toLowerCase() === value2.toLowerCase()) {
            return 1.0;
        }

        // Use only generic similarity for all entity types
        return this.calculateGenericStringSimilarity(value1, value2);
    }

    /**
     * Generic string similarity using multiple strategies
     */
    private calculateGenericStringSimilarity(str1: string, str2: string): number {
        const normalize = (text: string) =>
            text.toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
                .replace(/[^\w\s]/g, ' ') // Replace punctuation with spaces
                .replace(/\s+/g, ' ') // Normalize whitespace
                .trim();

        const norm1 = normalize(str1);
        const norm2 = normalize(str2);

        if (norm1 === norm2) return 0.95;

        // Strategy 1: Substring containment
        if (norm1.includes(norm2) || norm2.includes(norm1)) {
            const shorter = norm1.length < norm2.length ? norm1 : norm2;
            const longer = norm1.length < norm2.length ? norm2 : norm1;
            return (shorter.length / longer.length) * 0.8;
        }

        // Strategy 2: Word-level Jaccard similarity
        const words1 = new Set(norm1.split(' ').filter(w => w.length > 0));
        const words2 = new Set(norm2.split(' ').filter(w => w.length > 0));

        if (words1.size === 0 || words2.size === 0) return 0;

        const intersection = new Set([...words1].filter(x => words2.has(x)));
        const union = new Set([...words1, ...words2]);

        const jaccardSimilarity = intersection.size / union.size;

        // Strategy 3: Partial word matching (for cases where words might be substrings)
        let partialMatches = 0;
        const maxWords = Math.max(words1.size, words2.size);

        for (const word1 of words1) {
            for (const word2 of words2) {
                if (word1.includes(word2) || word2.includes(word1)) {
                    partialMatches++;
                    break;
                }
            }
        }

        const partialSimilarity = partialMatches / maxWords;

        // Return the best similarity score from all strategies
        return Math.max(jaccardSimilarity, partialSimilarity * 0.7);
    }
} 