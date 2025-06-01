import { MemoryLifecycleOrchestrator } from '../src/core/memory/lifecycle/orchestrator/MemoryLifecycleOrchestrator.js';
import { MemoryLifecycleConfig } from '../src/core/memory/lifecycle/config/types.js';
import { getMemoryProfile } from '../src/core/memory/lifecycle/config/MemoryProfiles.js';
import { createMemoryItem } from '../src/shared/types/memoryLifecycle.js';

describe('MemoryLifecycleOrchestrator', () => {
    let orchestrator: MemoryLifecycleOrchestrator;
    let config: MemoryLifecycleConfig;
    const tenantId = 'test-tenant';
    const agentId = 'test-agent';

    beforeEach(() => {
        const profileConfig = getMemoryProfile('basic');
        if (!profileConfig) {
            throw new Error('Failed to get basic memory profile');
        }
        config = profileConfig;
        orchestrator = new MemoryLifecycleOrchestrator(config, tenantId, agentId);
    });

    afterEach(async () => {
        await orchestrator.shutdown();
    });

    describe('Initialization', () => {
        it('should create orchestrator with correct properties', () => {
            expect(orchestrator.tenantId).toBe(tenantId);
            expect(orchestrator.agentId).toBe(agentId);
            expect(orchestrator.config).toBe(config);
        });

        it('should initialize with basic profile configuration', () => {
            const retrievedConfig = orchestrator.getConfiguration();
            expect(retrievedConfig.profile).toBe('basic');
            expect(retrievedConfig.global?.monitoring?.enableMetrics).toBeDefined();
        });

        it('should have initial metrics', () => {
            const metrics = orchestrator.getMetrics();
            expect(metrics.totalItemsProcessed).toBe(0);
            expect(metrics.totalItemsDropped).toBe(0);
            expect(metrics.averageProcessingTimeMs).toBe(0);
            expect(Object.keys(metrics.stageMetrics)).toHaveLength(0);
        });
    });

    describe('Memory Item Processing', () => {
        it('should process working memory items', async () => {
            const item = createMemoryItem(
                'Test working memory content',
                'workingMemory',
                'test',
                tenantId,
                agentId
            );

            const result = await orchestrator.processMemoryItem(item, 'workingMemory');

            expect(result.success).toBe(true);
            expect(result.processedItems).toHaveLength(1);
            expect(result.targetStore).toBe('workingMemory');
            expect(result.metadata?.processingTimeMs).toBeGreaterThan(0);
        });

        it('should process semantic LTM items', async () => {
            const item = createMemoryItem(
                { concept: 'test concept', definition: 'test definition' },
                'semanticLTM',
                'test',
                tenantId,
                agentId
            );

            const result = await orchestrator.processMemoryItem(item, 'semanticLTM');

            expect(result.success).toBe(true);
            expect(result.processedItems).toHaveLength(1);
            expect(result.targetStore).toBe('semanticLTM');
        });

        it('should process episodic LTM items', async () => {
            const item = createMemoryItem(
                'Test episodic memory event',
                'episodicLTM',
                'test',
                tenantId,
                agentId
            );

            const result = await orchestrator.processMemoryItem(item, 'episodicLTM');

            expect(result.success).toBe(true);
            expect(result.processedItems).toHaveLength(1);
            expect(result.targetStore).toBe('episodicLTM');
        });

        it('should process retrieval items', async () => {
            const item = createMemoryItem(
                'Test query',
                'retrieval',
                'test',
                tenantId,
                agentId
            );

            const result = await orchestrator.processMemoryItem(item, 'retrieval');

            expect(result.success).toBe(true);
            expect(result.processedItems).toHaveLength(1);
            expect(result.targetStore).toBe('queryResult');
        });

        it('should add processing history to items', async () => {
            const item = createMemoryItem(
                'Test content',
                'workingMemory',
                'test',
                tenantId,
                agentId
            );

            const result = await orchestrator.processMemoryItem(item, 'workingMemory');

            expect(result.success).toBe(true);
            const processedItem = result.processedItems[0];
            expect(processedItem.metadata.processingHistory).toBeDefined();
            expect(processedItem.metadata.processingHistory.length).toBeGreaterThan(0);
        });
    });

    describe('Remember Operation', () => {
        it('should remember semantic content', async () => {
            const content = 'Important semantic information';
            const options = { type: 'semantic' as const };

            const result = await orchestrator.remember(content, options);

            expect(result.success).toBe(true);
            expect(result.processedItems).toHaveLength(1);
            expect(result.processedItems[0].data).toBe(content);
            expect(result.processedItems[0].intent).toBe('semanticLTM');
        });

        it('should remember episodic content', async () => {
            const content = 'Important episodic event';
            const options = { type: 'episodic' as const };

            const result = await orchestrator.remember(content, options);

            expect(result.success).toBe(true);
            expect(result.processedItems).toHaveLength(1);
            expect(result.processedItems[0].data).toBe(content);
            expect(result.processedItems[0].intent).toBe('episodicLTM');
        });

        it('should handle complex object content', async () => {
            const content = {
                type: 'concept',
                name: 'Machine Learning',
                properties: ['supervised', 'unsupervised', 'reinforcement']
            };
            const options = { type: 'semantic' as const };

            const result = await orchestrator.remember(content, options);

            expect(result.success).toBe(true);
            expect(result.processedItems[0].data).toEqual(content);
            expect(result.processedItems[0].dataType).toBe('json');
        });
    });

    describe('Recall Operation', () => {
        it('should recall with semantic query', async () => {
            const query = 'machine learning concepts';
            const options = { type: 'semantic' as const };

            const results = await orchestrator.recall(query, options);

            expect(Array.isArray(results)).toBe(true);
            // Note: In Phase 1, this returns processed query items, not actual recalled memories
        });

        it('should recall with episodic query', async () => {
            const query = 'recent conversations about AI';
            const options = { type: 'episodic' as const };

            const results = await orchestrator.recall(query, options);

            expect(Array.isArray(results)).toBe(true);
        });

        it('should handle empty recall results gracefully', async () => {
            const query = 'non-existent content';
            const options = { type: 'semantic' as const };

            const results = await orchestrator.recall(query, options);

            expect(Array.isArray(results)).toBe(true);
        });
    });

    describe('Configuration Management', () => {
        it('should allow configuration updates', async () => {
            const newConfig = {
                profile: 'conversational' as const
            };

            await orchestrator.configure(newConfig);

            const updatedConfig = orchestrator.getConfiguration();
            expect(updatedConfig.profile).toBe('conversational');
        });

        it('should reinitialize processors after configuration change', async () => {
            const initialMetrics = orchestrator.getMetrics();

            await orchestrator.configure({ profile: 'conversational' });

            // Metrics should be preserved but processors reinitialized
            const newMetrics = orchestrator.getMetrics();
            expect(newMetrics.totalItemsProcessed).toBe(initialMetrics.totalItemsProcessed);
        });
    });

    describe('Stage Management', () => {
        it('should check if stages are enabled', () => {
            expect(orchestrator.isStageEnabled('acquisition', 'workingMemory')).toBe(true);
            expect(orchestrator.isStageEnabled('encoding', 'semanticLTM')).toBe(true);
            expect(orchestrator.isStageEnabled('nonexistent', 'workingMemory')).toBe(false);
        });

        it('should handle unknown memory types', () => {
            expect(orchestrator.isStageEnabled('acquisition', 'unknown')).toBe(false);
        });
    });

    describe('Metrics and Observability', () => {
        it('should update metrics after processing', async () => {
            const item = createMemoryItem(
                'Test content',
                'workingMemory',
                'test',
                tenantId,
                agentId
            );

            await orchestrator.processMemoryItem(item, 'workingMemory');

            const metrics = orchestrator.getMetrics();
            expect(metrics.totalItemsProcessed).toBe(1);
            expect(metrics.averageProcessingTimeMs).toBeGreaterThan(0);
            expect(metrics.lastProcessedAt).toBeDefined();
        });

        it('should track stage-specific metrics', async () => {
            const item = createMemoryItem(
                'Test content',
                'workingMemory',
                'test',
                tenantId,
                agentId
            );

            await orchestrator.processMemoryItem(item, 'workingMemory');

            const metrics = orchestrator.getMetrics();
            expect(Object.keys(metrics.stageMetrics).length).toBeGreaterThan(0);

            // Check that at least one stage has metrics
            const stageKeys = Object.keys(metrics.stageMetrics);
            expect(stageKeys.some(key => metrics.stageMetrics[key].itemsProcessed > 0)).toBe(true);
        });

        it('should reset metrics', async () => {
            const item = createMemoryItem(
                'Test content',
                'workingMemory',
                'test',
                tenantId,
                agentId
            );

            await orchestrator.processMemoryItem(item, 'workingMemory');

            let metrics = orchestrator.getMetrics();
            expect(metrics.totalItemsProcessed).toBe(1);

            orchestrator.resetMetrics();

            metrics = orchestrator.getMetrics();
            expect(metrics.totalItemsProcessed).toBe(0);
            expect(metrics.averageProcessingTimeMs).toBe(0);
            expect(Object.keys(metrics.stageMetrics)).toHaveLength(0);
        });
    });

    describe('Error Handling', () => {
        it('should handle processing errors gracefully', async () => {
            // Create an item that might cause processing issues
            const item = createMemoryItem(
                null, // null content might cause issues in some processors
                'workingMemory',
                'test',
                tenantId,
                agentId
            );

            const result = await orchestrator.processMemoryItem(item, 'workingMemory');

            // Should still return a result, even if processing fails
            expect(result).toBeDefined();
            expect(typeof result.success).toBe('boolean');
        });

        it('should track dropped items in metrics', async () => {
            const item = createMemoryItem(
                'Test content',
                'workingMemory',
                'test',
                tenantId,
                agentId
            );

            // Process an item that might get dropped
            await orchestrator.processMemoryItem(item, 'workingMemory');

            const metrics = orchestrator.getMetrics();
            expect(typeof metrics.totalItemsDropped).toBe('number');
        });
    });

    describe('Lifecycle Management', () => {
        it('should shutdown gracefully', async () => {
            const item = createMemoryItem(
                'Test content',
                'workingMemory',
                'test',
                tenantId,
                agentId
            );

            await orchestrator.processMemoryItem(item, 'workingMemory');

            // Should not throw
            await expect(orchestrator.shutdown()).resolves.not.toThrow();

            // Metrics should be reset after shutdown
            const metrics = orchestrator.getMetrics();
            expect(metrics.totalItemsProcessed).toBe(0);
        });
    });

    describe('Multi-Profile Support', () => {
        it('should work with conversational profile', async () => {
            const conversationalConfig = getMemoryProfile('conversational');
            if (!conversationalConfig) {
                throw new Error('Failed to get conversational memory profile');
            }
            const conversationalOrchestrator = new MemoryLifecycleOrchestrator(
                conversationalConfig,
                tenantId,
                agentId
            );

            const item = createMemoryItem(
                'Conversational content',
                'workingMemory',
                'test',
                tenantId,
                agentId
            );

            const result = await conversationalOrchestrator.processMemoryItem(item, 'workingMemory');

            expect(result.success).toBe(true);
            expect(conversationalOrchestrator.getConfiguration().profile).toBe('conversational');

            await conversationalOrchestrator.shutdown();
        });

        it('should work with research profile', async () => {
            const researchConfig = getMemoryProfile('research');
            if (!researchConfig) {
                throw new Error('Failed to get research memory profile');
            }
            const researchOrchestrator = new MemoryLifecycleOrchestrator(
                researchConfig,
                tenantId,
                agentId
            );

            const item = createMemoryItem(
                'Research content',
                'semanticLTM',
                'test',
                tenantId,
                agentId
            );

            const result = await researchOrchestrator.processMemoryItem(item, 'semanticLTM');

            expect(result.success).toBe(true);
            expect(researchOrchestrator.getConfiguration().profile).toBe('research');

            await researchOrchestrator.shutdown();
        });
    });
}); 