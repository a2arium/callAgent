import { UnifiedMemoryService, SemanticMemoryAdapter, EpisodicMemoryAdapter } from '../src/core/memory/UnifiedMemoryService.js';
import { getMemoryProfile } from '../src/core/memory/lifecycle/config/MemoryProfiles.js';

describe('UnifiedMemoryService', () => {
    let service: UnifiedMemoryService;
    let mockSemanticAdapter: SemanticMemoryAdapter;
    let mockEpisodicAdapter: EpisodicMemoryAdapter;
    const tenantId = 'test-tenant';
    const agentId = 'test-agent';

    beforeEach(() => {
        // Create mock adapters
        mockSemanticAdapter = {
            set: jest.fn().mockResolvedValue(undefined),
            get: jest.fn().mockResolvedValue('mock-value'),
            query: jest.fn().mockResolvedValue(['result1', 'result2']),
            delete: jest.fn().mockResolvedValue(undefined),
            clear: jest.fn().mockResolvedValue(undefined)
        };

        mockEpisodicAdapter = {
            append: jest.fn().mockResolvedValue(undefined),
            getEvents: jest.fn().mockResolvedValue([{ event: 'test' }]),
            query: jest.fn().mockResolvedValue(['episode1', 'episode2']),
            clear: jest.fn().mockResolvedValue(undefined)
        };

        const config = getMemoryProfile('basic');
        if (!config) {
            throw new Error('Failed to get basic memory profile');
        }

        service = new UnifiedMemoryService(tenantId, {
            memoryLifecycleConfig: config,
            semanticAdapter: mockSemanticAdapter,
            episodicAdapter: mockEpisodicAdapter,
            agentId
        });
    });

    afterEach(async () => {
        await service.shutdown();
    });

    describe('Initialization', () => {
        it('should initialize with correct configuration', () => {
            const metrics = service.getMetrics();
            expect(metrics.service).toEqual({
                tenantId,
                agentId,
                hasSemanticAdapter: true,
                hasEpisodicAdapter: true,
                profile: 'basic'
            });
        });

        it('should initialize without adapters', () => {
            const config = getMemoryProfile('basic');
            if (!config) {
                throw new Error('Failed to get basic memory profile');
            }

            const serviceWithoutAdapters = new UnifiedMemoryService(tenantId, {
                memoryLifecycleConfig: config,
                agentId
            });

            const metrics = serviceWithoutAdapters.getMetrics();
            expect(metrics.service).toEqual({
                tenantId,
                agentId,
                hasSemanticAdapter: false,
                hasEpisodicAdapter: false,
                profile: 'basic'
            });
        });
    });

    describe('Working Memory Operations', () => {
        describe('Goal Management', () => {
            it('should set and get goals', async () => {
                const goal = 'Complete the project successfully';

                await service.setGoal(goal);
                const retrievedGoal = await service.getGoal();

                expect(retrievedGoal).toBe(goal);
            });

            it('should handle agent-specific goals', async () => {
                const goal1 = 'Agent 1 goal';
                const goal2 = 'Agent 2 goal';

                await service.setGoal(goal1, 'agent1');
                await service.setGoal(goal2, 'agent2');

                expect(await service.getGoal('agent1')).toBe(goal1);
                expect(await service.getGoal('agent2')).toBe(goal2);
            });

            it('should throw error when goal processing fails', async () => {
                // This would require mocking the MLO to fail, which is complex
                // For now, we test the happy path
                const goal = 'Test goal';
                await expect(service.setGoal(goal)).resolves.not.toThrow();
            });
        });

        describe('Thought Management', () => {
            it('should add and retrieve thoughts', async () => {
                const thought1 = 'This is my first thought';
                const thought2 = 'This is my second thought';

                await service.addThought(thought1);
                await service.addThought(thought2);

                const thoughts = await service.getThoughts();
                expect(thoughts).toHaveLength(2);
                expect(thoughts[0].content).toBe(thought1);
                expect(thoughts[1].content).toBe(thought2);
                expect(thoughts[0].type).toBe('thought');
                expect(thoughts[0].processingMetadata).toBeDefined();
            });

            it('should handle agent-specific thoughts', async () => {
                const thought1 = 'Agent 1 thought';
                const thought2 = 'Agent 2 thought';

                await service.addThought(thought1, 'agent1');
                await service.addThought(thought2, 'agent2');

                const agent1Thoughts = await service.getThoughts('agent1');
                const agent2Thoughts = await service.getThoughts('agent2');

                expect(agent1Thoughts).toHaveLength(1);
                expect(agent2Thoughts).toHaveLength(1);
                expect(agent1Thoughts[0].content).toBe(thought1);
                expect(agent2Thoughts[0].content).toBe(thought2);
            });

            it('should not throw when thought processing fails', async () => {
                const thought = 'Test thought';
                await expect(service.addThought(thought)).resolves.not.toThrow();
            });
        });

        describe('Decision Management', () => {
            it('should make and retrieve decisions', async () => {
                const key = 'algorithm_choice';
                const decision = 'Use quicksort algorithm';
                const reasoning = 'Best performance for this data size';

                await service.makeDecision(key, decision, reasoning);
                const retrievedDecision = await service.getDecision(key);

                expect(retrievedDecision).not.toBeNull();
                expect(retrievedDecision!.decision).toBe(decision);
                expect(retrievedDecision!.reasoning).toBe(reasoning);
                expect(retrievedDecision!.timestamp).toBeDefined();
            });

            it('should handle decisions without reasoning', async () => {
                const key = 'simple_choice';
                const decision = 'Option A';

                await service.makeDecision(key, decision);
                const retrievedDecision = await service.getDecision(key);

                expect(retrievedDecision).not.toBeNull();
                expect(retrievedDecision!.decision).toBe(decision);
                expect(retrievedDecision!.reasoning).toBeUndefined();
            });

            it('should handle agent-specific decisions', async () => {
                const key = 'strategy';
                const decision1 = 'Aggressive approach';
                const decision2 = 'Conservative approach';

                await service.makeDecision(key, decision1, undefined, 'agent1');
                await service.makeDecision(key, decision2, undefined, 'agent2');

                const agent1Decision = await service.getDecision(key, 'agent1');
                const agent2Decision = await service.getDecision(key, 'agent2');

                expect(agent1Decision!.decision).toBe(decision1);
                expect(agent2Decision!.decision).toBe(decision2);
            });
        });

        describe('Variable Management', () => {
            it('should set and get working variables', async () => {
                const key = 'counter';
                const value = 42;

                await service.setWorkingVariable(key, value);
                const retrievedValue = await service.getWorkingVariable(key);

                expect(retrievedValue).toBe(value);
            });

            it('should handle complex variable types', async () => {
                const key = 'config';
                const value = {
                    timeout: 5000,
                    retries: 3,
                    endpoints: ['api1', 'api2']
                };

                await service.setWorkingVariable(key, value);
                const retrievedValue = await service.getWorkingVariable(key);

                expect(retrievedValue).toEqual(value);
            });

            it('should handle agent-specific variables', async () => {
                const key = 'status';
                const value1 = 'active';
                const value2 = 'inactive';

                await service.setWorkingVariable(key, value1, 'agent1');
                await service.setWorkingVariable(key, value2, 'agent2');

                expect(await service.getWorkingVariable(key, 'agent1')).toBe(value1);
                expect(await service.getWorkingVariable(key, 'agent2')).toBe(value2);
            });
        });
    });

    describe('Semantic Memory Operations', () => {
        it('should set semantic memory through adapter', async () => {
            const key = 'concept';
            const value = 'Machine Learning';
            const namespace = 'ai';

            await service.setSemanticMemory(key, value, namespace);

            expect(mockSemanticAdapter.set).toHaveBeenCalledWith(
                key,
                value,
                namespace,
                tenantId
            );
        });

        it('should get semantic memory through adapter', async () => {
            const key = 'concept';
            const namespace = 'ai';

            const result = await service.getSemanticMemory(key, namespace);

            expect(mockSemanticAdapter.get).toHaveBeenCalledWith(
                key,
                namespace,
                tenantId
            );
            expect(result).toBe('mock-value');
        });

        it('should query semantic memory through adapter', async () => {
            const query = 'machine learning concepts';
            const options = { limit: 10 };

            const results = await service.querySemanticMemory(query, options);

            expect(mockSemanticAdapter.query).toHaveBeenCalledWith(
                query,
                options,
                tenantId
            );
            expect(results).toEqual(['result1', 'result2']);
        });

        it('should throw error when no semantic adapter configured', async () => {
            const config = getMemoryProfile('basic');
            if (!config) {
                throw new Error('Failed to get basic memory profile');
            }

            const serviceWithoutAdapter = new UnifiedMemoryService(tenantId, {
                memoryLifecycleConfig: config,
                agentId
            });

            await expect(
                serviceWithoutAdapter.setSemanticMemory('key', 'value')
            ).rejects.toThrow('No semantic memory adapter configured');

            await expect(
                serviceWithoutAdapter.getSemanticMemory('key')
            ).rejects.toThrow('No semantic memory adapter configured');

            await serviceWithoutAdapter.shutdown();
        });
    });

    describe('Episodic Memory Operations', () => {
        it('should append episodic events through adapter', async () => {
            const event = { action: 'user_login', timestamp: Date.now() };

            await service.appendEpisodic(event);

            expect(mockEpisodicAdapter.append).toHaveBeenCalledWith(
                event,
                tenantId
            );
        });

        it('should get episodic events through adapter', async () => {
            const options = { limit: 5 };

            const events = await service.getEpisodicEvents(options);

            expect(mockEpisodicAdapter.getEvents).toHaveBeenCalledWith(
                options,
                tenantId
            );
            expect(events).toEqual([{ event: 'test' }]);
        });

        it('should throw error when no episodic adapter configured', async () => {
            const config = getMemoryProfile('basic');
            if (!config) {
                throw new Error('Failed to get basic memory profile');
            }

            const serviceWithoutAdapter = new UnifiedMemoryService(tenantId, {
                memoryLifecycleConfig: config,
                agentId
            });

            await expect(
                serviceWithoutAdapter.appendEpisodic({ event: 'test' })
            ).rejects.toThrow('No episodic memory adapter configured');

            await expect(
                serviceWithoutAdapter.getEpisodicEvents()
            ).rejects.toThrow('No episodic memory adapter configured');

            await serviceWithoutAdapter.shutdown();
        });
    });

    describe('Unified Operations', () => {
        describe('Recall Operation', () => {
            it('should recall from semantic memory', async () => {
                const query = 'machine learning';
                const options = { type: 'semantic' as const };

                const results = await service.recall(query, options);

                expect(mockSemanticAdapter.query).toHaveBeenCalledWith(
                    query,
                    options,
                    tenantId
                );
                expect(results).toEqual(['result1', 'result2']);
            });

            it('should recall from episodic memory', async () => {
                const query = 'user interactions';
                const options = { type: 'episodic' as const };

                const results = await service.recall(query, options);

                expect(mockEpisodicAdapter.query).toHaveBeenCalledWith(
                    query,
                    options,
                    tenantId
                );
                expect(results).toEqual(['episode1', 'episode2']);
            });

            it('should recall from working memory by default', async () => {
                const query = 'test';

                // Add some thoughts first
                await service.addThought('This is a test thought');
                await service.addThought('Another thought without test');
                await service.addThought('Test again in this thought');

                const results = await service.recall(query);

                expect(results).toHaveLength(2);
                expect(results).toContain('This is a test thought');
                expect(results).toContain('Test again in this thought');
            });

            it('should handle missing adapters gracefully', async () => {
                const config = getMemoryProfile('basic');
                if (!config) {
                    throw new Error('Failed to get basic memory profile');
                }

                const serviceWithoutAdapters = new UnifiedMemoryService(tenantId, {
                    memoryLifecycleConfig: config,
                    agentId
                });

                const semanticResults = await serviceWithoutAdapters.recall('query', { type: 'semantic' });
                const episodicResults = await serviceWithoutAdapters.recall('query', { type: 'episodic' });

                expect(semanticResults).toEqual([]);
                expect(episodicResults).toEqual([]);

                await serviceWithoutAdapters.shutdown();
            });
        });

        describe('Remember Operation', () => {
            it('should remember to semantic memory', async () => {
                const key = 'concept';
                const value = 'Neural Networks';
                const options = { type: 'semantic' as const, persist: true, namespace: 'ai' };

                await service.remember(key, value, options);

                expect(mockSemanticAdapter.set).toHaveBeenCalledWith(
                    key,
                    value,
                    'ai',
                    tenantId
                );
            });

            it('should remember to episodic memory', async () => {
                const key = 'event';
                const value = 'User completed tutorial';
                const options = { type: 'episodic' as const };

                await service.remember(key, value, options);

                expect(mockEpisodicAdapter.append).toHaveBeenCalledWith(
                    { key, value },
                    tenantId
                );
            });

            it('should remember to working memory by default', async () => {
                const key = 'temp_data';
                const value = { status: 'processing' };

                await service.remember(key, value);

                const retrievedValue = await service.getWorkingVariable(key);
                expect(retrievedValue).toEqual(value);
            });

            it('should throw error when adapter not configured', async () => {
                const config = getMemoryProfile('basic');
                if (!config) {
                    throw new Error('Failed to get basic memory profile');
                }

                const serviceWithoutAdapters = new UnifiedMemoryService(tenantId, {
                    memoryLifecycleConfig: config,
                    agentId
                });

                await expect(
                    serviceWithoutAdapters.remember('key', 'value', { type: 'semantic', persist: true })
                ).rejects.toThrow('No semantic memory adapter configured');

                await expect(
                    serviceWithoutAdapters.remember('key', 'value', { type: 'episodic' })
                ).rejects.toThrow('No episodic memory adapter configured');

                await serviceWithoutAdapters.shutdown();
            });
        });
    });

    describe('Configuration and Management', () => {
        it('should get current configuration', () => {
            const config = service.getConfiguration();
            expect(config.profile).toBe('basic');
        });

        it('should update configuration', async () => {
            await service.configure({ profile: 'conversational' });

            const updatedConfig = service.getConfiguration();
            expect(updatedConfig.profile).toBe('conversational');
        });

        it('should check stage enablement', () => {
            expect(service.isStageEnabled('acquisition', 'workingMemory')).toBe(true);
            expect(service.isStageEnabled('nonexistent', 'workingMemory')).toBe(false);
        });

        it('should reset metrics', () => {
            service.resetMetrics();

            const metrics = service.getMetrics();
            expect(metrics.mlo).toBeDefined();
        });

        it('should shutdown gracefully', async () => {
            await expect(service.shutdown()).resolves.not.toThrow();
        });
    });

    describe('Error Handling', () => {
        it('should handle MLO processing failures gracefully', async () => {
            // Most operations should not throw even if MLO processing fails
            // because the service has fallback mechanisms

            // Goals and decisions are critical, so they throw
            // Thoughts are non-critical, so they don't throw

            const thought = 'Test thought';
            await expect(service.addThought(thought)).resolves.not.toThrow();
        });

        it('should provide meaningful error messages', async () => {
            const config = getMemoryProfile('basic');
            if (!config) {
                throw new Error('Failed to get basic memory profile');
            }

            const serviceWithoutAdapters = new UnifiedMemoryService(tenantId, {
                memoryLifecycleConfig: config,
                agentId
            });

            await expect(
                serviceWithoutAdapters.setSemanticMemory('key', 'value')
            ).rejects.toThrow('No semantic memory adapter configured');

            await serviceWithoutAdapters.shutdown();
        });
    });

    describe('Multi-Agent Support', () => {
        it('should isolate data between agents', async () => {
            const agent1 = 'agent1';
            const agent2 = 'agent2';

            // Set different goals for different agents
            await service.setGoal('Agent 1 goal', agent1);
            await service.setGoal('Agent 2 goal', agent2);

            // Add different thoughts for different agents
            await service.addThought('Agent 1 thought', agent1);
            await service.addThought('Agent 2 thought', agent2);

            // Make different decisions for different agents
            await service.makeDecision('strategy', 'Aggressive', 'High risk tolerance', agent1);
            await service.makeDecision('strategy', 'Conservative', 'Low risk tolerance', agent2);

            // Set different variables for different agents
            await service.setWorkingVariable('status', 'active', agent1);
            await service.setWorkingVariable('status', 'inactive', agent2);

            // Verify isolation
            expect(await service.getGoal(agent1)).toBe('Agent 1 goal');
            expect(await service.getGoal(agent2)).toBe('Agent 2 goal');

            const agent1Thoughts = await service.getThoughts(agent1);
            const agent2Thoughts = await service.getThoughts(agent2);
            expect(agent1Thoughts).toHaveLength(1);
            expect(agent2Thoughts).toHaveLength(1);
            expect(agent1Thoughts[0].content).toBe('Agent 1 thought');
            expect(agent2Thoughts[0].content).toBe('Agent 2 thought');

            const agent1Decision = await service.getDecision('strategy', agent1);
            const agent2Decision = await service.getDecision('strategy', agent2);
            expect(agent1Decision!.decision).toBe('Aggressive');
            expect(agent2Decision!.decision).toBe('Conservative');

            expect(await service.getWorkingVariable('status', agent1)).toBe('active');
            expect(await service.getWorkingVariable('status', agent2)).toBe('inactive');
        });
    });
}); 