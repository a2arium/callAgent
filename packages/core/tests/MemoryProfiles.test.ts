import {
    MemoryProfiles,
    getMemoryProfile,
    getAvailableProfiles,
    isValidProfile,
    getProfileRecommendations,
    validateConfig,
    MemoryLifecycleConfig,
} from '../src/core/memory/lifecycle/config/index.js';

describe('Memory Profiles System', () => {
    describe('Profile Availability', () => {
        it('should provide all expected profiles', () => {
            const profiles = getAvailableProfiles();

            expect(profiles).toContain('basic');
            expect(profiles).toContain('conversational');
            expect(profiles).toContain('research-optimized');
            expect(profiles.length).toBe(3);
        });

        it('should validate profile names correctly', () => {
            expect(isValidProfile('basic')).toBe(true);
            expect(isValidProfile('conversational')).toBe(true);
            expect(isValidProfile('research-optimized')).toBe(true);
            expect(isValidProfile('nonexistent')).toBe(false);
            expect(isValidProfile('')).toBe(false);
        });

        it('should return valid profiles from getMemoryProfile', () => {
            const basicProfile = getMemoryProfile('basic');
            const conversationalProfile = getMemoryProfile('conversational');
            const researchProfile = getMemoryProfile('research-optimized');

            expect(basicProfile).toBeDefined();
            expect(conversationalProfile).toBeDefined();
            expect(researchProfile).toBeDefined();

            expect(basicProfile?.profile).toBe('basic');
            expect(conversationalProfile?.profile).toBe('conversational');
            expect(researchProfile?.profile).toBe('research-optimized');
        });

        it('should return undefined for invalid profile names', () => {
            expect(getMemoryProfile('nonexistent')).toBeUndefined();
            expect(getMemoryProfile('')).toBeUndefined();
        });
    });

    describe('Profile Configuration Validation', () => {
        it('should have valid configurations for all profiles', () => {
            const profiles = getAvailableProfiles();

            for (const profileName of profiles) {
                const profile = getMemoryProfile(profileName);
                expect(profile).toBeDefined();

                if (!profile) continue;
                const validation = validateConfig(profile);
                expect(validation.valid).toBe(true);

                if (!validation.valid) {
                    console.error(`${profileName} validation errors:`, validation.errors);
                    console.error(`${profileName} validation warnings:`, validation.warnings);
                }
            }
        });

        it('should have all required memory types configured', () => {
            const profiles = getAvailableProfiles();

            for (const profileName of profiles) {
                const profile = getMemoryProfile(profileName);
                expect(profile).toBeDefined();

                expect(profile?.workingMemory).toBeDefined();
                expect(profile?.semanticLTM).toBeDefined();
                expect(profile?.episodicLTM).toBeDefined();
                expect(profile?.retrieval).toBeDefined();
                expect(profile?.global).toBeDefined();
            }
        });

        it('should have all required stages configured', () => {
            const profiles = getAvailableProfiles();
            const requiredStages = ['acquisition', 'encoding', 'derivation', 'retrieval', 'neuralMemory', 'utilization'];

            for (const profileName of profiles) {
                const profile = getMemoryProfile(profileName);
                expect(profile).toBeDefined();

                const stages = profile?.workingMemory.stages;
                for (const stage of requiredStages) {
                    expect(stages).toHaveProperty(stage);
                }
            }
        });
    });

    describe('Basic Profile', () => {
        let basicProfile: any;

        beforeEach(() => {
            basicProfile = getMemoryProfile('basic');
        });

        it('should use minimal implementations', () => {
            expect(basicProfile?.workingMemory.stages.acquisition.filter).toBe('TenantAwareFilter');
            expect(basicProfile?.workingMemory.stages.acquisition.compressor).toBe('TextTruncationCompressor');
            expect(basicProfile?.workingMemory.stages.acquisition.consolidator).toBe('NoOpConsolidator');

            expect(basicProfile?.workingMemory.stages.encoding.attention).toBe('PassThroughAttention');
            expect(basicProfile?.workingMemory.stages.encoding.fusion).toBe('SingleModalityFusion');

            expect(basicProfile?.workingMemory.stages.derivation.reflection).toBe('PlaceholderReflection');
            expect(basicProfile?.workingMemory.stages.derivation.summarization).toBe('SimpleSummarizer');
        });

        it('should have neural memory disabled', () => {
            expect(basicProfile?.workingMemory.enabledStages?.neuralMemory).toBe(false);
        });

        it('should use minimal concurrency settings', () => {
            expect(basicProfile?.global?.concurrency?.maxConcurrency).toBe(1);
            expect(basicProfile?.global?.concurrency?.rateLimit).toBe(10);
        });

        it('should have monitoring disabled', () => {
            expect(basicProfile?.global?.monitoring?.enableMetrics).toBe(false);
            expect(basicProfile?.global?.monitoring?.enableTracing).toBe(false);
            expect(basicProfile?.global?.monitoring?.logLevel).toBe('warn');
        });

        it('should use lightweight models', () => {
            expect(basicProfile?.global?.providers?.openai?.model).toBe('gpt-4o-mini');
            expect(basicProfile?.global?.providers?.anthropic?.model).toBe('claude-3-haiku-20240307');
        });
    });

    describe('Conversational Profile', () => {
        let conversationalProfile: any;

        beforeEach(() => {
            conversationalProfile = getMemoryProfile('conversational');
        });

        it('should use conversation-aware implementations', () => {
            expect(conversationalProfile?.workingMemory.stages.acquisition.consolidator).toBe('ConversationConsolidator');
            expect(conversationalProfile?.workingMemory.stages.encoding.attention).toBe('ConversationAttention');
            expect(conversationalProfile?.workingMemory.stages.encoding.fusion).toBe('DialogueFusion');
            expect(conversationalProfile?.workingMemory.stages.derivation.reflection).toBe('ConversationReflection');
            expect(conversationalProfile?.workingMemory.stages.derivation.summarization).toBe('DialogueSummarizer');
        });

        it('should have neural memory enabled', () => {
            expect(conversationalProfile?.workingMemory.enabledStages?.neuralMemory).toBe(true);
        });

        it('should use development-level concurrency', () => {
            expect(conversationalProfile?.global?.concurrency?.maxConcurrency).toBe(3);
            expect(conversationalProfile?.global?.concurrency?.rateLimit).toBe(30);
        });

        it('should have monitoring enabled', () => {
            expect(conversationalProfile?.global?.monitoring?.enableMetrics).toBe(true);
            expect(conversationalProfile?.global?.monitoring?.enableTracing).toBe(true);
            expect(conversationalProfile?.global?.monitoring?.logLevel).toBe('info');
        });

        it('should have conversation-specific configuration', () => {
            const acquisitionConfig = conversationalProfile?.workingMemory.stages.acquisition.config;
            expect(acquisitionConfig?.filter).toHaveProperty('conversationAware', true);
            expect(acquisitionConfig?.compressor).toHaveProperty('conversationFormat', true);
            expect(acquisitionConfig?.consolidator).toHaveProperty('mergeAdjacentTurns', true);
        });
    });

    describe('Research-Optimized Profile', () => {
        let researchProfile: any;

        beforeEach(() => {
            researchProfile = getMemoryProfile('research-optimized');
        });

        it('should use research-specific implementations', () => {
            expect(researchProfile?.workingMemory.stages.encoding.fusion).toBe('ResearchFusion');
            expect(researchProfile?.workingMemory.stages.retrieval.indexing).toBe('ResearchIndexer');
            expect(researchProfile?.workingMemory.stages.retrieval.matching).toBe('SemanticMatcher');
            expect(researchProfile?.workingMemory.stages.utilization.rag).toBe('ResearchRAG');
            expect(researchProfile?.workingMemory.stages.utilization.longContext).toBe('HierarchicalContextManager');
        });

        it('should have neural memory enabled', () => {
            expect(researchProfile?.workingMemory.enabledStages?.neuralMemory).toBe(true);
        });

        it('should use production-level concurrency', () => {
            expect(researchProfile?.global?.concurrency?.maxConcurrency).toBe(10);
            expect(researchProfile?.global?.concurrency?.rateLimit).toBe(100);
        });

        it('should have full monitoring enabled', () => {
            expect(researchProfile?.global?.monitoring?.enableMetrics).toBe(true);
            expect(researchProfile?.global?.monitoring?.enableTracing).toBe(true);
            expect(researchProfile?.global?.monitoring?.logLevel).toBe('debug');
        });

        it('should use advanced models', () => {
            expect(researchProfile?.global?.providers?.openai?.model).toBe('gpt-4o');
            expect(researchProfile?.global?.providers?.anthropic?.model).toBe('claude-3-5-sonnet-20241022');
        });

        it('should have research-specific configuration', () => {
            const acquisitionConfig = researchProfile?.workingMemory.stages.acquisition.config;
            expect(acquisitionConfig?.filter).toHaveProperty('researchMode', true);
            expect(acquisitionConfig?.filter).toHaveProperty('complexityAware', true);
            expect(acquisitionConfig?.compressor).toHaveProperty('preserveReferences', true);

            const utilizationConfig = researchProfile?.workingMemory.stages.utilization.config;
            expect(utilizationConfig?.rag).toHaveProperty('hierarchicalRetrieval', true);
            expect(utilizationConfig?.hallucinationMitigation).toHaveProperty('factChecking', true);
        });

        it('should have larger context windows and retrieval limits', () => {
            const utilizationConfig = researchProfile?.workingMemory.stages.utilization.config;
            expect(utilizationConfig?.rag?.maxRetrievedItems).toBe(15);
            expect(utilizationConfig?.rag?.contextWindow).toBe(4000);
            expect(utilizationConfig?.longContext?.windowSize).toBe(8000);
        });
    });

    describe('Profile Recommendations', () => {
        it('should provide appropriate recommendations for different use cases', () => {
            expect(getProfileRecommendations('chatbot')).toEqual(['conversational', 'basic']);
            expect(getProfileRecommendations('assistant')).toEqual(['conversational', 'research-optimized']);
            expect(getProfileRecommendations('research')).toEqual(['research-optimized', 'conversational']);
            expect(getProfileRecommendations('simple')).toEqual(['basic', 'conversational']);
            expect(getProfileRecommendations('academic')).toEqual(['research-optimized']);
            expect(getProfileRecommendations('lightweight')).toEqual(['basic']);
        });

        it('should provide default recommendation for unknown use cases', () => {
            expect(getProfileRecommendations('unknown-use-case')).toEqual(['basic']);
            expect(getProfileRecommendations('')).toEqual(['basic']);
        });

        it('should be case insensitive', () => {
            expect(getProfileRecommendations('CHATBOT')).toEqual(['conversational', 'basic']);
            expect(getProfileRecommendations('Research')).toEqual(['research-optimized', 'conversational']);
        });
    });

    describe('Profile Deep Copy', () => {
        it('should return deep copies to prevent mutation', () => {
            const profile1 = getMemoryProfile('basic');
            const profile2 = getMemoryProfile('basic');

            // Modify one profile
            if (profile1) {
                profile1.workingMemory.stages.acquisition.filter = 'ModifiedFilter';
            }

            // Other profile should be unchanged
            expect(profile2?.workingMemory.stages.acquisition.filter).toBe('TenantAwareFilter');
        });

        it('should allow independent configuration modifications', () => {
            const profile1 = getMemoryProfile('conversational');
            const profile2 = getMemoryProfile('conversational');

            // Modify configuration in one profile
            if (profile1?.workingMemory.stages.acquisition.config?.filter) {
                profile1.workingMemory.stages.acquisition.config.filter.maxInputSize = 9999;
            }

            // Other profile should be unchanged
            const profile2Config = profile2?.workingMemory.stages.acquisition.config?.filter;
            expect(profile2Config?.maxInputSize).toBe(2000);
        });
    });

    describe('Tenant Isolation', () => {
        it('should have tenant isolation enabled in all profiles', () => {
            const profiles = getAvailableProfiles();

            for (const profileName of profiles) {
                const profile = getMemoryProfile(profileName);
                expect(profile).toBeDefined();

                // Check acquisition filter has tenant isolation
                const filterConfig = profile?.workingMemory.stages.acquisition.config?.filter;
                expect(filterConfig?.tenantIsolation).toBe(true);

                // Check retrieval indexing has tenant isolation
                const indexingConfig = profile?.workingMemory.stages.retrieval.config?.indexing;
                expect(indexingConfig?.tenantIsolation).toBe(true);
            }
        });
    });

    describe('Stage Configuration Consistency', () => {
        it('should have consistent stage configurations across memory types within profiles', () => {
            const profiles = getAvailableProfiles();

            for (const profileName of profiles) {
                const profile = getMemoryProfile(profileName);
                expect(profile).toBeDefined();

                // All memory types should use the same stage configuration for consistency
                const workingMemoryStages = profile?.workingMemory.stages;
                const semanticLTMStages = profile?.semanticLTM.stages;
                const episodicLTMStages = profile?.episodicLTM.stages;
                const retrievalStages = profile?.retrieval.stages;

                expect(semanticLTMStages).toEqual(workingMemoryStages);
                expect(episodicLTMStages).toEqual(workingMemoryStages);
                expect(retrievalStages).toEqual(workingMemoryStages);
            }
        });

        it('should have appropriate enabled stages for each profile', () => {
            const basicProfile = getMemoryProfile('basic');
            const conversationalProfile = getMemoryProfile('conversational');
            const researchProfile = getMemoryProfile('research-optimized');

            // Basic profile should have neural memory disabled
            expect(basicProfile?.workingMemory.enabledStages?.neuralMemory).toBe(false);

            // Other profiles should have neural memory enabled
            expect(conversationalProfile?.workingMemory.enabledStages?.neuralMemory).toBe(true);
            expect(researchProfile?.workingMemory.enabledStages?.neuralMemory).toBe(true);

            // All profiles should have core stages enabled
            const coreStages = ['acquisition', 'encoding', 'derivation', 'retrieval', 'utilization'];
            for (const profile of [basicProfile, conversationalProfile, researchProfile]) {
                for (const stage of coreStages) {
                    expect(profile?.workingMemory.enabledStages).toHaveProperty(stage, true);
                }
            }
        });
    });
}); 