import { describe, test, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';
import { PrismaClient } from '@prisma/client';
import { MemorySQLAdapter } from '../src/MemorySQLAdapter.js';

describe('Array Filtering Integration Tests', () => {
    let adapter: MemorySQLAdapter;
    let prisma: PrismaClient;
    const testTenantId = 'test-tenant-array-filtering';

    beforeAll(async () => {
        // Setup test database
        prisma = new PrismaClient({
            datasources: {
                db: {
                    url: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
                }
            }
        });

        adapter = new MemorySQLAdapter({
            prismaClient: prisma,
            defaultTenantId: testTenantId
        });
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        // Clean up test data
        await prisma.agentMemoryStore.deleteMany({
            where: { tenantId: testTenantId }
        });

        // Create comprehensive test events with various array structures
        await adapter.set('event:001', {
            title: 'Tech Conference 2025',
            city: 'Riga',
            eventOccurences: [
                { date: '2025-07-24', time: '09:00', priority: 9, status: 'confirmed' },
                { date: '2025-07-25', time: '10:00', priority: 7, status: 'pending' }
            ],
            venue: {
                name: 'Conference Center',
                capacity: 500,
                location: { city: 'Riga', country: 'Latvia' }
            },
            speakers: [
                { name: 'Dr. John Smith', expertise: 'AI', rating: 9.2 },
                { name: 'Jane Doe', expertise: 'Machine Learning', rating: 8.8 }
            ]
        }, { tags: ['event', 'tech', 'conference'] });

        await adapter.set('event:002', {
            title: 'Art Exhibition',
            city: 'Riga',
            eventOccurences: [
                { date: '2025-07-24', time: '14:00', priority: 6, status: 'confirmed' },
                { date: '2025-07-26', time: '15:00', priority: 5, status: 'cancelled' }
            ],
            venue: {
                name: 'Art Gallery',
                capacity: 200,
                location: { city: 'Riga', country: 'Latvia' }
            },
            speakers: [
                { name: 'Maria Gonzalez', expertise: 'Contemporary Art', rating: 9.0 }
            ]
        }, { tags: ['event', 'art', 'exhibition'] });

        await adapter.set('event:003', {
            title: 'Music Festival',
            city: 'Tallinn',
            eventOccurences: [
                { date: '2025-07-26', time: '18:00', priority: 8, status: 'confirmed' },
                { date: '2025-07-27', time: '19:00', priority: 9, status: 'confirmed' }
            ],
            venue: {
                name: 'Outdoor Stage',
                capacity: 1000,
                location: { city: 'Tallinn', country: 'Estonia' }
            },
            speakers: [
                { name: 'Rock Band A', expertise: 'Rock Music', rating: 8.5 },
                { name: 'DJ Cool', expertise: 'Electronic Music', rating: 9.1 }
            ]
        }, { tags: ['event', 'music', 'festival'] });

        await adapter.set('event:004', {
            title: 'Business Summit',
            city: 'Helsinki',
            eventOccurences: [
                { date: '2025-07-28', time: '08:00', priority: 10, status: 'confirmed' }
            ],
            venue: {
                name: 'Business Center',
                capacity: 300,
                location: { city: 'Helsinki', country: 'Finland' }
            },
            speakers: [
                { name: 'CEO Alice', expertise: 'Business Strategy', rating: 9.5 }
            ]
        }, { tags: ['event', 'business', 'summit'] });
    });

    describe('Basic Array Filtering', () => {
        test('filters by array element equality', async () => {
            const results = await adapter.getMany({
                filters: ['eventOccurences[].date = "2025-07-24"']
            });

            expect(results).toHaveLength(2);
            const resultKeys = results.map(r => r.key).sort();
            expect(resultKeys).toEqual(['event:001', 'event:002']);
        });

        test('filters by array element string field', async () => {
            const results = await adapter.getMany({
                filters: ['eventOccurences[].status = "confirmed"']
            });

            expect(results).toHaveLength(3); // event:001, event:002, event:003
            const resultKeys = results.map(r => r.key).sort();
            expect(resultKeys).toEqual(['event:001', 'event:002', 'event:003']);
        });

        test('filters by array element time field', async () => {
            const results = await adapter.getMany({
                filters: ['eventOccurences[].time = "09:00"']
            });

            expect(results).toHaveLength(1);
            expect(results[0].key).toBe('event:001');
        });
    });

    describe('Array Filtering with Comparison Operators', () => {
        test('filters by array element with greater than', async () => {
            const results = await adapter.getMany({
                filters: ['eventOccurences[].priority > 8']
            });

            expect(results).toHaveLength(3); // event:001 (priority 9), event:003 (priority 8,9), event:004 (priority 10)
            const resultKeys = results.map(r => r.key).sort();
            expect(resultKeys).toEqual(['event:001', 'event:003', 'event:004']);
        });

        test('filters by array element with greater than or equal', async () => {
            const results = await adapter.getMany({
                filters: ['eventOccurences[].priority >= 8']
            });

            expect(results).toHaveLength(3); // Should include priority 8 and above
            const resultKeys = results.map(r => r.key).sort();
            expect(resultKeys).toEqual(['event:001', 'event:003', 'event:004']);
        });

        test('filters by array element with less than', async () => {
            const results = await adapter.getMany({
                filters: ['eventOccurences[].priority < 7']
            });

            expect(results).toHaveLength(1); // event:002 has priority 6 and 5
            expect(results[0].key).toBe('event:002');
        });

        test('filters by array element with not equal', async () => {
            const results = await adapter.getMany({
                filters: ['eventOccurences[].status != "confirmed"']
            });

            expect(results).toHaveLength(2); // event:001 (has pending), event:002 (has cancelled)
            const resultKeys = results.map(r => r.key).sort();
            expect(resultKeys).toEqual(['event:001', 'event:002']);
        });
    });

    describe('Array Filtering with String Operators', () => {
        test('filters by array element with CONTAINS', async () => {
            const results = await adapter.getMany({
                filters: ['eventOccurences[].time contains "0:00"']
            });

            expect(results).toHaveLength(4); // All events have times ending in ":00"
            const resultKeys = results.map(r => r.key).sort();
            expect(resultKeys).toEqual(['event:001', 'event:002', 'event:003', 'event:004']);
        });

        test('filters by array element with STARTS_WITH', async () => {
            const results = await adapter.getMany({
                filters: ['eventOccurences[].time starts_with "1"']
            });

            expect(results).toHaveLength(3); // event:002 (14:00, 15:00), event:003 (18:00, 19:00)
            const resultKeys = results.map(r => r.key).sort();
            expect(resultKeys).toEqual(['event:002', 'event:003']);
        });

        test('filters by array element with ENDS_WITH', async () => {
            const results = await adapter.getMany({
                filters: ['eventOccurences[].status ends_with "ed"']
            });

            expect(results).toHaveLength(3); // "confirmed" and "cancelled" end with "ed"
            const resultKeys = results.map(r => r.key).sort();
            expect(resultKeys).toEqual(['event:001', 'event:002', 'event:003']);
        });
    });

    describe('Nested Object Array Filtering', () => {
        test('filters by nested object field in array', async () => {
            const results = await adapter.getMany({
                filters: ['speakers[].name = "Dr. John Smith"']
            });

            expect(results).toHaveLength(1);
            expect(results[0].key).toBe('event:001');
        });

        test('filters by nested field with string operations', async () => {
            const results = await adapter.getMany({
                filters: ['speakers[].expertise contains "Music"']
            });

            expect(results).toHaveLength(1);
            expect(results[0].key).toBe('event:003');
        });

        test('filters by nested numeric field', async () => {
            const results = await adapter.getMany({
                filters: ['speakers[].rating >= 9.0']
            });

            expect(results).toHaveLength(3); // event:001 (9.2), event:002 (9.0), event:003 (9.1), event:004 (9.5)
            const resultKeys = results.map(r => r.key).sort();
            expect(resultKeys).toEqual(['event:001', 'event:002', 'event:003', 'event:004']);
        });
    });

    describe('Combined Filtering', () => {
        test('combines array filter with regular filters', async () => {
            const results = await adapter.getMany({
                filters: [
                    'eventOccurences[].date = "2025-07-24"',
                    'city = "Riga"'
                ]
            });

            expect(results).toHaveLength(2);
            const resultKeys = results.map(r => r.key).sort();
            expect(resultKeys).toEqual(['event:001', 'event:002']);
        });

        test('combines array filter with tag filtering', async () => {
            const results = await adapter.getMany({
                tag: 'tech',
                filters: ['eventOccurences[].date = "2025-07-24"']
            });

            expect(results).toHaveLength(1);
            expect(results[0].key).toBe('event:001');
        });

        test('combines multiple array filters', async () => {
            const results = await adapter.getMany({
                filters: [
                    'eventOccurences[].date = "2025-07-24"',
                    'speakers[].rating >= 9.0'
                ]
            });

            expect(results).toHaveLength(2); // event:001 (has Dr. John Smith with 9.2), event:002 (has Maria with 9.0)
            const resultKeys = results.map(r => r.key).sort();
            expect(resultKeys).toEqual(['event:001', 'event:002']);
        });

        test('combines array filter with multiple regular filters', async () => {
            const results = await adapter.getMany({
                filters: [
                    'eventOccurences[].priority >= 8',
                    'city = "Riga"',
                    'venue.capacity > 400'
                ]
            });

            expect(results).toHaveLength(1); // Only event:001 meets all criteria
            expect(results[0].key).toBe('event:001');
        });
    });

    describe('Edge Cases and Error Handling', () => {
        test('handles non-existent array fields gracefully', async () => {
            const results = await adapter.getMany({
                filters: ['nonExistentArray[].field = "value"']
            });

            expect(results).toHaveLength(0);
        });

        test('handles non-existent nested fields in arrays gracefully', async () => {
            const results = await adapter.getMany({
                filters: ['eventOccurences[].nonExistentField = "value"']
            });

            expect(results).toHaveLength(0);
        });

        test('throws error for invalid array syntax', async () => {
            await expect(adapter.getMany({
                filters: ['eventOccurences[] = "invalid"']
            })).rejects.toThrow('Array path "eventOccurences[]" must specify a field');
        });

        test('throws error for empty array field name', async () => {
            await expect(adapter.getMany({
                filters: ['[].field = "value"']
            })).rejects.toThrow('Invalid array path syntax');
        });
    });

    describe('Data Type Handling', () => {
        test('handles string values correctly', async () => {
            const results = await adapter.getMany({
                filters: ['eventOccurences[].status = "pending"']
            });

            expect(results).toHaveLength(1);
            expect(results[0].key).toBe('event:001');
        });

        test('handles numeric values correctly', async () => {
            const results = await adapter.getMany({
                filters: ['eventOccurences[].priority = 10']
            });

            expect(results).toHaveLength(1);
            expect(results[0].key).toBe('event:004');
        });

        test('handles decimal values correctly', async () => {
            const results = await adapter.getMany({
                filters: ['speakers[].rating = 9.2']
            });

            expect(results).toHaveLength(1);
            expect(results[0].key).toBe('event:001');
        });
    });

    describe('Performance and Limits', () => {
        test('respects query limits with array filters', async () => {
            const results = await adapter.getMany({
                filters: ['eventOccurences[].priority >= 5'],
                limit: 2
            });

            expect(results).toHaveLength(2);
        });

        test('works with large result sets', async () => {
            // Create additional test data
            for (let i = 5; i <= 10; i++) {
                await adapter.set(`event:${i.toString().padStart(3, '0')}`, {
                    title: `Event ${i}`,
                    eventOccurences: [
                        { date: '2025-07-30', priority: i, status: 'confirmed' }
                    ]
                });
            }

            const results = await adapter.getMany({
                filters: ['eventOccurences[].date = "2025-07-30"']
            });

            expect(results).toHaveLength(6); // events 005-010
        });
    });

    describe('Complex Nested Paths', () => {
        test('handles deeply nested object paths', async () => {
            // This would test venue.location.city if we had that structure
            const results = await adapter.getMany({
                filters: ['venue.location.city = "Riga"']
            });

            expect(results).toHaveLength(2); // event:001 and event:002
            const resultKeys = results.map(r => r.key).sort();
            expect(resultKeys).toEqual(['event:001', 'event:002']);
        });
    });
}); 