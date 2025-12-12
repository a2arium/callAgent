import {
    MemoryLifecycleConfig,
    MemoryTypeConfig,
    StageConfiguration,
    ConcurrencyConfig,
    ConfigProfile,
    ProviderConfig,
} from './types.js';

/**
 * Default concurrency configurations for different environments
 */
const DEFAULT_CONCURRENCY: Record<ConfigProfile, ConcurrencyConfig> = {
    minimal: {
        maxConcurrency: 1,
        rateLimit: 10, // 10 requests per minute
        batchSize: 1,
        timeout: 30000, // 30 seconds
        retry: {
            maxAttempts: 2,
            backoffMs: 1000,
            exponentialBackoff: false,
        },
    },
    development: {
        maxConcurrency: 3,
        rateLimit: 30, // 30 requests per minute
        batchSize: 5,
        timeout: 45000, // 45 seconds
        retry: {
            maxAttempts: 3,
            backoffMs: 1000,
            exponentialBackoff: true,
        },
    },
    production: {
        maxConcurrency: 10,
        rateLimit: 100, // 100 requests per minute
        batchSize: 10,
        timeout: 60000, // 60 seconds
        retry: {
            maxAttempts: 5,
            backoffMs: 2000,
            exponentialBackoff: true,
        },
    },
    research: {
        maxConcurrency: 5,
        rateLimit: 50, // 50 requests per minute
        batchSize: 8,
        timeout: 120000, // 2 minutes for complex operations
        retry: {
            maxAttempts: 3,
            backoffMs: 5000,
            exponentialBackoff: true,
        },
    },
    'high-performance': {
        maxConcurrency: 20,
        rateLimit: 300, // 300 requests per minute
        batchSize: 20,
        timeout: 30000, // 30 seconds
        retry: {
            maxAttempts: 3,
            backoffMs: 500,
            exponentialBackoff: true,
        },
    },
};

/**
 * Default provider configurations with concurrency controls
 */
const DEFAULT_PROVIDERS: Record<string, ProviderConfig> = {
    openai: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        concurrency: {
            maxConcurrency: 5,
            rateLimit: 60, // OpenAI tier limits
            batchSize: 5,
            timeout: 60000,
        },
    },
    anthropic: {
        provider: 'anthropic',
        model: 'claude-3-haiku-20240307',
        concurrency: {
            maxConcurrency: 3,
            rateLimit: 50,
            batchSize: 3,
            timeout: 60000,
        },
    },
    local: {
        provider: 'local',
        model: 'llama-3.1-8b',
        concurrency: {
            maxConcurrency: 2,
            rateLimit: 20,
            batchSize: 2,
            timeout: 120000,
        },
    },
};

/**
 * Minimal stage configuration for basic functionality
 */
const MINIMAL_STAGE_CONFIG: StageConfiguration = {
    acquisition: {
        filter: 'simple',
        compressor: 'none',
        consolidator: 'merge',
    },
    encoding: {
        attention: 'simple',
        fusion: 'concat',
    },
    derivation: {
        reflection: 'none',
        summarization: 'none',
        distillation: 'key-value',
        forgetting: 'none',
    },
    retrieval: {
        indexing: 'simple',
        matching: 'exact',
    },
    neuralMemory: {
        associative: 'none',
        parameterIntegration: 'none',
    },
    utilization: {
        rag: 'simple',
        longContext: 'sliding-window',
        hallucinationMitigation: 'none',
    },
};

/**
 * Development stage configuration with basic LLM integration
 */
const DEVELOPMENT_STAGE_CONFIG: StageConfiguration = {
    acquisition: {
        filter: 'rule-based',
        compressor: 'simple',
        consolidator: 'deduplicate',
        config: {
            filter: { maxSize: 1000, relevanceThreshold: 0.3 },
            compressor: { compressionRatio: 0.7 },
        },
    },
    encoding: {
        attention: 'llm-scoring',
        fusion: 'weighted-concat',
        config: {
            attention: { provider: 'openai', batchSize: 5 },
        },
    },
    derivation: {
        reflection: 'simple',
        summarization: 'llm-summary',
        distillation: 'concept-extraction',
        forgetting: 'time-based',
        config: {
            summarization: { provider: 'openai', maxLength: 500 },
            forgetting: { retentionDays: 30 },
        },
    },
    retrieval: {
        indexing: 'vector',
        matching: 'cosine',
        config: {
            indexing: { dimensions: 1536, provider: 'openai' },
        },
    },
    neuralMemory: {
        associative: 'simple',
        parameterIntegration: 'none',
    },
    utilization: {
        rag: 'fusion',
        longContext: 'hierarchical',
        hallucinationMitigation: 'confidence-scoring',
    },
};

/**
 * Production stage configuration with full LLM and vector integration
 */
const PRODUCTION_STAGE_CONFIG: StageConfiguration = {
    acquisition: {
        filter: 'llm-based',
        compressor: 'llm-summary',
        consolidator: 'cluster',
        config: {
            filter: { provider: 'openai', relevanceThreshold: 0.5 },
            compressor: { provider: 'openai', compressionRatio: 0.5 },
            consolidator: { clusterThreshold: 0.8 },
        },
    },
    encoding: {
        attention: 'transformer',
        fusion: 'cross-attention',
        config: {
            attention: { provider: 'openai', layers: 3 },
            fusion: { attentionHeads: 8 },
        },
    },
    derivation: {
        reflection: 'llm-reflection',
        summarization: 'hierarchical',
        distillation: 'llm-distill',
        forgetting: 'relevance-based',
        config: {
            reflection: { provider: 'anthropic', depth: 2 },
            summarization: { provider: 'openai', levels: 3 },
            distillation: { provider: 'openai', conceptThreshold: 0.7 },
            forgetting: { relevanceThreshold: 0.2, capacityLimit: 10000 },
        },
    },
    retrieval: {
        indexing: 'hybrid',
        matching: 'neural',
        config: {
            indexing: { vectorProvider: 'openai', keywordWeight: 0.3 },
            matching: { provider: 'openai', rerankTop: 10 },
        },
    },
    neuralMemory: {
        associative: 'attention-based',
        parameterIntegration: 'lora',
        config: {
            associative: { memorySize: 1000, associationThreshold: 0.6 },
            parameterIntegration: { rank: 16, alpha: 32, targetModules: ['q_proj', 'v_proj'] },
        },
    },
    utilization: {
        rag: 'iterative',
        longContext: 'compression',
        hallucinationMitigation: 'retrieval-verification',
        config: {
            rag: { maxIterations: 3, convergenceThreshold: 0.9 },
            longContext: { compressionRatio: 0.3, windowSize: 4000 },
            hallucinationMitigation: { verificationThreshold: 0.8 },
        },
    },
};

/**
 * Research configuration with experimental features
 */
const RESEARCH_STAGE_CONFIG: StageConfiguration = {
    acquisition: {
        filter: 'llm-based',
        compressor: 'semantic',
        consolidator: 'cluster',
        config: {
            filter: { provider: 'anthropic', multiStep: true },
            compressor: { provider: 'anthropic', semanticPreservation: 0.9 },
        },
    },
    encoding: {
        attention: 'transformer',
        fusion: 'late-fusion',
        config: {
            attention: { provider: 'anthropic', experimentalFeatures: true },
        },
    },
    derivation: {
        reflection: 'meta-cognitive',
        summarization: 'hierarchical',
        distillation: 'llm-distill',
        forgetting: 'capacity-based',
        config: {
            reflection: { provider: 'anthropic', metacognitionDepth: 3 },
            summarization: { provider: 'anthropic', adaptiveLength: true },
        },
    },
    retrieval: {
        indexing: 'graph',
        matching: 'neural',
        config: {
            indexing: { graphType: 'knowledge', relationExtraction: true },
            matching: { provider: 'anthropic', contextualRanking: true },
        },
    },
    neuralMemory: {
        associative: 'graph-neural',
        parameterIntegration: 'qlora',
        config: {
            associative: { graphLayers: 3, nodeEmbedding: 512 },
            parameterIntegration: { quantization: '4bit', rank: 32 },
        },
    },
    utilization: {
        rag: 'graph-rag',
        longContext: 'hierarchical',
        hallucinationMitigation: 'fact-checking',
        config: {
            rag: { graphTraversal: 'adaptive', maxHops: 3 },
            hallucinationMitigation: { factCheckProvider: 'anthropic' },
        },
    },
};

/**
 * High-performance configuration optimized for speed
 */
const HIGH_PERFORMANCE_STAGE_CONFIG: StageConfiguration = {
    acquisition: {
        filter: 'rule-based',
        compressor: 'gzip',
        consolidator: 'merge',
        config: {
            filter: { fastMode: true, parallelProcessing: true },
            compressor: { level: 6 },
        },
    },
    encoding: {
        attention: 'simple',
        fusion: 'concat',
    },
    derivation: {
        reflection: 'none',
        summarization: 'extractive',
        distillation: 'key-value',
        forgetting: 'time-based',
        config: {
            summarization: { fastExtraction: true },
            forgetting: { batchProcessing: true },
        },
    },
    retrieval: {
        indexing: 'vector',
        matching: 'cosine',
        config: {
            indexing: { fastIndexing: true, approximateSearch: true },
            matching: { cacheResults: true },
        },
    },
    neuralMemory: {
        associative: 'simple',
        parameterIntegration: 'none',
    },
    utilization: {
        rag: 'simple',
        longContext: 'sliding-window',
        hallucinationMitigation: 'confidence-scoring',
        config: {
            rag: { cacheEnabled: true },
            longContext: { fastWindowing: true },
        },
    },
};

/**
 * Create a memory type configuration with the given stage config and profile
 */
function createMemoryTypeConfig(
    stageConfig: StageConfiguration,
    profile: ConfigProfile
): MemoryTypeConfig {
    return {
        stages: stageConfig,
        providers: DEFAULT_PROVIDERS,
        concurrency: DEFAULT_CONCURRENCY[profile],
        enabledStages: {
            acquisition: true,
            encoding: true,
            derivation: true,
            retrieval: true,
            neuralMemory: profile !== 'minimal',
            utilization: true,
        },
    };
}

/**
 * Default configurations for each profile
 */
export const DEFAULT_CONFIGS: Record<ConfigProfile, MemoryLifecycleConfig> = {
    minimal: {
        profile: 'minimal',
        workingMemory: createMemoryTypeConfig(MINIMAL_STAGE_CONFIG, 'minimal'),
        semanticLTM: createMemoryTypeConfig(MINIMAL_STAGE_CONFIG, 'minimal'),
        episodicLTM: createMemoryTypeConfig(MINIMAL_STAGE_CONFIG, 'minimal'),
        retrieval: createMemoryTypeConfig(MINIMAL_STAGE_CONFIG, 'minimal'),
        global: {
            concurrency: DEFAULT_CONCURRENCY.minimal,
            providers: DEFAULT_PROVIDERS,
            monitoring: {
                enableMetrics: false,
                enableTracing: false,
                logLevel: 'warn',
            },
        },
    },
    development: {
        profile: 'development',
        workingMemory: createMemoryTypeConfig(DEVELOPMENT_STAGE_CONFIG, 'development'),
        semanticLTM: createMemoryTypeConfig(DEVELOPMENT_STAGE_CONFIG, 'development'),
        episodicLTM: createMemoryTypeConfig(DEVELOPMENT_STAGE_CONFIG, 'development'),
        retrieval: createMemoryTypeConfig(DEVELOPMENT_STAGE_CONFIG, 'development'),
        global: {
            concurrency: DEFAULT_CONCURRENCY.development,
            providers: DEFAULT_PROVIDERS,
            monitoring: {
                enableMetrics: true,
                enableTracing: true,
                logLevel: 'debug',
            },
        },
    },
    production: {
        profile: 'production',
        workingMemory: createMemoryTypeConfig(PRODUCTION_STAGE_CONFIG, 'production'),
        semanticLTM: createMemoryTypeConfig(PRODUCTION_STAGE_CONFIG, 'production'),
        episodicLTM: createMemoryTypeConfig(PRODUCTION_STAGE_CONFIG, 'production'),
        retrieval: createMemoryTypeConfig(PRODUCTION_STAGE_CONFIG, 'production'),
        global: {
            concurrency: DEFAULT_CONCURRENCY.production,
            providers: DEFAULT_PROVIDERS,
            monitoring: {
                enableMetrics: true,
                enableTracing: false,
                logLevel: 'info',
            },
        },
    },
    research: {
        profile: 'research',
        workingMemory: createMemoryTypeConfig(RESEARCH_STAGE_CONFIG, 'research'),
        semanticLTM: createMemoryTypeConfig(RESEARCH_STAGE_CONFIG, 'research'),
        episodicLTM: createMemoryTypeConfig(RESEARCH_STAGE_CONFIG, 'research'),
        retrieval: createMemoryTypeConfig(RESEARCH_STAGE_CONFIG, 'research'),
        global: {
            concurrency: DEFAULT_CONCURRENCY.research,
            providers: DEFAULT_PROVIDERS,
            monitoring: {
                enableMetrics: true,
                enableTracing: true,
                logLevel: 'debug',
            },
        },
    },
    'high-performance': {
        profile: 'high-performance',
        workingMemory: createMemoryTypeConfig(HIGH_PERFORMANCE_STAGE_CONFIG, 'high-performance'),
        semanticLTM: createMemoryTypeConfig(HIGH_PERFORMANCE_STAGE_CONFIG, 'high-performance'),
        episodicLTM: createMemoryTypeConfig(HIGH_PERFORMANCE_STAGE_CONFIG, 'high-performance'),
        retrieval: createMemoryTypeConfig(HIGH_PERFORMANCE_STAGE_CONFIG, 'high-performance'),
        global: {
            concurrency: DEFAULT_CONCURRENCY['high-performance'],
            providers: DEFAULT_PROVIDERS,
            monitoring: {
                enableMetrics: true,
                enableTracing: false,
                logLevel: 'warn',
            },
        },
    },
};

/**
 * Get default configuration for a specific profile
 */
export function getDefaultConfig(profile: ConfigProfile): MemoryLifecycleConfig {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIGS[profile]));
}

/**
 * Get default concurrency configuration for a profile
 */
export function getDefaultConcurrency(profile: ConfigProfile): ConcurrencyConfig {
    return JSON.parse(JSON.stringify(DEFAULT_CONCURRENCY[profile]));
}

/**
 * Get default provider configuration
 */
export function getDefaultProvider(providerName: string): ProviderConfig | undefined {
    return DEFAULT_PROVIDERS[providerName] ?
        JSON.parse(JSON.stringify(DEFAULT_PROVIDERS[providerName])) :
        undefined;
} 