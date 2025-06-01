import { ProcessorFactory } from '../src/core/memory/lifecycle/ProcessorFactory.js';

describe('ProcessorFactory', () => {
    let factory: ProcessorFactory;

    beforeEach(() => {
        factory = new ProcessorFactory();
    });

    describe('Basic Factory Operations', () => {
        it('should create a factory instance', () => {
            expect(factory).toBeInstanceOf(ProcessorFactory);
        });

        it('should list all available processors', () => {
            const processors = factory.getAvailableProcessors();
            expect(processors).toContain('TenantAwareFilter');
            expect(processors).toContain('LLMCompressor');
            expect(processors).toContain('SimpleRAG');
            expect(processors.length).toBeGreaterThan(10);
        });

        it('should check if processor exists', () => {
            expect(factory.hasProcessor('TenantAwareFilter')).toBe(true);
            expect(factory.hasProcessor('NonExistentProcessor')).toBe(false);
        });

        it('should get processors by stage', () => {
            const acquisitionProcessors = factory.getProcessorsByStage('acquisition');
            expect(acquisitionProcessors).toContain('TenantAwareFilter');
            expect(acquisitionProcessors).toContain('LLMCompressor');
            expect(acquisitionProcessors).toContain('NoveltyConsolidator');

            const utilizationProcessors = factory.getProcessorsByStage('utilization');
            expect(utilizationProcessors).toContain('SimpleRAG');
            expect(utilizationProcessors).toContain('SimpleLongContextManager');
            expect(utilizationProcessors).toContain('SimpleHallucinationMitigator');
        });
    });

    describe('Processor Creation', () => {
        it('should create processors by name', () => {
            const filter = factory.create('TenantAwareFilter');
            expect(filter).toBeDefined();
            expect(filter.stageName).toBe('acquisition');
            expect(filter.stageNumber).toBe(1);

            const rag = factory.create('SimpleRAG');
            expect(rag).toBeDefined();
            expect(rag.stageName).toBe('utilization');
            expect(rag.stageNumber).toBe(6);
        });

        it('should create processors with configuration', () => {
            const filter = factory.create('TenantAwareFilter', {
                maxInputSize: 1000,
                tenantIsolation: true
            });
            expect(filter).toBeDefined();
            expect(filter.stageName).toBe('acquisition');
        });

        it('should throw error for unknown processor', () => {
            expect(() => {
                factory.create('UnknownProcessor');
            }).toThrow('Unknown processor: UnknownProcessor');
        });
    });

    describe('Stage-Specific Creation Methods', () => {
        it('should create acquisition stage processors', () => {
            const filter = factory.createFilter('TenantAwareFilter');
            expect(filter.stageName).toBe('acquisition');

            const compressor = factory.createCompressor('LLMCompressor');
            expect(compressor.stageName).toBe('acquisition');

            const consolidator = factory.createConsolidator('NoveltyConsolidator');
            expect(consolidator.stageName).toBe('acquisition');
        });

        it('should create encoding stage processors', () => {
            const attention = factory.createAttention('ConversationAttention');
            expect(attention.stageName).toBe('encoding');

            const fusion = factory.createFusion('ModalityFusion');
            expect(fusion.stageName).toBe('encoding');
        });

        it('should create derivation stage processors', () => {
            const reflection = factory.createReflection('ConversationReflection');
            expect(reflection.stageName).toBe('derivation');

            const summarization = factory.createSummarization('SimpleSummarizer');
            expect(summarization.stageName).toBe('derivation');

            const distillation = factory.createDistillation('SimpleDistiller');
            expect(distillation.stageName).toBe('derivation');

            const forgetting = factory.createForgetting('TimeDecayForgetter');
            expect(forgetting.stageName).toBe('derivation');
        });

        it('should create retrieval stage processors', () => {
            const indexing = factory.createIndexing('DirectMemoryIndexer');
            expect(indexing.stageName).toBe('retrieval');

            const matching = factory.createMatching('SimpleTopKMatcher');
            expect(matching.stageName).toBe('retrieval');
        });

        it('should create neural memory stage processors', () => {
            const associative = factory.createAssociative('PlaceholderAssociative');
            expect(associative.stageName).toBe('neuralMemory');

            const parameterIntegration = factory.createParameterIntegration('PlaceholderParameterIntegration');
            expect(parameterIntegration.stageName).toBe('neuralMemory');
        });

        it('should create utilization stage processors', () => {
            const rag = factory.createRAG('SimpleRAG');
            expect(rag.stageName).toBe('utilization');

            const longContext = factory.createLongContext('SimpleLongContextManager');
            expect(longContext.stageName).toBe('utilization');

            const hallucinationMitigation = factory.createHallucinationMitigation('SimpleHallucinationMitigator');
            expect(hallucinationMitigation.stageName).toBe('utilization');
        });
    });

    describe('Error Handling', () => {
        it('should throw error for invalid stage-specific processors', () => {
            expect(() => {
                factory.createFilter('InvalidFilter');
            }).toThrow('InvalidFilter is not a valid acquisition filter');

            expect(() => {
                factory.createCompressor('InvalidCompressor');
            }).toThrow('InvalidCompressor is not a valid compressor');

            expect(() => {
                factory.createRAG('InvalidRAG');
            }).toThrow('InvalidRAG is not a valid RAG processor');
        });
    });

    describe('All Stages Coverage', () => {
        it('should have processors for all 6 stages', () => {
            const stages = ['acquisition', 'encoding', 'derivation', 'retrieval', 'neuralMemory', 'utilization'];

            stages.forEach(stage => {
                const processors = factory.getProcessorsByStage(stage);
                expect(processors.length).toBeGreaterThan(0);
            });
        });

        it('should create at least one processor from each stage', () => {
            // Stage 1: Acquisition
            const filter = factory.create('TenantAwareFilter');
            expect(filter.stageNumber).toBe(1);

            // Stage 2: Encoding
            const attention = factory.create('ConversationAttention');
            expect(attention.stageNumber).toBe(2);

            // Stage 3: Derivation
            const reflection = factory.create('ConversationReflection');
            expect(reflection.stageNumber).toBe(3);

            // Stage 4: Retrieval
            const indexing = factory.create('DirectMemoryIndexer');
            expect(indexing.stageNumber).toBe(4);

            // Stage 5: Neural Memory
            const associative = factory.create('PlaceholderAssociative');
            expect(associative.stageNumber).toBe(5);

            // Stage 6: Utilization
            const rag = factory.create('SimpleRAG');
            expect(rag.stageNumber).toBe(6);
        });
    });

    describe('Configuration Handling', () => {
        it('should pass configuration to processors', () => {
            // Test with different config types
            const filter = factory.create('TenantAwareFilter', {
                maxInputSize: 2000,
                relevanceThreshold: 0.8
            });
            expect(filter).toBeDefined();

            const compressor = factory.create('LLMCompressor', {
                maxLength: 1000,
                preserveStructure: true
            });
            expect(compressor).toBeDefined();
        });

        it('should handle undefined configuration', () => {
            const processor = factory.create('TenantAwareFilter', undefined);
            expect(processor).toBeDefined();
        });

        it('should handle empty configuration', () => {
            const processor = factory.create('TenantAwareFilter', {});
            expect(processor).toBeDefined();
        });
    });
}); 