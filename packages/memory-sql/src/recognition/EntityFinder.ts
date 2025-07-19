import { PrismaClient } from '@prisma/client';

/**
 * A dedicated service for finding matching entities using a progressive cascade of strategies.
 * This provides a single, reusable source of truth for entity matching.
 */
export class EntityFinder {
    constructor(
        private prisma: PrismaClient,
        private embedFunction?: (text: string) => Promise<number[]>
    ) { }

    /**
     * Finds matching entity IDs for a given value using a progressive search.
     * @returns An array of matching entity IDs, ordered by relevance.
     */
    public async findMatchingEntityIds(
        fieldValue: string,
        entityType: string,
        tenantId: string,
        threshold: number = 0.6
    ): Promise<string[]> {
        // Strategy 1: Exact Match (case-insensitive)
        const exactMatches = await this.findExactMatch(fieldValue, entityType, tenantId);
        if (exactMatches.length > 0) return exactMatches;

        // Strategy 2: Alias Match
        const aliasMatches = await this.findAliasMatch(fieldValue, entityType, tenantId);
        if (aliasMatches.length > 0) return aliasMatches;

        // Strategy 3: Text Similarity Match
        const textMatches = await this.findTextSimilarityMatch(fieldValue, entityType, tenantId);
        if (textMatches.length > 0) return textMatches;

        // Strategy 4: Embedding Similarity Match
        if (this.embedFunction) {
            const embeddingMatches = await this.findEmbeddingMatch(fieldValue, entityType, tenantId, threshold);
            if (embeddingMatches.length > 0) return embeddingMatches;
        }

        return [];
    }

    /**
     * Finds matching entities with their canonical names and similarity scores.
     * Useful for debugging and detailed matching information.
     */
    public async findMatchingEntitiesWithDetails(
        fieldValue: string,
        entityType: string,
        tenantId: string,
        threshold: number = 0.6
    ): Promise<Array<{ entityId: string; canonicalName: string; matchType: string; similarity?: number }>> {
        const results: Array<{ entityId: string; canonicalName: string; matchType: string; similarity?: number }> = [];

        // Try each strategy and collect results
        const exactMatches = await this.findExactMatchWithDetails(fieldValue, entityType, tenantId);
        results.push(...exactMatches);
        if (results.length > 0) return results;

        const aliasMatches = await this.findAliasMatchWithDetails(fieldValue, entityType, tenantId);
        results.push(...aliasMatches);
        if (results.length > 0) return results;

        const textMatches = await this.findTextSimilarityMatchWithDetails(fieldValue, entityType, tenantId);
        results.push(...textMatches);
        if (results.length > 0) return results;

        if (this.embedFunction) {
            const embeddingMatches = await this.findEmbeddingMatchWithDetails(fieldValue, entityType, tenantId, threshold);
            results.push(...embeddingMatches);
        }

        return results;
    }

    // --- Private Matching Strategies ---

    private async findExactMatch(value: string, entityType: string, tenantId: string): Promise<string[]> {
        const entities = await this.prisma.entityStore.findMany({
            where: { entityType, tenantId, canonicalName: { equals: value, mode: 'insensitive' } },
            select: { id: true },
        });
        return entities.map(e => e.id);
    }

    private async findAliasMatch(value: string, entityType: string, tenantId: string): Promise<string[]> {
        const entities = await this.prisma.entityStore.findMany({
            where: { entityType, tenantId, aliases: { has: value } },
            select: { id: true },
        });
        return entities.map(e => e.id);
    }

    private async findTextSimilarityMatch(value: string, entityType: string, tenantId: string): Promise<string[]> {
        const allEntities = await this.prisma.entityStore.findMany({
            where: { entityType, tenantId },
            select: { id: true, canonicalName: true },
        });

        const matchingIds: string[] = [];
        for (const entity of allEntities) {
            if (this.areTextsSimilar(value, entity.canonicalName)) {
                matchingIds.push(entity.id);
            }
        }
        return matchingIds;
    }

    private async findEmbeddingMatch(value: string, entityType: string, tenantId: string, threshold: number): Promise<string[]> {
        try {
            const embedding = await this.embedFunction!(value);
            const results = await this.prisma.$queryRaw<Array<{ id: string; similarity: number }>>`
                SELECT id, 1 - (embedding <=> ${embedding}::vector) as similarity
                FROM entity_store 
                WHERE entity_type = ${entityType} AND tenant_id = ${tenantId}
                ORDER BY similarity DESC
            `;
            return results.filter(r => r.similarity > threshold).map(r => r.id);
        } catch (error) {
            console.warn(`Embedding search failed for '${value}':`, error);
            return [];
        }
    }

    // --- Detailed Matching Strategies (with debug info) ---

    private async findExactMatchWithDetails(value: string, entityType: string, tenantId: string) {
        const entities = await this.prisma.entityStore.findMany({
            where: { entityType, tenantId, canonicalName: { equals: value, mode: 'insensitive' } },
            select: { id: true, canonicalName: true },
        });
        return entities.map(e => ({
            entityId: e.id,
            canonicalName: e.canonicalName,
            matchType: 'exact'
        }));
    }

    private async findAliasMatchWithDetails(value: string, entityType: string, tenantId: string) {
        const entities = await this.prisma.entityStore.findMany({
            where: { entityType, tenantId, aliases: { has: value } },
            select: { id: true, canonicalName: true },
        });
        return entities.map(e => ({
            entityId: e.id,
            canonicalName: e.canonicalName,
            matchType: 'alias'
        }));
    }

    private async findTextSimilarityMatchWithDetails(value: string, entityType: string, tenantId: string) {
        const allEntities = await this.prisma.entityStore.findMany({
            where: { entityType, tenantId },
            select: { id: true, canonicalName: true },
        });

        const results = [];
        for (const entity of allEntities) {
            const similarity = this.calculateTextSimilarityScore(value, entity.canonicalName);
            if (similarity >= 0.5) { // Only include if similarity meets threshold
                results.push({
                    entityId: entity.id,
                    canonicalName: entity.canonicalName,
                    matchType: 'text_similarity',
                    similarity
                });
            }
        }
        return results.sort((a, b) => b.similarity! - a.similarity!);
    }

    private async findEmbeddingMatchWithDetails(value: string, entityType: string, tenantId: string, threshold: number) {
        try {
            const embedding = await this.embedFunction!(value);
            const results = await this.prisma.$queryRaw<Array<{ id: string; canonical_name: string; similarity: number }>>`
                SELECT id, canonical_name, 1 - (embedding <=> ${embedding}::vector) as similarity
                FROM entity_store 
                WHERE entity_type = ${entityType} AND tenant_id = ${tenantId}
                ORDER BY similarity DESC
            `;
            return results
                .filter(r => r.similarity > threshold)
                .map(r => ({
                    entityId: r.id,
                    canonicalName: r.canonical_name,
                    matchType: 'embedding',
                    similarity: r.similarity
                }));
        } catch (error) {
            console.warn(`Embedding search failed for '${value}':`, error);
            return [];
        }
    }

    // --- Generic & Agnostic Normalization Logic ---

    private normalizeText(text: string): string {
        return text
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
            .replace(/[^\w\s]/g, ' ') // Replace punctuation with spaces
            .replace(/\s+/g, ' ') // Normalize whitespace
            .trim();
    }

    private extractCoreTerms(text: string): string[] {
        const words = this.normalizeText(text).split(' ').filter(w => w.length > 2);
        const stopWords = new Set(['the', 'and', 'for', 'with', 'not']); // Minimal stop words
        return words.filter(word => !stopWords.has(word));
    }

    private areTextsSimilar(text1: string, text2: string): boolean {
        const score = this.calculateTextSimilarityScore(text1, text2);
        return score >= 0.5;
    }

    private calculateTextSimilarityScore(text1: string, text2: string): number {
        const core1 = new Set(this.extractCoreTerms(text1));
        const core2 = new Set(this.extractCoreTerms(text2));
        if (core1.size === 0 || core2.size === 0) return 0;

        const intersection = new Set([...core1].filter(x => core2.has(x)));
        const minLength = Math.min(core1.size, core2.size);

        return intersection.size / minLength;
    }
} 