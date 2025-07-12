import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { MemorySQLAdapter } from '../src/MemorySQLAdapter.js';
import { prismaMock } from './__mocks__/prisma.js';
import type { RecognitionOptions, EnrichmentOptions } from '@callagent/types';

describe('MemorySQLAdapter - LLM Integration', () => {
    let adapter: MemorySQLAdapter;
    let mockEmbedFunction: jest.MockedFunction<(text: string) => Promise<number[]>>;
    let mockTaskContext: any;

    beforeEach(() => {
        mockEmbedFunction = jest.fn<(text: string) => Promise<number[]>>().mockResolvedValue([0.1, 0.2, 0.3]);

        // Create a realistic mock TaskContext with LLM
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
            },
            getGoal: jest.fn() as any
        } as any;

        adapter = new MemorySQLAdapter(prismaMock, mockEmbedFunction);
        jest.clearAllMocks();
    });

    describe('LLM-powered recognition', () => {
        test('uses LLM for disambiguation when confidence is uncertain', async () => {
            const candidateData = {
                title: 'ML Workshop 2024',
                speaker: 'Dr. John Smith',
                venue: 'Tech Center'
            };

            const options: RecognitionOptions = {
                entities: { title: 'event', speaker: 'person', venue: 'location' },
                threshold: 0.75,
                llmLowerBound: 0.65,
                llmUpperBound: 0.85
            };

            // Mock LLM response for disambiguation
            mockTaskContext.llm.call.mockResolvedValue([{
                content: JSON.stringify({
                    isMatch: true,
                    confidence: 0.85,
                    reasoning: 'The events have different titles but same speaker and venue, likely the same event with updated title.'
                }),
                isComplete: true
            }]);

            // Mock entity queries to return data that would score around 0.7 (uncertain confidence)
            prismaMock.agentMemoryStore.findMany.mockResolvedValue([{
                tenantId: 'default',
                key: 'similar-workshop',
                value: {
                    title: 'Machine Learning Training',  // Similar but different title
                    speaker: 'Dr. John Smith',          // Same speaker
                    venue: 'Tech Center'                // Same venue
                },
                tags: ['event'],
                createdAt: new Date(),
                updatedAt: new Date()
            }]);

            // Mock entity alignment to return medium confidence alignments
            prismaMock.$queryRaw.mockResolvedValue([]);
            prismaMock.entityStore.findMany.mockResolvedValue([]);
            prismaMock.$queryRawUnsafe.mockResolvedValue([]);
            prismaMock.entityAlignment.findMany.mockResolvedValue([]);

            const result = await adapter.recognize(candidateData, { ...options, taskContext: mockTaskContext });

            // Verify LLM was called for disambiguation
            expect(mockTaskContext.llm.call).toHaveBeenCalled();
            expect(result.usedLLM).toBe(true);
            expect(result.isMatch).toBe(true);
            expect(result.confidence).toBe(0.85); // From LLM response
            expect(result.explanation).toContain('same event');
        });

        test('LLM prompt includes relevant context', async () => {
            const candidateData = {
                title: 'Conference 2024',
                speaker: 'Jane Doe'
            };

            // Setup mocks for uncertain confidence scenario
            prismaMock.agentMemoryStore.findMany.mockResolvedValue([{
                tenantId: 'default',
                key: 'existing-conference',
                value: { title: 'Annual Conference', speaker: 'Jane Doe' },
                tags: [],
                createdAt: new Date(),
                updatedAt: new Date()
            }]);

            prismaMock.$queryRaw.mockResolvedValue([]);
            prismaMock.entityStore.findMany.mockResolvedValue([]);
            prismaMock.$queryRawUnsafe.mockResolvedValue([]);
            prismaMock.entityAlignment.findMany.mockResolvedValue([]);

            await adapter.recognize(candidateData, {
                entities: { title: 'event', speaker: 'person' },
                threshold: 0.8, // High threshold to force LLM usage
                taskContext: mockTaskContext
            });

            // Check that LLM was called with a comprehensive prompt
            expect(mockTaskContext.llm.call).toHaveBeenCalled();
            const callArgs = mockTaskContext.llm.call.mock.calls[0];
            const prompt = callArgs[0];

            expect(prompt).toContain('OBJECT 1 (Candidate)');
            expect(prompt).toContain('OBJECT 2 (Existing)');
            expect(prompt).toContain('Conference 2024');
            expect(prompt).toContain('Annual Conference');
            expect(prompt).toContain('Jane Doe');
        });
    });

    describe('LLM-powered enrichment', () => {
        test('uses LLM for complex data consolidation', async () => {
            const key = 'workshop-event';
            const additionalData = [
                { duration: '4 hours', level: 'intermediate' },
                { duration: '3 hours', materials: ['laptop', 'notes'] }, // Conflict in duration
                { price: '$75', registration: 'required' }
            ];

            // Mock LLM response for enrichment
            mockTaskContext.llm.call.mockResolvedValue([{
                content: JSON.stringify({
                    enrichedData: {
                        duration: '4 hours', // LLM chose 4 hours over 3 hours
                        level: 'intermediate',
                        materials: ['laptop', 'notes'],
                        price: '$75',
                        registration: 'required'
                    },
                    changes: [
                        { field: 'duration', action: 'resolved_conflict', newValue: '4 hours', source: 'llm' },
                        { field: 'level', action: 'added', newValue: 'intermediate', source: 'llm' },
                        { field: 'materials', action: 'added', newValue: ['laptop', 'notes'], source: 'llm' },
                        { field: 'price', action: 'added', newValue: '$75', source: 'llm' },
                        { field: 'registration', action: 'added', newValue: 'required', source: 'llm' }
                    ],
                    explanation: 'Resolved duration conflict by choosing the longer time, which is more typical for intermediate workshops.'
                }),
                isComplete: true
            }]);

            // Mock existing memory data
            prismaMock.$queryRawUnsafe.mockResolvedValue([{
                key: 'workshop-event',
                value: { title: 'JavaScript Workshop', instructor: 'Sarah Johnson' },
                tags: [],
                created_at: new Date(),
                updated_at: new Date()
            }]);

            const result = await adapter.enrich(key, additionalData, {
                forceLLMEnrichment: true, // Force LLM usage
                taskContext: mockTaskContext
            });

            // Verify LLM was used
            expect(mockTaskContext.llm.call).toHaveBeenCalled();
            expect(result.usedLLM).toBe(true);
            expect(result.enrichedData.duration).toBe('4 hours');
            expect(result.changes).toHaveLength(5);
            expect(result.explanation).toContain('Resolved duration conflict');
        });

        test('LLM enrichment prompt includes all relevant data', async () => {
            const key = 'test-memory';
            const additionalData = [
                { field1: 'value1', field2: 'value2' },
                { field1: 'conflicting_value', field3: 'value3' }
            ];

            // Mock existing data
            prismaMock.$queryRawUnsafe.mockResolvedValue([{
                key: 'test-memory',
                value: { original: 'data' },
                tags: [],
                created_at: new Date(),
                updated_at: new Date()
            }]);

            await adapter.enrich(key, additionalData, {
                forceLLMEnrichment: true,
                focusFields: ['field1', 'field2'],
                taskContext: mockTaskContext
            });

            // Verify LLM prompt includes all the data
            expect(mockTaskContext.llm.call).toHaveBeenCalled();
            const prompt = mockTaskContext.llm.call.mock.calls[0][0];

            expect(prompt).toContain('BASE DATA (existing)');
            expect(prompt).toContain('ADDITIONAL DATA SOURCES');
            expect(prompt).toContain('Source 1:');
            expect(prompt).toContain('Source 2:');
            expect(prompt).toContain('FOCUS FIELDS: Pay special attention to these fields: field1, field2');
            expect(prompt).toContain('conflicting_value');
        });
    });

    describe('LLM error handling', () => {
        test('recognition handles LLM failures gracefully', async () => {
            const candidateData = { title: 'Test Event' };

            // Mock LLM to throw an error
            mockTaskContext.llm.call.mockRejectedValue(new Error('LLM API unavailable'));

            // Setup for uncertain confidence to trigger LLM
            prismaMock.agentMemoryStore.findMany.mockResolvedValue([{
                tenantId: 'default',
                key: 'test-event',
                value: { title: 'Similar Event' },
                tags: [],
                createdAt: new Date(),
                updatedAt: new Date()
            }]);

            prismaMock.$queryRaw.mockResolvedValue([]);
            prismaMock.entityStore.findMany.mockResolvedValue([]);
            prismaMock.$queryRawUnsafe.mockResolvedValue([]);
            prismaMock.entityAlignment.findMany.mockResolvedValue([]);

            const result = await adapter.recognize(candidateData, {
                entities: { title: 'event' },
                threshold: 0.9, // High threshold to force LLM
                taskContext: mockTaskContext
            });

            // Should fallback gracefully
            expect(result).toBeDefined();
            expect(result.usedLLM).toBe(true);
            expect(result.explanation).toContain('failed');
        });

        test('enrichment handles LLM failures gracefully', async () => {
            const key = 'test-key';
            const additionalData = [{ field: 'value' }];

            // Mock LLM to throw an error
            mockTaskContext.llm.call.mockRejectedValue(new Error('LLM timeout'));

            // Mock existing data
            prismaMock.$queryRawUnsafe.mockResolvedValue([{
                key: 'test-key',
                value: { original: 'data' },
                tags: [],
                created_at: new Date(),
                updated_at: new Date()
            }]);

            const result = await adapter.enrich(key, additionalData, {
                forceLLMEnrichment: true, // Force LLM path
                taskContext: mockTaskContext
            });

            // Should fallback to original data
            expect(result).toBeDefined();
            expect(result.usedLLM).toBe(true);
            expect(result.explanation).toContain('failed');
        });
    });

    describe('LLM configuration validation', () => {
        test('works without LLM when confidence is high', async () => {
            const candidateData = { title: 'Exact Match Event', speaker: 'John Smith' };

            // Mock exact match scenario
            prismaMock.agentMemoryStore.findMany.mockResolvedValue([{
                tenantId: 'default',
                key: 'exact-event',
                value: { title: 'Exact Match Event', speaker: 'John Smith' },
                tags: [],
                createdAt: new Date(),
                updatedAt: new Date()
            }]);

            prismaMock.$queryRaw.mockResolvedValue([]);
            prismaMock.entityStore.findMany.mockResolvedValue([]);
            prismaMock.$queryRawUnsafe.mockResolvedValue([]);
            prismaMock.entityAlignment.findMany.mockResolvedValue([]);

            const result = await adapter.recognize(candidateData, {
                entities: { title: 'event', speaker: 'person' },
                threshold: 0.75,
                taskContext: mockTaskContext
            });

            // Should not use LLM for high confidence matches
            expect(mockTaskContext.llm.call).not.toHaveBeenCalled();
            expect(result.usedLLM).toBe(false);
            expect(result.isMatch).toBe(true);
        });
    });
}); 