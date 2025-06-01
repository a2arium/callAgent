import {
    getDefaultConfig,
    getDefaultConcurrency,
    getDefaultProvider,
    validateConfig,
    validateConfigOrThrow,
    isCompatibleWithProfile,
    ConfigProfile,
    MemoryLifecycleConfig,
} from '../src/core/memory/lifecycle/config/index.js';

describe('MLO Configuration System', () => {
    describe('Default Configurations', () => {
        it('should provide valid default configurations for all profiles', () => {
            const profiles: ConfigProfile[] = ['minimal', 'development', 'production', 'research', 'high-performance'];

            for (const profile of profiles) {
                const config = getDefaultConfig(profile);

                expect(config).toBeDefined();
                expect(config.profile).toBe(profile);
                expect(config.workingMemory).toBeDefined();
                expect(config.semanticLTM).toBeDefined();
                expect(config.episodicLTM).toBeDefined();
                expect(config.retrieval).toBeDefined();

                // Validate the configuration
                const validation = validateConfig(config);
                expect(validation.valid).toBe(true);
                if (!validation.valid) {
                    console.error(`${profile} config errors:`, validation.errors);
                }
            }
        });

        it('should provide different configurations for different profiles', () => {
            const minimalConfig = getDefaultConfig('minimal');
            const productionConfig = getDefaultConfig('production');

            // Minimal should have simpler implementations
            expect(minimalConfig.workingMemory.stages.acquisition.filter).toBe('simple');
            expect(productionConfig.workingMemory.stages.acquisition.filter).toBe('llm-based');

            // Production should have monitoring enabled
            expect(minimalConfig.global?.monitoring?.enableMetrics).toBe(false);
            expect(productionConfig.global?.monitoring?.enableMetrics).toBe(true);
        });

        it('should provide valid concurrency configurations', () => {
            const profiles: ConfigProfile[] = ['minimal', 'development', 'production', 'research', 'high-performance'];

            for (const profile of profiles) {
                const concurrency = getDefaultConcurrency(profile);

                expect(concurrency.maxConcurrency).toBeGreaterThan(0);
                expect(concurrency.rateLimit).toBeGreaterThan(0);
                expect(concurrency.batchSize).toBeGreaterThan(0);
                expect(concurrency.timeout).toBeGreaterThan(0);
                expect(concurrency.retry.maxAttempts).toBeGreaterThan(0);
                expect(concurrency.retry.backoffMs).toBeGreaterThanOrEqual(0);
            }
        });

        it('should provide valid provider configurations', () => {
            const providers = ['openai', 'anthropic', 'local'];

            for (const providerName of providers) {
                const provider = getDefaultProvider(providerName);

                expect(provider).toBeDefined();
                expect(provider!.provider).toBe(providerName);
                expect(provider!.concurrency).toBeDefined();
                expect(provider!.concurrency!.maxConcurrency).toBeGreaterThan(0);
            }
        });

        it('should return undefined for unknown providers', () => {
            const provider = getDefaultProvider('unknown-provider');
            expect(provider).toBeUndefined();
        });
    });

    describe('Configuration Validation', () => {
        it('should validate valid configurations', () => {
            const config = getDefaultConfig('development');
            const result = validateConfig(config);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });

        it('should detect missing memory type configurations', () => {
            const invalidConfig = {
                profile: 'test',
                workingMemory: getDefaultConfig('minimal').workingMemory,
                // Missing semanticLTM, episodicLTM, retrieval
            } as MemoryLifecycleConfig;

            const result = validateConfig(invalidConfig);

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Missing configuration for semanticLTM');
            expect(result.errors).toContain('Missing configuration for episodicLTM');
            expect(result.errors).toContain('Missing configuration for retrieval');
        });

        it('should detect invalid concurrency values', () => {
            const config = getDefaultConfig('development');
            config.global!.concurrency!.maxConcurrency = -1;
            config.global!.concurrency!.rateLimit = 0;

            const result = validateConfig(config);

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('global.concurrency.maxConcurrency must be greater than 0');
            expect(result.errors).toContain('global.concurrency.rateLimit must be greater than 0');
        });

        it('should provide warnings for unknown implementations', () => {
            const config = getDefaultConfig('development');
            config.workingMemory.stages.acquisition.filter = 'unknown-filter';

            const result = validateConfig(config);

            expect(result.valid).toBe(true); // Still valid, just warnings
            expect(result.warnings.some(w => w.includes('unknown-filter'))).toBe(true);
        });

        it('should provide suggestions for production configurations', () => {
            const config = getDefaultConfig('production');
            config.global!.monitoring!.enableMetrics = false;
            delete config.global!.concurrency;

            const result = validateConfig(config);

            expect(result.suggestions).toBeDefined();
            expect(result.suggestions!).toContain('Consider enabling metrics for production monitoring');
            expect(result.suggestions!.some(s => s.includes('concurrency limits'))).toBe(true);
        });

        it('should throw on invalid configurations when using validateConfigOrThrow', () => {
            const invalidConfig = {
                profile: 'test',
                workingMemory: getDefaultConfig('minimal').workingMemory,
                // Missing other required fields
            } as MemoryLifecycleConfig;

            expect(() => validateConfigOrThrow(invalidConfig)).toThrow('Configuration validation failed');
        });
    });

    describe('Profile Compatibility', () => {
        it('should check minimal profile compatibility', () => {
            const minimalConfig = getDefaultConfig('minimal');
            const result = isCompatibleWithProfile(minimalConfig, 'minimal');

            expect(result.compatible).toBe(true);
            expect(result.issues).toHaveLength(0);
        });

        it('should detect LLM implementations in minimal profile', () => {
            const config = getDefaultConfig('minimal');
            config.workingMemory.stages.acquisition.filter = 'llm-based';

            const result = isCompatibleWithProfile(config, 'minimal');

            expect(result.compatible).toBe(false);
            expect(result.issues).toContain('Minimal profile should not use LLM-based implementations');
        });

        it('should check production profile requirements', () => {
            const config = getDefaultConfig('production');
            config.global!.monitoring!.enableMetrics = false;
            delete config.global!.concurrency;
            delete config.workingMemory.concurrency; // Remove both global and workingMemory concurrency

            const result = isCompatibleWithProfile(config, 'production');

            expect(result.compatible).toBe(false);
            expect(result.issues).toContain('Production profile should enable metrics monitoring');
            expect(result.issues).toContain('Production profile should have concurrency controls');
        });

        it('should check high-performance profile requirements', () => {
            const config = getDefaultConfig('high-performance');
            config.workingMemory.stages.acquisition.filter = 'llm-based';
            config.workingMemory.stages.retrieval.indexing = 'graph';

            const result = isCompatibleWithProfile(config, 'high-performance');

            expect(result.compatible).toBe(false);
            expect(result.issues).toContain('High-performance profile should avoid slow implementations (LLM-based, graph-based)');
        });
    });

    describe('Concurrency and Rate Limiting', () => {
        it('should have appropriate concurrency limits for different profiles', () => {
            const minimal = getDefaultConcurrency('minimal');
            const production = getDefaultConcurrency('production');
            const highPerf = getDefaultConcurrency('high-performance');

            // Minimal should have lowest concurrency
            expect(minimal.maxConcurrency).toBeLessThan(production.maxConcurrency);
            expect(minimal.rateLimit).toBeLessThan(production.rateLimit);

            // High-performance should have highest concurrency
            expect(highPerf.maxConcurrency).toBeGreaterThan(production.maxConcurrency);
            expect(highPerf.rateLimit).toBeGreaterThan(production.rateLimit);
        });

        it('should have retry configurations', () => {
            const config = getDefaultConcurrency('production');

            expect(config.retry.maxAttempts).toBeGreaterThan(0);
            expect(config.retry.backoffMs).toBeGreaterThanOrEqual(0);
            expect(typeof config.retry.exponentialBackoff).toBe('boolean');
        });

        it('should have provider-specific concurrency controls', () => {
            const openaiProvider = getDefaultProvider('openai');
            const anthropicProvider = getDefaultProvider('anthropic');

            expect(openaiProvider!.concurrency).toBeDefined();
            expect(anthropicProvider!.concurrency).toBeDefined();

            // OpenAI typically has higher rate limits
            expect(openaiProvider!.concurrency!.rateLimit).toBeGreaterThanOrEqual(
                anthropicProvider!.concurrency!.rateLimit!
            );
        });
    });

    describe('Configuration Deep Copy', () => {
        it('should return deep copies to prevent mutation', () => {
            const config1 = getDefaultConfig('development');
            const config2 = getDefaultConfig('development');

            // Modify one config
            config1.workingMemory.stages.acquisition.filter = 'modified';

            // Other config should be unchanged
            expect(config2.workingMemory.stages.acquisition.filter).not.toBe('modified');
        });

        it('should return deep copies of concurrency configs', () => {
            const concurrency1 = getDefaultConcurrency('production');
            const concurrency2 = getDefaultConcurrency('production');

            concurrency1.maxConcurrency = 999;

            expect(concurrency2.maxConcurrency).not.toBe(999);
        });
    });
}); 