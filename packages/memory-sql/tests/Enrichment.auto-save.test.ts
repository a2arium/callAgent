import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { MemorySQLAdapter } from '../src/MemorySQLAdapter.js';
import { prismaMock } from './__mocks__/prisma.js';
import type { EnrichmentOptions } from '@a2arium/types';

describe('MemorySQLAdapter - Enrichment Auto-Save', () => {
    let adapter: MemorySQLAdapter;
    let mockEmbedFunction: jest.MockedFunction<(text: string) => Promise<number[]>>;
    let mockTaskContext: any;

    beforeEach(() => {
        mockEmbedFunction = jest.fn<(text: string) => Promise<number[]>>().mockResolvedValue([0.1, 0.2, 0.3]);

        // Mock LLM context
        mockTaskContext = {
            tenantId: 'test-tenant',
            llm: {
                call: jest.fn() as any
            }
        };

        // Configure LLM mock response
        (mockTaskContext.llm.call as jest.MockedFunction<any>).mockResolvedValue([{
            content: JSON.stringify({
                venue: 'Main Auditorium',
                capacity: 500,
                duration: '2 hours'
            }),
            isComplete: true
        }]);

        adapter = new MemorySQLAdapter(prismaMock, mockEmbedFunction, {
            defaultTenantId: 'test-tenant'
        });
        jest.clearAllMocks();
    });

    describe('enrich() method with auto-save behavior', () => {
        test('automatically saves enriched data by default', async () => {
            const key = 'test-event';
            const existingData = {
                title: 'Tech Conference',
                venue: 'Conference Center'
            };
            const additionalData = [
                { capacity: 500, duration: '2 hours' },
                { registration: 'required' }
            ];

            // Mock the original memory entry query
            prismaMock.$queryRaw.mockResolvedValueOnce([{
                key: 'test-event',
                value: existingData,
                tags: ['event', 'conference'],
                created_at: new Date(),
                updated_at: new Date()
            }]);

            // Mock the get method to return existing data
            jest.spyOn(adapter, 'get').mockResolvedValue(existingData);

            // Mock the set method to track save calls
            const setSpy = jest.spyOn(adapter, 'set').mockResolvedValue(undefined);

            const result = await adapter.enrich(key, additionalData, {
                taskContext: mockTaskContext,
                forceLLMEnrichment: false
            });

            // Verify that set was called to save the enriched data
            expect(setSpy).toHaveBeenCalledWith(key, expect.objectContaining({
                title: 'Tech Conference',
                venue: 'Conference Center'
            }), {
                tenantId: 'test-tenant',
                tags: ['event', 'conference']
            });

            // Verify the result indicates data was saved
            expect(result.saved).toBe(true);
            expect(result.enrichedData).toBeDefined();
            expect(Array.isArray(result.changes)).toBe(true);
        });

        test('does not save when dryRun is true', async () => {
            const key = 'test-event';
            const existingData = {
                title: 'Tech Conference',
                venue: 'Conference Center'
            };
            const additionalData = [
                { capacity: 500, duration: '2 hours' }
            ];

            // Mock the original memory entry query
            prismaMock.$queryRaw.mockResolvedValueOnce([{
                key: 'test-event',
                value: existingData,
                tags: ['event'],
                created_at: new Date(),
                updated_at: new Date()
            }]);

            // Mock the get method to return existing data
            jest.spyOn(adapter, 'get').mockResolvedValue(existingData);

            // Mock the set method to track save calls
            const setSpy = jest.spyOn(adapter, 'set').mockResolvedValue(undefined);

            const result = await adapter.enrich(key, additionalData, {
                taskContext: mockTaskContext,
                dryRun: true
            });

            // Verify that set was NOT called
            expect(setSpy).not.toHaveBeenCalled();

            // Verify the result indicates data was not saved
            expect(result.saved).toBe(false);
            expect(result.enrichedData).toBeDefined();
            expect(Array.isArray(result.changes)).toBe(true);
        });

        test('preserves original tags when saving', async () => {
            const key = 'test-event';
            const existingData = { title: 'Conference' };
            const additionalData = [{ capacity: 200 }];
            const originalTags = ['event', 'important', 'quarterly'];

            // Mock the original memory entry query
            prismaMock.$queryRaw.mockResolvedValueOnce([{
                key: 'test-event',
                value: existingData,
                tags: originalTags,
                created_at: new Date(),
                updated_at: new Date()
            }]);

            // Mock the get method
            jest.spyOn(adapter, 'get').mockResolvedValue(existingData);

            // Mock the set method
            const setSpy = jest.spyOn(adapter, 'set').mockResolvedValue(undefined);

            await adapter.enrich(key, additionalData, {
                taskContext: mockTaskContext
            });

            // Verify that the original tags were preserved
            expect(setSpy).toHaveBeenCalledWith(key, expect.any(Object), {
                tenantId: 'test-tenant',
                tags: originalTags
            });
        });

        test('handles empty tags gracefully', async () => {
            const key = 'test-event';
            const existingData = { title: 'Conference' };
            const additionalData = [{ capacity: 200 }];

            // Mock the original memory entry query with empty tags
            prismaMock.$queryRaw.mockResolvedValueOnce([{
                key: 'test-event',
                value: existingData,
                tags: [],
                created_at: new Date(),
                updated_at: new Date()
            }]);

            // Mock the get method
            jest.spyOn(adapter, 'get').mockResolvedValue(existingData);

            // Mock the set method
            const setSpy = jest.spyOn(adapter, 'set').mockResolvedValue(undefined);

            await adapter.enrich(key, additionalData, {
                taskContext: mockTaskContext
            });

            // Verify that empty tags array was used
            expect(setSpy).toHaveBeenCalledWith(key, expect.any(Object), {
                tenantId: 'test-tenant',
                tags: []
            });
        });

        test('throws error when memory entry not found', async () => {
            const key = 'non-existent-key';
            const additionalData = [{ capacity: 200 }];

            // Mock the get method to return null
            jest.spyOn(adapter, 'get').mockResolvedValue(null);

            await expect(adapter.enrich(key, additionalData, {
                taskContext: mockTaskContext
            })).rejects.toThrow('Memory entry with key "non-existent-key" not found');
        });

        test('throws error when taskContext is missing', async () => {
            const key = 'test-event';
            const additionalData = [{ capacity: 200 }];

            await expect(adapter.enrich(key, additionalData, {})).rejects.toThrow('TaskContext is required for enrichment');
        });

        test('throws error when enrichment service is not available', async () => {
            // Create adapter without embedding function (no enrichment service)
            const adapterWithoutEmbedding = new MemorySQLAdapter(prismaMock, undefined, {
                defaultTenantId: 'test-tenant'
            });

            const key = 'test-event';
            const additionalData = [{ capacity: 200 }];

            await expect(adapterWithoutEmbedding.enrich(key, additionalData, {
                taskContext: mockTaskContext
            })).rejects.toThrow('Enrichment service not available. Entity alignment with embedFunction required.');
        });
    });
}); 