import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { EntityFinder } from '../src/recognition/EntityFinder.js';
import { prismaMock } from './__mocks__/prisma.js';

// Mock embedding function for testing
const mockEmbedFunction = jest.fn() as any;

describe('EntityFinder', () => {
    let entityFinder: EntityFinder;

    beforeEach(() => {
        jest.clearAllMocks();
        entityFinder = new EntityFinder(prismaMock as any, mockEmbedFunction);
    });

    describe('findMatchingEntityIds', () => {
        it('should find exact matches', async () => {
            // Setup: Mock entity store with exact match
            (prismaMock.entityStore.findMany as any).mockResolvedValue([
                { id: 'entity-1' }
            ]);

            const result = await entityFinder.findMatchingEntityIds(
                'Test Location',
                'location',
                'test-tenant'
            );

            expect(result).toEqual(['entity-1']);
            expect(prismaMock.entityStore.findMany).toHaveBeenCalledWith({
                where: {
                    entityType: 'location',
                    tenantId: 'test-tenant',
                    canonicalName: { equals: 'Test Location', mode: 'insensitive' }
                },
                select: { id: true },
            });
        });

        it('should find alias matches when exact match fails', async () => {
            // Setup: Mock no exact match, then alias match
            (prismaMock.entityStore.findMany as any)
                .mockResolvedValueOnce([]) // No exact match
                .mockResolvedValueOnce([   // Alias match
                    { id: 'entity-2' }
                ]);

            const result = await entityFinder.findMatchingEntityIds(
                'Test Location',
                'location',
                'test-tenant'
            );

            expect(result).toEqual(['entity-2']);
            expect(prismaMock.entityStore.findMany).toHaveBeenCalledTimes(2);
        });

        it('should find text similarity matches for address variations', async () => {
            // This tests the critical case that was failing before!
            // Setup: Mock no exact/alias matches, then text similarity
            (prismaMock.entityStore.findMany as jest.Mock)
                .mockResolvedValueOnce([]) // No exact match
                .mockResolvedValueOnce([]) // No alias match
                .mockResolvedValueOnce([   // For text similarity search
                    { id: 'entity-3', canonicalName: 'Prūšu iela 13B' } as any,
                    { id: 'entity-4', canonicalName: 'Different Street 5' } as any
                ]);

            const result = await entityFinder.findMatchingEntityIds(
                'Prūšu ielā 13b, Rīgā', // Input with different case endings and city
                'location',
                'test-tenant'
            );

            // Should find entity-3 because of text similarity
            expect(result).toEqual(['entity-3']);
            expect(prismaMock.entityStore.findMany).toHaveBeenCalledTimes(3);
        });

        it('should find text similarity matches for venue name variations', async () => {
            // Another critical case: venue name in different grammatical case
            (prismaMock.entityStore.findMany as jest.Mock)
                .mockResolvedValueOnce([]) // No exact match
                .mockResolvedValueOnce([]) // No alias match
                .mockResolvedValueOnce([   // For text similarity search
                    {
                        id: 'entity-5',
                        canonicalName: 'Kultūras un tautas mākslas centrs "Mazā Ģilde"'
                    } as any,
                    {
                        id: 'entity-6',
                        canonicalName: 'Different Cultural Center'
                    } as any
                ]);

            const result = await entityFinder.findMatchingEntityIds(
                'Mazās ģildes dārzs', // Genitive case + sub-venue
                'location',
                'test-tenant'
            );

            // Should find entity-5 because "Mazās ģildes" matches "Mazā Ģilde"
            expect(result).toEqual(['entity-5']);
        });

        it('should return empty array when no matches found', async () => {
            // Setup: Mock no matches anywhere
            prismaMock.entityStore.findMany.mockResolvedValue([]);

            const result = await entityFinder.findMatchingEntityIds(
                'Non-existent Location',
                'location',
                'test-tenant'
            );

            expect(result).toEqual([]);
        });

        it('should use embedding similarity as fallback', async () => {
            // Setup: Mock no text matches, then embedding match
            prismaMock.entityStore.findMany.mockResolvedValue([]);
            prismaMock.$queryRaw.mockResolvedValue([
                { id: 'entity-7', similarity: 0.75 },
                { id: 'entity-8', similarity: 0.45 } // Below threshold
            ]);

            const result = await entityFinder.findMatchingEntityIds(
                'Similar Location',
                'location',
                'test-tenant',
                0.6 // threshold
            );

            expect(result).toEqual(['entity-7']); // Only above threshold
            expect(mockEmbedFunction).toHaveBeenCalledWith('Similar Location');
        });
    });

    describe('findMatchingEntitiesWithDetails', () => {
        it('should return detailed information about matches', async () => {
            (prismaMock.entityStore.findMany as jest.Mock).mockResolvedValue([
                { id: 'entity-1', canonicalName: 'Test Location' } as any
            ]);

            const result = await entityFinder.findMatchingEntitiesWithDetails(
                'Test Location',
                'location',
                'test-tenant'
            );

            expect(result).toEqual([{
                entityId: 'entity-1',
                canonicalName: 'Test Location',
                matchType: 'exact'
            }]);
        });

        it('should return text similarity scores', async () => {
            (prismaMock.entityStore.findMany as jest.Mock)
                .mockResolvedValueOnce([]) // No exact match
                .mockResolvedValueOnce([]) // No alias match  
                .mockResolvedValueOnce([   // Text similarity
                    { id: 'entity-1', canonicalName: 'Prūšu iela 13B' } as any
                ]);

            const result = await entityFinder.findMatchingEntitiesWithDetails(
                'Prūšu ielā 13b, Rīgā',
                'location',
                'test-tenant'
            );

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                entityId: 'entity-1',
                canonicalName: 'Prūšu iela 13B',
                matchType: 'text_similarity',
                similarity: expect.any(Number)
            });
            expect(result[0].similarity).toBeGreaterThan(0.5);
        });
    });
});

// Test the core text similarity logic
describe('EntityFinder text similarity', () => {
    let entityFinder: EntityFinder;

    beforeEach(() => {
        entityFinder = new EntityFinder(prismaMock as any);
    });

    // Access private methods for testing core logic
    const getEntityFinder = () => entityFinder as any;

    it('should normalize text correctly', () => {
        const normalized = getEntityFinder().normalizeText('Prūšu ielā 13B, Rīgā!');
        expect(normalized).toBe('prusu iela 13b riga');
    });

    it('should extract core terms correctly', () => {
        const terms = getEntityFinder().extractCoreTerms('Kultūras un tautas mākslas centrs');
        expect(terms).toEqual(['kulturas', 'tautas', 'makslas', 'centrs']);
    });

    it('should calculate text similarity correctly', () => {
        const score = getEntityFinder().calculateTextSimilarityScore(
            'Prūšu iela 13B',
            'Prūšu ielā 13b, Rīgā'
        );
        expect(score).toBe(1.0); // Perfect overlap of core terms
    });

    it('should calculate partial similarity correctly', () => {
        const score = getEntityFinder().calculateTextSimilarityScore(
            'Mazās ģildes dārzs',
            'Kultūras un tautas mākslas centrs "Mazā Ģilde"'
        );
        expect(score).toBeGreaterThan(0.3); // Some overlap ("Mazās ģildes" matches "Mazā Ģilde")
    });
}); 