import { PrismaClient } from '@prisma/client';
import { EntityAlignmentService } from '../EntityAlignmentService.js';
import { EntityFinder } from './EntityFinder.js';
import { ConfidenceScorer } from './ConfidenceScorer.js';
import { LLMDisambiguator } from './LLMDisambiguator.js';
// Import types from the types package - these were defined in IMemory.ts
import type { MemoryQueryResult } from '@a2arium/callagent-types';

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
    private entityFinder: EntityFinder;

    constructor(
        private prisma: PrismaClient,
        private entityAlignmentService: EntityAlignmentService
    ) {
        this.confidenceScorer = new ConfidenceScorer(entityAlignmentService);
        this.llmDisambiguator = new LLMDisambiguator();
        // Create EntityFinder instance with access to embedding function
        this.entityFinder = new EntityFinder(
            prisma,
            (entityAlignmentService as any).embedFunction
        );
    }

    /**
     * Recognize if a candidate object exists in memory using entity alignment and LLM disambiguation
     */
    async recognize<T>(
        candidateData: T,
        taskContext: any, // TaskContext from @a2arium/core
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
     * Find matches based on entity alignment using the shared EntityFinder service
     */
    private async findMatchesByEntities<T>(
        candidateData: T,
        entities: Record<string, string>,
        tenantId: string,
        limit: number
    ): Promise<Array<{ key: string; data: T }>> {
        const candidateObj = candidateData as any;
        const allMatchingMemoryKeys = new Set<string>();

        // For each entity field, find aligned entities using EntityFinder
        for (const [fieldPath, entityType] of Object.entries(entities)) {
            if (fieldPath.includes('[]')) {
                // Handle array patterns with cross-product comparison
                const arrayMatches = await this.findMatchesByArrayPattern<T>(
                    candidateObj,
                    fieldPath,
                    entityType,
                    tenantId,
                    limit
                );
                arrayMatches.forEach(match => allMatchingMemoryKeys.add(match.key));
            } else {
                // Handle single field values using EntityFinder
                const fieldValue = this.getNestedValue(candidateObj, fieldPath);
                if (!fieldValue) continue;

                // Debug: Keep existing debug logging for comparison
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

                // NEW: Use EntityFinder instead of limited Prisma query
                const matchingEntityIds = await this.entityFinder.findMatchingEntityIds(
                    fieldValue,
                    entityType,
                    tenantId
                );

                console.log(`DEBUG: Found ${matchingEntityIds.length} matching entities for field '${fieldPath}' = '${fieldValue}' using EntityFinder`);

                if (matchingEntityIds.length > 0) {
                    // Find all memory entries aligned with these entities
                    const alignments = await this.prisma.entityAlignment.findMany({
                        where: {
                            tenantId,
                            entityId: { in: matchingEntityIds }
                        },
                        select: { memoryKey: true },
                    });

                    alignments.forEach(alignment => allMatchingMemoryKeys.add(alignment.memoryKey));
                    console.log(`DEBUG: Found ${alignments.length} alignments for matching entities`);
                }
            }
        }

        if (allMatchingMemoryKeys.size === 0) {
            console.log('DEBUG: No matching memory keys found');
            return [];
        }

        // Load the memory entries for the unique keys
        const memoryEntries = await this.prisma.agentMemoryStore.findMany({
            where: {
                tenantId,
                key: { in: Array.from(allMatchingMemoryKeys) }
            },
            take: limit
        });

        console.log(`DEBUG: Loaded ${memoryEntries.length} memory entries from ${allMatchingMemoryKeys.size} unique keys`);

        return memoryEntries.map(entry => ({
            key: entry.key,
            data: (typeof entry.value === 'string' ? JSON.parse(entry.value) : entry.value) as T
        }));
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

        // Use EntityFinder for each candidate value
        const matchingMemoryKeys = new Set<string>();
        for (const candidateValue of candidateValues) {
            try {
                // Use EntityFinder to find matching entities for this candidate value
                const matchingEntityIds = await this.entityFinder.findMatchingEntityIds(
                    candidateValue,
                    entityType,
                    tenantId
                );

                if (matchingEntityIds.length > 0) {
                    // Find alignments for these entities that match the pattern
                    const sqlPattern = fieldPattern.replace('[]', '[%]');
                    const patternAlignments = await this.prisma.entityAlignment.findMany({
                        where: {
                            tenantId,
                            entityId: { in: matchingEntityIds },
                            fieldPath: { contains: sqlPattern.replace('%', '') } // Simple pattern match for now
                        },
                        select: { memoryKey: true }
                    });

                    patternAlignments.forEach(alignment => matchingMemoryKeys.add(alignment.memoryKey));
                }
            } catch (error) {
                console.warn(`Failed to find matches for array value ${candidateValue}:`, error);
            }
        }

        // Load memory entries for matching keys
        if (matchingMemoryKeys.size > 0) {
            const memoryEntries = await this.prisma.agentMemoryStore.findMany({
                where: {
                    tenantId,
                    key: { in: Array.from(matchingMemoryKeys) }
                },
                take: limit
            });

            matches.push(...memoryEntries.map(entry => ({
                key: entry.key,
                data: (typeof entry.value === 'string' ? JSON.parse(entry.value) : entry.value) as T
            })));
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