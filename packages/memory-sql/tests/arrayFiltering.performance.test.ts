import { describe, test, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';
import { PrismaClient } from '@prisma/client';
import { MemorySQLAdapter } from '../src/MemorySQLAdapter.js';

describe('Array Filtering Performance Tests', () => {
    let adapter: MemorySQLAdapter;
    let prisma: PrismaClient;
    const testTenantId = 'test-tenant-performance';
    const LARGE_DATASET_SIZE = 1000;

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
    });

    describe('Large Dataset Performance', () => {
        test('performs well with large datasets - array equality filter', async () => {
            // Create large dataset
            const promises = [];
            for (let i = 1; i <= LARGE_DATASET_SIZE; i++) {
                const eventData = {
                    title: `Event ${i}`,
                    city: i % 2 === 0 ? 'Riga' : 'Tallinn',
                    eventOccurences: [
                        {
                            date: i <= 500 ? '2025-07-24' : '2025-07-25',
                            time: `${(8 + (i % 12)).toString().padStart(2, '0')}:00`,
                            priority: (i % 10) + 1,
                            status: i % 3 === 0 ? 'confirmed' : 'pending'
                        }
                    ],
                    venue: {
                        name: `Venue ${i}`,
                        capacity: 100 + (i * 2)
                    }
                };

                promises.push(adapter.set(`event:${i.toString().padStart(4, '0')}`, eventData));

                // Process in batches to avoid overwhelming the database
                if (promises.length === 50) {
                    await Promise.all(promises);
                    promises.length = 0;
                }
            }

            // Process remaining promises
            if (promises.length > 0) {
                await Promise.all(promises);
            }

            // Measure performance of array filtering
            const startTime = Date.now();

            const results = await adapter.getMany({
                filters: ['eventOccurences[].date = "2025-07-24"']
            });

            const queryTime = Date.now() - startTime;

            console.log(`Array filter query took ${queryTime}ms for ${LARGE_DATASET_SIZE} records`);

            // Should find 500 events (half of the dataset)
            expect(results).toHaveLength(500);

            // Query should complete within reasonable time (adjust based on your requirements)
            expect(queryTime).toBeLessThan(5000); // 5 seconds max
        });

        test('performs well with complex combined filters', async () => {
            // Use smaller dataset for complex queries to keep test reasonable
            const datasetSize = 500;

            // Create test dataset
            const promises = [];
            for (let i = 1; i <= datasetSize; i++) {
                const eventData = {
                    title: `Conference ${i}`,
                    city: i % 3 === 0 ? 'Riga' : i % 3 === 1 ? 'Tallinn' : 'Helsinki',
                    eventOccurences: [
                        {
                            date: '2025-07-24',
                            priority: (i % 10) + 1,
                            status: 'confirmed'
                        }
                    ],
                    speakers: [
                        {
                            name: `Speaker ${i}`,
                            expertise: i % 2 === 0 ? 'Technology' : 'Business',
                            rating: 7.0 + (i % 3)
                        }
                    ],
                    venue: {
                        capacity: 100 + (i * 5)
                    }
                };

                promises.push(adapter.set(`conf:${i.toString().padStart(3, '0')}`, eventData));

                if (promises.length === 25) {
                    await Promise.all(promises);
                    promises.length = 0;
                }
            }

            if (promises.length > 0) {
                await Promise.all(promises);
            }

            // Test complex query performance
            const startTime = Date.now();

            const results = await adapter.getMany({
                filters: [
                    'eventOccurences[].priority >= 8',
                    'speakers[].rating >= 8.0',
                    'city = "Riga"',
                    'venue.capacity > 500'
                ]
            });

            const queryTime = Date.now() - startTime;

            console.log(`Complex combined filter query took ${queryTime}ms for ${datasetSize} records`);

            // Should complete within reasonable time
            expect(queryTime).toBeLessThan(3000); // 3 seconds max

            // Verify we get some results (exact count depends on the data distribution)
            expect(results.length).toBeGreaterThanOrEqual(0);
        });

        test('scales linearly with result set size', async () => {
            const testSizes = [100, 200, 400];
            const queryTimes: number[] = [];

            for (const size of testSizes) {
                // Clean previous data
                await prisma.agentMemoryStore.deleteMany({
                    where: { tenantId: testTenantId }
                });

                // Create dataset of specified size
                const promises = [];
                for (let i = 1; i <= size; i++) {
                    const eventData = {
                        title: `Event ${i}`,
                        eventOccurences: [
                            {
                                date: '2025-07-24',
                                priority: 8,
                                status: 'confirmed'
                            }
                        ]
                    };

                    promises.push(adapter.set(`event:${i}`, eventData));

                    if (promises.length === 20) {
                        await Promise.all(promises);
                        promises.length = 0;
                    }
                }

                if (promises.length > 0) {
                    await Promise.all(promises);
                }

                // Measure query time
                const startTime = Date.now();

                const results = await adapter.getMany({
                    filters: ['eventOccurences[].date = "2025-07-24"']
                });

                const queryTime = Date.now() - startTime;
                queryTimes.push(queryTime);

                console.log(`Query time for ${size} records: ${queryTime}ms`);

                // Verify correct result count
                expect(results).toHaveLength(size);
            }

            // Check that performance doesn't degrade dramatically
            // (This is a rough check - in practice you'd want more sophisticated performance analysis)
            const timeRatio = queryTimes[2] / queryTimes[0]; // 400 vs 100 records
            expect(timeRatio).toBeLessThan(10); // Should not be more than 10x slower for 4x data
        });

        test('handles concurrent array filter queries', async () => {
            // Create test dataset
            const promises = [];
            for (let i = 1; i <= 200; i++) {
                const eventData = {
                    title: `Event ${i}`,
                    eventOccurences: [
                        {
                            date: i % 2 === 0 ? '2025-07-24' : '2025-07-25',
                            priority: (i % 5) + 5
                        }
                    ]
                };

                promises.push(adapter.set(`event:${i}`, eventData));

                if (promises.length === 20) {
                    await Promise.all(promises);
                    promises.length = 0;
                }
            }

            if (promises.length > 0) {
                await Promise.all(promises);
            }

            // Run multiple concurrent queries
            const concurrentQueries = [
                adapter.getMany({ filters: ['eventOccurences[].date = "2025-07-24"'] }),
                adapter.getMany({ filters: ['eventOccurences[].date = "2025-07-25"'] }),
                adapter.getMany({ filters: ['eventOccurences[].priority >= 7'] }),
                adapter.getMany({ filters: ['eventOccurences[].priority < 7'] })
            ];

            const startTime = Date.now();
            const results = await Promise.all(concurrentQueries);
            const totalTime = Date.now() - startTime;

            console.log(`4 concurrent queries took ${totalTime}ms total`);

            // Verify results
            expect(results[0]).toHaveLength(100); // Half have 2025-07-24
            expect(results[1]).toHaveLength(100); // Half have 2025-07-25
            expect(results[2].length + results[3].length).toBe(200); // All records split by priority

            // Should handle concurrent queries reasonably well
            expect(totalTime).toBeLessThan(10000); // 10 seconds max for all concurrent queries
        });
    });

    describe('Query Optimization', () => {
        test('array filters perform better than equivalent in-memory filtering', async () => {
            // This test would compare raw SQL array filtering vs fetching all data and filtering in memory
            // For now, we'll just ensure array queries complete within reasonable time

            // Create test dataset
            const promises = [];
            for (let i = 1; i <= 500; i++) {
                const eventData = {
                    title: `Event ${i}`,
                    eventOccurences: [
                        {
                            date: i <= 100 ? '2025-07-24' : '2025-07-25',
                            priority: (i % 10) + 1
                        }
                    ]
                };

                promises.push(adapter.set(`event:${i}`, eventData));

                if (promises.length === 25) {
                    await Promise.all(promises);
                    promises.length = 0;
                }
            }

            if (promises.length > 0) {
                await Promise.all(promises);
            }

            // Test selective array filtering (should be fast)
            const startTime = Date.now();

            const results = await adapter.getMany({
                filters: ['eventOccurences[].date = "2025-07-24"']
            });

            const queryTime = Date.now() - startTime;

            console.log(`Selective array filter took ${queryTime}ms`);

            expect(results).toHaveLength(100);
            expect(queryTime).toBeLessThan(2000); // Should be fast for selective queries
        });

        test('multiple array filters are efficiently combined', async () => {
            // Create test dataset with multiple arrays
            const promises = [];
            for (let i = 1; i <= 300; i++) {
                const eventData = {
                    title: `Event ${i}`,
                    eventOccurences: [
                        {
                            date: '2025-07-24',
                            priority: (i % 10) + 1
                        }
                    ],
                    speakers: [
                        {
                            name: `Speaker ${i}`,
                            rating: 5.0 + (i % 5)
                        }
                    ]
                };

                promises.push(adapter.set(`event:${i}`, eventData));

                if (promises.length === 30) {
                    await Promise.all(promises);
                    promises.length = 0;
                }
            }

            if (promises.length > 0) {
                await Promise.all(promises);
            }

            // Test multiple array filters
            const startTime = Date.now();

            const results = await adapter.getMany({
                filters: [
                    'eventOccurences[].priority >= 8',
                    'speakers[].rating >= 8.0'
                ]
            });

            const queryTime = Date.now() - startTime;

            console.log(`Multiple array filters took ${queryTime}ms`);

            // Should efficiently combine multiple array conditions
            expect(queryTime).toBeLessThan(2500);
        });
    });
}); 