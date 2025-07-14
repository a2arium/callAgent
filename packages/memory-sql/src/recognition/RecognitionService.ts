import { PrismaClient } from '@prisma/client';
import { EntityAlignmentService } from '../EntityAlignmentService.js';
import { ConfidenceScorer } from './ConfidenceScorer.js';
import { LLMDisambiguator } from './LLMDisambiguator.js';
// Import types from the types package - these were defined in IMemory.ts
import type { MemoryQueryResult } from '@callagent/types';

// Define recognition types locally for now
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
export class RecognitionService {
    private confidenceScorer: ConfidenceScorer;
    private llmDisambiguator: LLMDisambiguator;

    constructor(
        private prisma: PrismaClient,
        private entityAlignmentService: EntityAlignmentService
    ) {
        this.confidenceScorer = new ConfidenceScorer(entityAlignmentService);
        this.llmDisambiguator = new LLMDisambiguator();
    }

    /**
     * Recognize if a candidate object exists in memory using entity alignment and LLM disambiguation
     */
    async recognize<T>(
        candidateData: T,
        taskContext: any, // TaskContext from @callagent/core
        options: RecognitionOptions = {}
    ): Promise<RecognitionResult<T>> {
        const {
            threshold = 0.75,
            llmLowerBound,
            llmUpperBound,
            entities = {},
            tags = [],
            customPrompt,
            limit = 50
        } = options;

        // Auto-calculate LLM bounds if not provided (around threshold)
        const lowerBound = llmLowerBound ?? Math.max(0, threshold - 0.11);
        const upperBound = llmUpperBound ?? Math.min(1, threshold + 0.11);

        // Get tenant ID from task context
        const tenantId = taskContext.tenantId || 'default';

        // Step 1: Find potential matches using entity alignment and tags
        const potentialMatches = await this.findPotentialMatches(
            candidateData,
            entities,
            tags,
            limit,
            tenantId
        );

        if (potentialMatches.length === 0) {
            return {
                isMatch: false,
                confidence: 0,
                usedLLM: false
            };
        }

        // Step 2: Score all potential matches
        const scoredMatches = await this.scorePotentialMatches(
            candidateData,
            potentialMatches,
            entities
        );

        // Sort by confidence (highest first)
        scoredMatches.sort((a, b) => b.confidence - a.confidence);

        const bestMatch = scoredMatches[0];

        // Step 3: Apply thresholds and LLM disambiguation
        // Three-zone logic: >= upperBound → direct match, < lowerBound → direct reject, between → use LLM
        if (bestMatch.confidence >= upperBound) {
            // Very high confidence - direct match
            return {
                isMatch: true,
                confidence: bestMatch.confidence,
                matchingKey: bestMatch.key,
                matchingData: bestMatch.data,
                usedLLM: false
            };
        } else if (bestMatch.confidence < lowerBound) {
            // Very low confidence - not a match
            return {
                isMatch: false,
                confidence: bestMatch.confidence,
                usedLLM: false
            };
        } else {
            // Medium confidence - use LLM disambiguation
            const agentGoal = await this.getAgentGoal(taskContext);

            const llmResult = await this.llmDisambiguator.disambiguateMatch(
                candidateData,
                bestMatch.data,
                bestMatch.confidence,
                taskContext,
                {
                    customPrompt,
                    agentGoal
                }
            );

            return {
                isMatch: llmResult.isMatch,
                confidence: llmResult.adjustedConfidence,
                matchingKey: llmResult.isMatch ? bestMatch.key : undefined,
                matchingData: llmResult.isMatch ? bestMatch.data : undefined,
                usedLLM: true,
                explanation: llmResult.explanation
            };
        }
    }

    /**
     * Find potential matches using entity alignment and tag filtering
     */
    private async findPotentialMatches<T>(
        candidateData: T,
        entities: Record<string, string>,
        tags: string[],
        limit: number,
        tenantId: string
    ): Promise<Array<{ key: string; data: T }>> {
        const matches: Array<{ key: string; data: T }> = [];

        // Strategy 1: Entity-based search if entities are provided
        if (Object.keys(entities).length > 0) {
            const entityMatches = await this.findMatchesByEntities<T>(
                candidateData,
                entities,
                tenantId,
                limit
            );
            matches.push(...entityMatches);
        }

        // Strategy 2: Tag-based search if tags are provided
        if (tags.length > 0) {
            const tagMatches = await this.findMatchesByTags<T>(
                tags,
                tenantId,
                limit
            );
            matches.push(...tagMatches);
        }

        // Strategy 3: If no entities or tags, do broad similarity search
        if (Object.keys(entities).length === 0 && tags.length === 0) {
            const broadMatches = await this.findMatchesBySimilarity<T>(
                candidateData,
                tenantId,
                limit
            );
            matches.push(...broadMatches);
        }

        // Remove duplicates by key
        const uniqueMatches = new Map<string, { key: string; data: T }>();
        for (const match of matches) {
            if (!uniqueMatches.has(match.key)) {
                uniqueMatches.set(match.key, match);
            }
        }

        return Array.from(uniqueMatches.values()).slice(0, limit);
    }

    /**
     * Find matches based on entity alignment
     */
    private async findMatchesByEntities<T>(
        candidateData: T,
        entities: Record<string, string>,
        tenantId: string,
        limit: number
    ): Promise<Array<{ key: string; data: T }>> {
        const matches: Array<{ key: string; data: T }> = [];
        const candidateObj = candidateData as any;

        // For each entity field, find aligned entities
        for (const [fieldPath, entityType] of Object.entries(entities)) {
            if (fieldPath.includes('[]')) {
                // NEW: Handle array patterns with cross-product comparison
                const arrayMatches = await this.findMatchesByArrayPattern<T>(
                    candidateObj,
                    fieldPath,
                    entityType,
                    tenantId,
                    limit
                );
                matches.push(...arrayMatches);
            } else {
                // Original logic for non-array fields
                const fieldValue = this.getNestedValue(candidateObj, fieldPath);
                if (!fieldValue) continue;

                // Debug: First check if we have any entity alignments at all
                console.log('DEBUG: Checking entity alignments...');
                const allAlignments = await this.prisma.entityAlignment.findMany({
                    where: { tenantId },
                    take: 5,
                    include: {
                        entity: true
                    }
                });
                console.log('DEBUG: Found alignments:', allAlignments?.length || 0);

                // Debug: Check if we have any entities of this type
                const entitiesOfType = await this.prisma.entityStore.findMany({
                    where: {
                        tenantId,
                        entityType
                    },
                    take: 5
                });
                console.log(`DEBUG: Found entities of type '${entityType}':`, entitiesOfType.length);

                // Use Prisma ORM approach instead of raw SQL for now
                const alignments = await this.prisma.entityAlignment.findMany({
                    where: {
                        tenantId,
                        entity: {
                            entityType,
                            OR: [
                                { canonicalName: { equals: fieldValue, mode: 'insensitive' } },
                                { aliases: { has: fieldValue } }
                            ]
                        }
                    },
                    include: {
                        entity: true
                    },
                    take: limit
                });

                console.log(`DEBUG: Found ${alignments?.length || 0} alignments for field '${fieldPath}' = '${fieldValue}'`);

                // Get memory entries for these alignments
                for (const alignment of alignments || []) {
                    try {
                        const memoryEntry = await this.prisma.agentMemoryStore.findUnique({
                            where: {
                                tenantId_key: {
                                    tenantId,
                                    key: alignment.memoryKey
                                }
                            }
                        });

                        if (memoryEntry) {
                            const data = typeof memoryEntry.value === 'string' ?
                                JSON.parse(memoryEntry.value) : memoryEntry.value;
                            matches.push({
                                key: memoryEntry.key,
                                data: data as T
                            });
                        }
                    } catch (error) {
                        console.warn(`Failed to parse memory data for key ${alignment.memoryKey}:`, error);
                    }
                }
            }
        }

        return matches;
    }

    /**
     * NEW: Find matches for array patterns using cross-product comparison
     */
    private async findMatchesByArrayPattern<T>(
        candidateData: any,
        fieldPattern: string, // "titleAndDescription[].title"
        entityType: string,
        tenantId: string,
        limit: number
    ): Promise<Array<{ key: string; data: T }>> {
        const matches: Array<{ key: string; data: T }> = [];

        // Extract all values from candidate array
        const candidateValues = this.extractAllArrayValues(candidateData, fieldPattern);
        if (candidateValues.length === 0) return matches;

        // Find all alignments matching the pattern
        const alignments = await this.findAlignmentsByPattern(fieldPattern, entityType, tenantId);

        // Cross-product comparison
        for (const candidateValue of candidateValues) {
            for (const alignment of alignments) {
                try {
                    const similarity = await this.calculateEntitySimilarity(
                        candidateValue,
                        alignment.entity.canonicalName,
                        entityType
                    );

                    if (similarity > 0.6) { // threshold for recognition
                        const memoryEntry = await this.prisma.agentMemoryStore.findUnique({
                            where: {
                                tenantId_key: {
                                    tenantId,
                                    key: alignment.memoryKey
                                }
                            }
                        });

                        if (memoryEntry) {
                            const data = typeof memoryEntry.value === 'string' ?
                                JSON.parse(memoryEntry.value) : memoryEntry.value;
                            matches.push({
                                key: memoryEntry.key,
                                data: data as T
                            });
                        }
                    }
                } catch (error) {
                    console.warn(`Failed to calculate similarity for ${candidateValue}:`, error);
                }
            }
        }

        return matches.slice(0, limit);
    }

    /**
     * NEW: Extract all values from array using pattern
     */
    private extractAllArrayValues(obj: any, fieldPattern: string): string[] {
        const values: string[] = [];

        // Parse the pattern: "titleAndDescription[].title"
        const arrayMatch = fieldPattern.match(/^(.+?)\[\](.*)$/);
        if (!arrayMatch) return values;

        const [, arrayPath, remainingPath] = arrayMatch;
        const arrayValue = this.getNestedValue(obj, arrayPath);

        if (Array.isArray(arrayValue)) {
            for (const item of arrayValue) {
                const value = remainingPath ? this.getNestedValue(item, remainingPath.substring(1)) : item;
                if (value && typeof value === 'string') {
                    values.push(value);
                }
            }
        }

        return values;
    }

    /**
     * NEW: Find alignments by pattern
     */
    private async findAlignmentsByPattern(
        fieldPattern: string,
        entityType: string,
        tenantId: string
    ): Promise<Array<{ memoryKey: string; entity: { canonicalName: string; aliases: string[] } }>> {
        // Convert pattern to SQL LIKE pattern
        const sqlPattern = fieldPattern.replace('[]', '[%]');

        const alignments = await this.prisma.$queryRaw<Array<{
            memory_key: string;
            canonical_name: string;
            aliases: string[];
        }>>`
            SELECT DISTINCT ea.memory_key, es.canonical_name, es.aliases
            FROM entity_alignment ea
            JOIN entity_store es ON ea.entity_id = es.id
            WHERE ea.tenant_id = ${tenantId}
            AND es.entity_type = ${entityType}
            AND ea.field_path LIKE ${sqlPattern.replace('%', '%')}
        `;

        return alignments.map(a => ({
            memoryKey: a.memory_key,
            entity: {
                canonicalName: a.canonical_name,
                aliases: a.aliases
            }
        }));
    }

    /**
     * NEW: Calculate entity similarity for recognition
     */
    private async calculateEntitySimilarity(
        value1: string,
        value2: string,
        entityType: string
    ): Promise<number> {
        // Simple text similarity for now
        const normalized1 = value1.toLowerCase().trim();
        const normalized2 = value2.toLowerCase().trim();

        if (normalized1 === normalized2) return 1.0;

        // Check if one contains the other
        if (normalized1.includes(normalized2) || normalized2.includes(normalized1)) {
            return 0.8;
        }

        // Calculate word overlap
        const words1 = normalized1.split(/\s+/);
        const words2 = normalized2.split(/\s+/);
        const intersection = words1.filter(w => words2.includes(w));
        const union = [...new Set([...words1, ...words2])];

        return intersection.length / union.length;
    }

    /**
     * Find matches based on tags
     */
    private async findMatchesByTags<T>(
        tags: string[],
        tenantId: string,
        limit: number
    ): Promise<Array<{ key: string; data: T }>> {
        const matches: Array<{ key: string; data: T }> = [];

        for (const tag of tags) {
            // Use Prisma ORM instead of raw SQL
            const results = await this.prisma.agentMemoryStore.findMany({
                where: {
                    tenantId,
                    tags: {
                        has: tag
                    }
                },
                take: limit
            });

            for (const result of results) {
                try {
                    const data = typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
                    matches.push({
                        key: result.key,
                        data: data as T
                    });
                } catch (error) {
                    console.warn(`Failed to parse memory data for key ${result.key}:`, error);
                }
            }
        }

        return matches;
    }

    /**
     * Find matches using broad similarity search
     */
    private async findMatchesBySimilarity<T>(
        candidateData: T,
        tenantId: string,
        limit: number
    ): Promise<Array<{ key: string; data: T }>> {
        // Use Prisma ORM instead of raw SQL - fall back to recent entries
        const results = await this.prisma.agentMemoryStore.findMany({
            where: {
                tenantId
            },
            orderBy: {
                createdAt: 'desc'
            },
            take: limit
        });

        const matches: Array<{ key: string; data: T }> = [];
        for (const result of results) {
            try {
                const data = typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
                matches.push({
                    key: result.key,
                    data: data as T
                });
            } catch (error) {
                console.warn(`Failed to parse memory data for key ${result.key}:`, error);
            }
        }

        return matches;
    }

    /**
     * Score all potential matches using the ConfidenceScorer
     */
    private async scorePotentialMatches<T>(
        candidateData: T,
        potentialMatches: Array<{ key: string; data: T }>,
        entities: Record<string, string>
    ): Promise<Array<{ key: string; data: T; confidence: number }>> {
        const scoredMatches = [];

        for (const match of potentialMatches) {
            const confidence = await this.confidenceScorer.calculateConfidence(
                candidateData,
                match.data,
                entities
            );

            scoredMatches.push({
                ...match,
                confidence
            });
        }

        return scoredMatches;
    }

    /**
     * Get the agent's goal from the task context
     */
    private async getAgentGoal(taskContext: any): Promise<string | undefined> {
        try {
            // Try to get goal from working memory if available
            if (taskContext.memory?.working?.get) {
                const goal = await taskContext.memory.working.get('goal');
                return goal ? String(goal) : undefined;
            }
        } catch (error) {
            // Ignore errors, goal is optional
        }
        return undefined;
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

            // For arrays without index, try to get first element's property
            if (Array.isArray(current) && current.length > 0) {
                return current[0][key];
            }

            return current[key];
        }, obj);
    }
} 