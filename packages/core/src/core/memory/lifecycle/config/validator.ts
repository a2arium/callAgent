import {
    MemoryLifecycleConfig,
    MemoryTypeConfig,
    StageConfiguration,
    ConcurrencyConfig,
    ConfigValidationResult,
    ProviderConfig,
} from './types.js';

/**
 * Known implementation types for each stage component
 */
const KNOWN_IMPLEMENTATIONS = {
    acquisition: {
        filter: ['simple', 'rule-based', 'llm-based'],
        compressor: ['none', 'simple', 'gzip', 'llm-summary', 'semantic'],
        consolidator: ['merge', 'deduplicate', 'cluster'],
    },
    encoding: {
        attention: ['simple', 'llm-scoring', 'transformer'],
        fusion: ['concat', 'weighted-concat', 'cross-attention', 'late-fusion'],
    },
    derivation: {
        reflection: ['none', 'simple', 'llm-reflection', 'meta-cognitive'],
        summarization: ['none', 'extractive', 'llm-summary', 'hierarchical'],
        distillation: ['key-value', 'concept-extraction', 'llm-distill'],
        forgetting: ['none', 'time-based', 'relevance-based', 'capacity-based'],
    },
    retrieval: {
        indexing: ['simple', 'vector', 'keyword', 'hybrid', 'graph'],
        matching: ['exact', 'cosine', 'semantic', 'bm25', 'neural'],
    },
    neuralMemory: {
        associative: ['none', 'simple', 'hopfield', 'attention-based', 'graph-neural'],
        parameterIntegration: ['none', 'lora', 'qlora', 'adapter', 'fine-tune'],
    },
    utilization: {
        rag: ['simple', 'fusion', 'iterative', 'graph-rag'],
        longContext: ['sliding-window', 'hierarchical', 'compression'],
        hallucinationMitigation: ['none', 'confidence-scoring', 'fact-checking', 'retrieval-verification'],
    },
};

/**
 * Known provider types
 */
const KNOWN_PROVIDERS = ['openai', 'anthropic', 'local', 'azure', 'google'];

/**
 * Validate concurrency configuration
 */
function validateConcurrencyConfig(
    config: ConcurrencyConfig,
    path: string
): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (config.maxConcurrency <= 0) {
        errors.push(`${path}.maxConcurrency must be greater than 0`);
    }

    if (config.rateLimit <= 0) {
        errors.push(`${path}.rateLimit must be greater than 0`);
    }

    if (config.batchSize <= 0) {
        errors.push(`${path}.batchSize must be greater than 0`);
    }

    if (config.timeout <= 0) {
        errors.push(`${path}.timeout must be greater than 0`);
    }

    if (config.retry.maxAttempts <= 0) {
        errors.push(`${path}.retry.maxAttempts must be greater than 0`);
    }

    if (config.retry.backoffMs < 0) {
        errors.push(`${path}.retry.backoffMs must be non-negative`);
    }

    // Warnings for potentially problematic values
    if (config.maxConcurrency > 50) {
        warnings.push(`${path}.maxConcurrency is very high (${config.maxConcurrency}), may cause rate limiting`);
    }

    if (config.rateLimit > 1000) {
        warnings.push(`${path}.rateLimit is very high (${config.rateLimit}), ensure your API limits support this`);
    }

    if (config.timeout > 300000) { // 5 minutes
        warnings.push(`${path}.timeout is very high (${config.timeout}ms), may cause long waits`);
    }

    if (config.batchSize > config.maxConcurrency) {
        warnings.push(`${path}.batchSize (${config.batchSize}) is larger than maxConcurrency (${config.maxConcurrency})`);
    }

    return { errors, warnings };
}

/**
 * Validate provider configuration
 */
function validateProviderConfig(
    config: ProviderConfig,
    path: string
): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!config.provider) {
        errors.push(`${path}.provider is required`);
    } else if (!KNOWN_PROVIDERS.includes(config.provider)) {
        warnings.push(`${path}.provider '${config.provider}' is not a known provider`);
    }

    if (config.concurrency) {
        // Create a complete concurrency config with defaults for validation
        const fullConcurrencyConfig: ConcurrencyConfig = {
            maxConcurrency: config.concurrency.maxConcurrency ?? 1,
            rateLimit: config.concurrency.rateLimit ?? 10,
            batchSize: config.concurrency.batchSize ?? 1,
            timeout: config.concurrency.timeout ?? 30000,
            retry: {
                maxAttempts: config.concurrency.retry?.maxAttempts ?? 3,
                backoffMs: config.concurrency.retry?.backoffMs ?? 1000,
                exponentialBackoff: config.concurrency.retry?.exponentialBackoff ?? true,
            },
        };
        const concurrencyValidation = validateConcurrencyConfig(fullConcurrencyConfig, `${path}.concurrency`);
        errors.push(...concurrencyValidation.errors);
        warnings.push(...concurrencyValidation.warnings);
    }

    return { errors, warnings };
}

/**
 * Validate stage configuration
 */
function validateStageConfiguration(
    config: StageConfiguration,
    path: string
): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate each stage
    for (const [stageName, stageConfig] of Object.entries(config)) {
        const stagePath = `${path}.${stageName}`;
        const knownImpls = KNOWN_IMPLEMENTATIONS[stageName as keyof typeof KNOWN_IMPLEMENTATIONS];

        if (!knownImpls) {
            errors.push(`Unknown stage: ${stageName}`);
            continue;
        }

        // Validate each component in the stage
        for (const [componentName, implementation] of Object.entries(stageConfig)) {
            if (componentName === 'config') continue; // Skip config validation for now

            const componentPath = `${stagePath}.${componentName}`;
            const knownComponentImpls = knownImpls[componentName as keyof typeof knownImpls] as string[] | undefined;

            if (!knownComponentImpls) {
                errors.push(`Unknown component: ${componentName} in stage ${stageName}`);
                continue;
            }

            if (typeof implementation !== 'string') {
                errors.push(`${componentPath} must be a string`);
                continue;
            }

            if (!knownComponentImpls.includes(implementation)) {
                warnings.push(
                    `${componentPath} uses unknown implementation '${implementation}'. ` +
                    `Known implementations: ${knownComponentImpls.join(', ')}`
                );
            }
        }

        // Check for LLM-based implementations that need provider configuration
        const llmBasedComponents = Object.entries(stageConfig)
            .filter(([key, value]) => key !== 'config' && typeof value === 'string' && value.includes('llm'))
            .map(([key]) => key);

        if (llmBasedComponents.length > 0) {
            const stageConfigObj = stageConfig.config || {};
            for (const component of llmBasedComponents) {
                const componentConfig = (stageConfigObj as Record<string, unknown>)[component] as Record<string, unknown> | undefined;
                if (!componentConfig || !componentConfig.provider) {
                    warnings.push(
                        `${stagePath}.${component} uses LLM-based implementation but no provider is configured in ${stagePath}.config.${component}.provider`
                    );
                }
            }
        }
    }

    return { errors, warnings };
}

/**
 * Validate memory type configuration
 */
function validateMemoryTypeConfig(
    config: MemoryTypeConfig,
    path: string
): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate stages
    const stageValidation = validateStageConfiguration(config.stages, `${path}.stages`);
    errors.push(...stageValidation.errors);
    warnings.push(...stageValidation.warnings);

    // Validate concurrency if present
    if (config.concurrency) {
        // Create a complete concurrency config with defaults for validation
        const fullConcurrencyConfig: ConcurrencyConfig = {
            maxConcurrency: config.concurrency.maxConcurrency ?? 1,
            rateLimit: config.concurrency.rateLimit ?? 10,
            batchSize: config.concurrency.batchSize ?? 1,
            timeout: config.concurrency.timeout ?? 30000,
            retry: {
                maxAttempts: config.concurrency.retry?.maxAttempts ?? 3,
                backoffMs: config.concurrency.retry?.backoffMs ?? 1000,
                exponentialBackoff: config.concurrency.retry?.exponentialBackoff ?? true,
            },
        };
        const concurrencyValidation = validateConcurrencyConfig(fullConcurrencyConfig, `${path}.concurrency`);
        errors.push(...concurrencyValidation.errors);
        warnings.push(...concurrencyValidation.warnings);
    }

    // Validate providers if present
    if (config.providers) {
        for (const [providerName, providerConfig] of Object.entries(config.providers)) {
            const providerValidation = validateProviderConfig(providerConfig, `${path}.providers.${providerName}`);
            errors.push(...providerValidation.errors);
            warnings.push(...providerValidation.warnings);
        }
    }

    // Check for disabled stages that are referenced by enabled stages
    if (config.enabledStages) {
        const enabled = config.enabledStages;

        if (enabled.utilization && !enabled.retrieval) {
            warnings.push(`${path}: utilization stage is enabled but retrieval stage is disabled`);
        }

        if (enabled.neuralMemory && !enabled.encoding) {
            warnings.push(`${path}: neuralMemory stage is enabled but encoding stage is disabled`);
        }
    }

    return { errors, warnings };
}

/**
 * Validate complete MLO configuration
 */
export function validateConfig(config: MemoryLifecycleConfig): ConfigValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const suggestions: string[] = [];

    try {
        // Validate each memory type
        const memoryTypes = ['workingMemory', 'semanticLTM', 'episodicLTM', 'retrieval'] as const;

        for (const memoryType of memoryTypes) {
            const memoryConfig = config[memoryType];
            if (!memoryConfig) {
                errors.push(`Missing configuration for ${memoryType}`);
                continue;
            }

            const validation = validateMemoryTypeConfig(memoryConfig, memoryType);
            errors.push(...validation.errors);
            warnings.push(...validation.warnings);
        }

        // Validate global configuration
        if (config.global) {
            if (config.global.concurrency) {
                const globalConcurrencyValidation = validateConcurrencyConfig(
                    config.global.concurrency,
                    'global.concurrency'
                );
                errors.push(...globalConcurrencyValidation.errors);
                warnings.push(...globalConcurrencyValidation.warnings);
            }

            if (config.global.providers) {
                for (const [providerName, providerConfig] of Object.entries(config.global.providers)) {
                    const providerValidation = validateProviderConfig(
                        providerConfig,
                        `global.providers.${providerName}`
                    );
                    errors.push(...providerValidation.errors);
                    warnings.push(...providerValidation.warnings);
                }
            }
        }

        // Generate suggestions based on configuration
        if (config.profile === 'production') {
            if (!config.global?.monitoring?.enableMetrics) {
                suggestions.push('Consider enabling metrics for production monitoring');
            }

            // Check for LLM-heavy configurations in production
            const hasLLMComponents = memoryTypes.some(memoryType => {
                const stages = config[memoryType]?.stages;
                if (!stages) return false;

                return Object.values(stages).some(stage =>
                    Object.values(stage).some(impl =>
                        typeof impl === 'string' && impl.includes('llm')
                    )
                );
            });

            if (hasLLMComponents && !config.global?.concurrency) {
                suggestions.push('Consider setting global concurrency limits for LLM operations in production');
            }
        }

        if (config.profile === 'development') {
            if (!config.global?.monitoring?.enableTracing) {
                suggestions.push('Consider enabling tracing for development debugging');
            }
        }

        // Check for missing provider configurations
        const referencedProviders = new Set<string>();
        for (const memoryType of memoryTypes) {
            const stages = config[memoryType]?.stages;
            if (!stages) continue;

            for (const stage of Object.values(stages)) {
                if (stage.config) {
                    for (const componentConfig of Object.values(stage.config)) {
                        if (componentConfig && typeof componentConfig === 'object' && 'provider' in componentConfig) {
                            referencedProviders.add(componentConfig.provider as string);
                        }
                    }
                }
            }
        }

        for (const provider of referencedProviders) {
            const hasGlobalProvider = config.global?.providers?.[provider];
            const hasLocalProvider = memoryTypes.some(memoryType =>
                config[memoryType]?.providers?.[provider]
            );

            if (!hasGlobalProvider && !hasLocalProvider) {
                suggestions.push(`Provider '${provider}' is referenced but not configured`);
            }
        }

    } catch (error) {
        errors.push(`Configuration validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
        suggestions,
    };
}

/**
 * Validate configuration and throw if invalid
 */
export function validateConfigOrThrow(config: MemoryLifecycleConfig): void {
    const result = validateConfig(config);
    if (!result.valid) {
        const errorMessage = [
            'Configuration validation failed:',
            ...result.errors.map(error => `  - ${error}`),
            ...(result.warnings.length > 0 ? ['Warnings:', ...result.warnings.map(warning => `  - ${warning}`)] : []),
        ].join('\n');

        throw new Error(errorMessage);
    }
}

/**
 * Check if a configuration is compatible with a specific profile
 */
export function isCompatibleWithProfile(
    config: MemoryLifecycleConfig,
    targetProfile: string
): { compatible: boolean; issues: string[] } {
    const issues: string[] = [];

    // Check profile-specific requirements
    switch (targetProfile) {
        case 'minimal':
            // Minimal should avoid LLM-based implementations
            const hasLLMImpls = Object.values(config).some(memoryConfig => {
                if (!memoryConfig || typeof memoryConfig !== 'object' || !('stages' in memoryConfig)) return false;
                return Object.values(memoryConfig.stages).some(stage =>
                    Object.values(stage).some(impl =>
                        typeof impl === 'string' && impl.includes('llm')
                    )
                );
            });
            if (hasLLMImpls) {
                issues.push('Minimal profile should not use LLM-based implementations');
            }
            break;

        case 'production':
            // Production should have monitoring and concurrency controls
            if (!config.global?.monitoring?.enableMetrics) {
                issues.push('Production profile should enable metrics monitoring');
            }
            if (!config.global?.concurrency && !config.workingMemory?.concurrency) {
                issues.push('Production profile should have concurrency controls');
            }
            break;

        case 'high-performance':
            // High-performance should avoid slow implementations
            const hasSlowImpls = Object.values(config).some(memoryConfig => {
                if (!memoryConfig || typeof memoryConfig !== 'object' || !('stages' in memoryConfig)) return false;
                return Object.values(memoryConfig.stages).some(stage =>
                    Object.values(stage).some(impl =>
                        typeof impl === 'string' && (impl.includes('llm') || impl.includes('graph'))
                    )
                );
            });
            if (hasSlowImpls) {
                issues.push('High-performance profile should avoid slow implementations (LLM-based, graph-based)');
            }
            break;
    }

    return {
        compatible: issues.length === 0,
        issues,
    };
} 