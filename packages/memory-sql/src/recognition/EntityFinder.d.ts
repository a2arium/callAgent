import { PrismaClient } from '@prisma/client';
/**
 * A dedicated service for finding matching entities using a progressive cascade of strategies.
 * This provides a single, reusable source of truth for entity matching.
 */
export declare class EntityFinder {
    private prisma;
    private embedFunction?;
    constructor(prisma: PrismaClient, embedFunction?: ((text: string) => Promise<number[]>) | undefined);
    /**
     * Finds matching entity IDs for a given value using a progressive search.
     * @returns An array of matching entity IDs, ordered by relevance.
     */
    findMatchingEntityIds(fieldValue: string, entityType: string, tenantId: string, threshold?: number): Promise<string[]>;
    /**
     * Finds matching entities with their canonical names and similarity scores.
     * Useful for debugging and detailed matching information.
     */
    findMatchingEntitiesWithDetails(fieldValue: string, entityType: string, tenantId: string, threshold?: number): Promise<Array<{
        entityId: string;
        canonicalName: string;
        matchType: string;
        similarity?: number;
    }>>;
    private findExactMatch;
    private findAliasMatch;
    private findTextSimilarityMatch;
    private findEmbeddingMatch;
    private findExactMatchWithDetails;
    private findAliasMatchWithDetails;
    private findTextSimilarityMatchWithDetails;
    private findEmbeddingMatchWithDetails;
    private normalizeText;
    private extractCoreTerms;
    private areTextsSimilar;
    private calculateTextSimilarityScore;
}
