import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { MemorySQLAdapter } from '../src/MemorySQLAdapter.js';
import { prismaMock } from './__mocks__/prisma.js';
import type { RecognitionOptions, EnrichmentOptions } from '@callagent/types';
import { testEventSchema } from './testSchema.js';

describe('MemorySQLAdapter - Recognition and Enrichment', () => {
    let adapter: MemorySQLAdapter;
    let mockEmbedFunction: jest.MockedFunction<(text: string) => Promise<number[]>>;
    let mockTaskContext: any;

    beforeEach(() => {
        mockEmbedFunction = jest.fn<(text: string) => Promise<number[]>>().mockResolvedValue([0.1, 0.2, 0.3]);

        // Create a minimal mock TaskContext
        mockTaskContext = {
            tenantId: 'default',
            agentId: 'test-agent',
            llm: {
                call: jest.fn() as any
            },
            logger: {
                info: jest.fn(),
                error: jest.fn(),
                warn: jest.fn(),
                debug: jest.fn()
            }
        };

        adapter = new MemorySQLAdapter(prismaMock, mockEmbedFunction);
        jest.clearAllMocks();
    });

    describe('recognize() method', () => {
        test('has recognize method available when embedding function is provided', () => {
            expect(typeof adapter.recognize).toBe('function');
        });

        test('calls recognition service when available', async () => {
            const inputData = {
                title: 'Test Event',
                speaker: 'John Smith'
            };

            const options: RecognitionOptions = {
                entities: { title: 'event', speaker: 'person' },
                threshold: 0.75
            };

            // Mock the underlying service calls
            prismaMock.agentMemoryStore.findMany.mockResolvedValue([]);
            prismaMock.$queryRaw.mockResolvedValue([]);
            prismaMock.entityStore.findMany.mockResolvedValue([]);
            prismaMock.$queryRawUnsafe.mockResolvedValue([]);

            const result = await adapter.recognize(inputData, { ...options, taskContext: mockTaskContext });

            expect(result).toBeDefined();
            expect(typeof result.confidence).toBe('number');
            expect(typeof result.isMatch).toBe('boolean');
            expect(typeof result.usedLLM).toBe('boolean');
        });

        test('handles recognize method without embedding function', async () => {
            const adapterWithoutEmbedding = new MemorySQLAdapter(prismaMock);

            const inputData = { title: 'Test Event' };
            const options: RecognitionOptions = { entities: { title: 'event' } };

            // This should throw since no embedding function is provided
            await expect(adapterWithoutEmbedding.recognize(inputData, { ...options, taskContext: mockTaskContext }))
                .rejects.toThrow('Recognition service not available');
        });

        test('handles database errors gracefully', async () => {
            const inputData = { title: 'Test Event' };
            const options: RecognitionOptions = { entities: { title: 'event' } };

            // Mock database error
            prismaMock.agentMemoryStore.findMany.mockRejectedValue(new Error('Database connection failed'));
            prismaMock.$queryRaw.mockResolvedValue([]);
            prismaMock.entityStore.findMany.mockResolvedValue([]);
            prismaMock.$queryRawUnsafe.mockResolvedValue([]);

            const result = await adapter.recognize(inputData, { ...options, taskContext: mockTaskContext });

            expect(result.confidence).toBe(0);
            expect(result.error).toBeDefined();
        });
    });

    describe('enrich() method', () => {
        test('has enrich method available when embedding function is provided', () => {
            expect(typeof adapter.enrich).toBe('function');
        });

        test('calls enrichment service when available', async () => {
            const key = 'test-event';
            const additionalData = [
                { venue: 'Main Hall', duration: '2 hours' },
                { capacity: 100, registration: 'required' }
            ];

            const options: EnrichmentOptions = {
                schema: testEventSchema,
                forceLLMEnrichment: false,
                focusFields: ['venue', 'duration']
            };

            // Mock the underlying service calls  
            prismaMock.agentMemoryStore.findMany.mockResolvedValue([]);
            prismaMock.$queryRawUnsafe.mockResolvedValue([]);

            const result = await adapter.enrich(key, additionalData, { ...options, taskContext: mockTaskContext });

            expect(result).toBeDefined();
            expect(result.enrichedData).toBeDefined();
            expect(Array.isArray(result.changes)).toBe(true);
            expect(typeof result.usedLLM).toBe('boolean');
        });

        test('handles enrich method without embedding function', async () => {
            const adapterWithoutEmbedding = new MemorySQLAdapter(prismaMock);

            const key = 'test-event';
            const additionalData = [{ venue: 'Main Hall' }];
            const options: EnrichmentOptions = {
                schema: testEventSchema
            };

            // This should throw since no embedding function is provided
            await expect(adapterWithoutEmbedding.enrich(key, additionalData, { ...options, taskContext: mockTaskContext }))
                .rejects.toThrow('Enrichment service not available');
        });

        test('handles database errors gracefully', async () => {
            const key = 'test-event';
            const additionalData = [{ venue: 'Main Hall' }];
            const options: EnrichmentOptions = {
                schema: testEventSchema
            };

            // Mock database error for get() method
            prismaMock.$queryRawUnsafe.mockRejectedValue(new Error('Database connection failed'));

            const result = await adapter.enrich(key, additionalData, { ...options, taskContext: mockTaskContext });

            expect(result.enrichedData).toBeDefined();
            expect(Array.isArray(result.changes)).toBe(true);
        });
    });

    describe('Integration with entity alignment', () => {
        test('recognition uses entity alignment when available', async () => {
            const inputData = {
                speaker: 'Dr. John Smith',
                venue: 'Main Auditorium'
            };

            const options: RecognitionOptions = {
                entities: { speaker: 'person', venue: 'location' }
            };

            // Mock memory data
            prismaMock.agentMemoryStore.findMany.mockResolvedValue([{
                tenantId: 'default',
                key: 'existing-event',
                value: { speaker: 'John Smith', venue: 'Main Hall' },
                tags: [],
                createdAt: new Date(),
                updatedAt: new Date()
            }]);

            // Mock entity alignment results
            prismaMock.$queryRaw.mockResolvedValue([]);
            prismaMock.entityStore.findMany.mockResolvedValue([]);

            const result = await adapter.recognize(inputData, { ...options, taskContext: mockTaskContext });

            expect(result).toBeDefined();
            expect(prismaMock.$queryRaw).toHaveBeenCalled();
        });

        test('enrichment can use entity-aligned data', async () => {
            const key = 'test-event';
            const additionalData = [
                { speaker: 'Prof. Jane Doe', department: 'Computer Science' }
            ];

            const options: EnrichmentOptions = {
                schema: testEventSchema,
                forceLLMEnrichment: false
            };

            prismaMock.agentMemoryStore.findMany.mockResolvedValue([]);
            prismaMock.$queryRawUnsafe.mockResolvedValue([]);

            const result = await adapter.enrich(key, additionalData, { ...options, taskContext: mockTaskContext });

            expect(result).toBeDefined();
            expect(result.enrichedData).toBeDefined();
            expect(Array.isArray(result.changes)).toBe(true);
        });
    });

    describe('Entity service availability', () => {
        test('adapter with embedding function has entity service', () => {
            expect(adapter.entities).toBeDefined();
            expect(typeof adapter.entities.stats).toBe('function');
        });

        test('adapter without embedding function throws for entity access', () => {
            const adapterWithoutEmbedding = new MemorySQLAdapter(prismaMock);

            expect(() => adapterWithoutEmbedding.entities).toThrow('Entity alignment not available');
        });
    });
}); 