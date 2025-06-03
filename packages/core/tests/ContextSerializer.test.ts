import { describe, it, expect, beforeEach } from '@jest/globals';
import { ContextSerializer } from '../src/core/orchestration/ContextSerializer.js';
import type {
    MinimalSourceTaskContext,
    A2ACallOptions,
    SerializedAgentContext,
    SerializedWorkingMemory,
    SerializedMemoryContext,
    RecalledMemoryItem
} from '../src/shared/types/A2ATypes.js';
import type { TaskContext } from '../src/shared/types/index.js';
import type { ThoughtEntry, DecisionEntry } from '../src/shared/types/workingMemory.js';

describe('ContextSerializer', () => {
    let mockSourceContext: MinimalSourceTaskContext;
    let mockTargetContext: TaskContext;
    let mockOptions: A2ACallOptions;

    beforeEach(() => {
        // Create mock source context
        mockSourceContext = {
            task: { id: 'source-task-123' },
            tenantId: 'test-tenant',
            agentId: 'source-agent',
            getGoal: jest.fn().mockResolvedValue('Test goal'),
            getThoughts: jest.fn().mockResolvedValue([
                { content: 'First thought', timestamp: new Date().toISOString() },
                { content: 'Second thought', timestamp: new Date().toISOString() }
            ] as ThoughtEntry[]),
            recall: jest.fn().mockResolvedValue([
                {
                    id: 'memory-1',
                    type: 'semantic',
                    data: { content: 'Important fact' },
                    metadata: { relevance: 0.9 }
                },
                {
                    id: 'memory-2',
                    type: 'episodic',
                    data: { event: 'Previous interaction' },
                    metadata: { timestamp: '2024-01-01T00:00:00Z' }
                }
            ]),
            memory: {
                mlo: {
                    getAllDecisions: jest.fn().mockResolvedValue({
                        'decision-1': {
                            decision: 'Choose option A',
                            reasoning: 'Best performance',
                            timestamp: new Date().toISOString()
                        } as DecisionEntry
                    })
                }
            },
            vars: {
                counter: 42,
                status: 'active',
                config: { debug: true }
            }
        };

        // Create mock target context
        mockTargetContext = {
            task: { id: 'target-task-456', input: {} },
            tenantId: 'test-tenant',
            agentId: 'target-agent',
            // Working memory operations
            setGoal: jest.fn().mockResolvedValue(undefined),
            getGoal: jest.fn().mockResolvedValue(null),
            addThought: jest.fn().mockResolvedValue(undefined),
            getThoughts: jest.fn().mockResolvedValue([]),
            makeDecision: jest.fn().mockResolvedValue(undefined),
            getDecision: jest.fn().mockResolvedValue(null),
            getAllDecisions: jest.fn().mockResolvedValue({}),
            vars: {},
            recall: jest.fn().mockResolvedValue([]),
            remember: jest.fn().mockResolvedValue(undefined),
            // Other required methods
            reply: jest.fn().mockResolvedValue(undefined),
            progress: jest.fn(),
            complete: jest.fn(),
            fail: jest.fn().mockResolvedValue(undefined),
            recordUsage: jest.fn(),
            llm: {} as any,
            tools: { invoke: jest.fn() },
            memory: {} as any,
            cognitive: {} as any,
            logger: {} as any,
            config: {},
            validate: jest.fn(),
            retry: jest.fn(),
            cache: {} as any,
            emitEvent: jest.fn(),
            updateStatus: jest.fn(),
            services: { get: jest.fn() },
            getEnv: jest.fn(),
            throw: jest.fn().mockImplementation((code: string, message: string) => {
                throw new Error(`[${code}] ${message}`);
            }) as any,
            sendTaskToAgent: jest.fn().mockResolvedValue({})
        };

        mockOptions = {
            inheritWorkingMemory: true,
            inheritMemory: true,
            tenantId: 'test-tenant'
        };
    });

    describe('serializeContext', () => {
        it('should serialize complete context successfully', async () => {
            const result = await ContextSerializer.serializeContext(mockSourceContext, mockOptions);

            expect(result).toMatchObject({
                tenantId: 'test-tenant',
                sourceTaskId: 'source-task-123',
                sourceAgentId: 'source-agent',
                timestamp: expect.any(String)
            });

            expect(result.workingMemory).toBeDefined();
            expect(result.memoryContext).toBeDefined();
        });

        it('should serialize working memory correctly', async () => {
            const result = await ContextSerializer.serializeContext(mockSourceContext, {
                inheritWorkingMemory: true,
                inheritMemory: false
            });

            expect(result.workingMemory).toMatchObject({
                goal: 'Test goal',
                thoughts: [
                    { content: 'First thought' },
                    { content: 'Second thought' }
                ],
                decisions: {
                    'decision-1': {
                        decision: 'Choose option A',
                        reasoning: 'Best performance'
                    }
                },
                variables: {
                    counter: 42,
                    status: 'active',
                    config: { debug: true }
                }
            });

            expect(result.memoryContext).toBeUndefined();
        });

        it('should serialize memory context correctly', async () => {
            const result = await ContextSerializer.serializeContext(mockSourceContext, {
                inheritWorkingMemory: false,
                inheritMemory: true
            });

            expect(result.memoryContext).toMatchObject({
                episodicEventCount: 1,
                memorySnapshot: [
                    {
                        id: 'memory-1',
                        type: 'semantic',
                        data: { content: 'Important fact' }
                    },
                    {
                        id: 'memory-2',
                        type: 'episodic',
                        data: { event: 'Previous interaction' }
                    }
                ]
            });

            expect(result.workingMemory).toBeUndefined();
        });

        it('should handle missing optional methods gracefully', async () => {
            const minimalContext: MinimalSourceTaskContext = {
                task: { id: 'minimal-task' },
                tenantId: 'test-tenant',
                agentId: 'minimal-agent'
            };

            const result = await ContextSerializer.serializeContext(minimalContext, {
                inheritWorkingMemory: true,
                inheritMemory: true
            });

            expect(result.workingMemory).toMatchObject({
                thoughts: [],
                decisions: {},
                variables: {}
            });
            expect(result.workingMemory?.goal).toBeUndefined();
        });

        it('should use provided tenant ID from options', async () => {
            const result = await ContextSerializer.serializeContext(mockSourceContext, {
                ...mockOptions,
                tenantId: 'override-tenant'
            });

            expect(result.tenantId).toBe('override-tenant');
        });
    });

    describe('deserializeContext', () => {
        let serializedContext: SerializedAgentContext;

        beforeEach(() => {
            serializedContext = {
                tenantId: 'test-tenant',
                sourceTaskId: 'source-task-123',
                sourceAgentId: 'source-agent',
                timestamp: new Date().toISOString(),
                workingMemory: {
                    goal: 'Restored goal',
                    thoughts: [
                        { content: 'Restored thought', timestamp: new Date().toISOString() }
                    ] as ThoughtEntry[],
                    decisions: {
                        'restored-decision': {
                            decision: 'Restored choice',
                            reasoning: 'Restored reasoning',
                            timestamp: new Date().toISOString()
                        } as DecisionEntry
                    },
                    variables: {
                        restoredVar: 'value',
                        restoredNum: 123
                    }
                },
                memoryContext: {
                    episodicEventCount: 1,
                    memorySnapshot: [
                        {
                            id: 'restored-memory-1',
                            type: 'semantic',
                            data: { content: 'Restored semantic memory' },
                            metadata: { source: 'transfer' }
                        },
                        {
                            id: 'restored-memory-2',
                            type: 'episodic',
                            data: { event: 'Restored episodic memory' },
                            metadata: { source: 'transfer' }
                        }
                    ] as RecalledMemoryItem[]
                }
            };
        });

        it('should deserialize complete context successfully', async () => {
            await ContextSerializer.deserializeContext(mockTargetContext, serializedContext);

            // Verify working memory restoration
            expect(mockTargetContext.setGoal).toHaveBeenCalledWith('Restored goal');
            expect(mockTargetContext.addThought).toHaveBeenCalledWith('Restored thought');
            expect(mockTargetContext.makeDecision).toHaveBeenCalledWith(
                'restored-decision',
                'Restored choice',
                'Restored reasoning'
            );

            // Verify variables restoration
            expect(mockTargetContext.vars).toMatchObject({
                restoredVar: 'value',
                restoredNum: 123
            });

            // Verify memory restoration
            expect(mockTargetContext.remember).toHaveBeenCalledWith(
                'restored-memory-1',
                { content: 'Restored semantic memory' },
                { type: 'semantic', persist: true }
            );
            expect(mockTargetContext.remember).toHaveBeenCalledWith(
                'restored-memory-2',
                { event: 'Restored episodic memory' },
                { type: 'episodic', persist: true }
            );
        });

        it('should handle working memory only deserialization', async () => {
            const workingMemoryOnly = {
                ...serializedContext,
                memoryContext: undefined
            };

            await ContextSerializer.deserializeContext(mockTargetContext, workingMemoryOnly);

            expect(mockTargetContext.setGoal).toHaveBeenCalled();
            expect(mockTargetContext.remember).not.toHaveBeenCalled();
        });

        it('should handle memory context only deserialization', async () => {
            const memoryContextOnly = {
                ...serializedContext,
                workingMemory: undefined
            };

            await ContextSerializer.deserializeContext(mockTargetContext, memoryContextOnly);

            expect(mockTargetContext.setGoal).not.toHaveBeenCalled();
            expect(mockTargetContext.remember).toHaveBeenCalled();
        });

        it('should handle missing target context methods gracefully', async () => {
            const limitedTargetContext = {
                ...mockTargetContext,
                setGoal: undefined,
                addThought: undefined,
                makeDecision: undefined,
                remember: undefined
            } as any; // Type assertion for test purposes

            // Should not throw even if methods are missing
            await expect(
                ContextSerializer.deserializeContext(limitedTargetContext, serializedContext)
            ).resolves.not.toThrow();
        });

        it('should filter non-semantic/episodic memory types', async () => {
            const contextWithMixedTypes = {
                ...serializedContext,
                memoryContext: {
                    episodicEventCount: 1,
                    memorySnapshot: [
                        {
                            id: 'semantic-memory',
                            type: 'semantic',
                            data: { content: 'Semantic data' }
                        },
                        {
                            id: 'custom-memory',
                            type: 'custom',
                            data: { content: 'Custom data' }
                        }
                    ] as RecalledMemoryItem[]
                }
            };

            await ContextSerializer.deserializeContext(mockTargetContext, contextWithMixedTypes);

            // Should call remember for semantic type
            expect(mockTargetContext.remember).toHaveBeenCalledWith(
                'semantic-memory',
                { content: 'Semantic data' },
                { type: 'semantic', persist: true }
            );

            // Should call remember for custom type but with undefined type
            expect(mockTargetContext.remember).toHaveBeenCalledWith(
                'custom-memory',
                { content: 'Custom data' },
                { type: undefined, persist: true }
            );
        });
    });

    describe('error handling', () => {
        it('should handle serialization errors gracefully', async () => {
            const faultyContext = {
                ...mockSourceContext,
                getGoal: jest.fn().mockRejectedValue(new Error('Goal retrieval failed'))
            };

            await expect(
                ContextSerializer.serializeContext(faultyContext, mockOptions)
            ).rejects.toThrow('Goal retrieval failed');
        });

        it('should handle deserialization errors gracefully', async () => {
            const faultyTargetContext = {
                ...mockTargetContext,
                setGoal: jest.fn().mockRejectedValue(new Error('Goal setting failed'))
            };

            const serializedContext: SerializedAgentContext = {
                tenantId: 'test-tenant',
                sourceTaskId: 'source-task-123',
                sourceAgentId: 'source-agent',
                timestamp: new Date().toISOString(),
                workingMemory: {
                    goal: 'Test goal',
                    thoughts: [],
                    decisions: {},
                    variables: {}
                }
            };

            await expect(
                ContextSerializer.deserializeContext(faultyTargetContext, serializedContext)
            ).rejects.toThrow('Goal setting failed');
        });
    });
}); 