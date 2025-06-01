/**
 * Memory Lifecycle Orchestrator (MLO) Configuration Types
 * 
 * These types define the configuration structure for the 6-stage memory lifecycle:
 * 1. Acquisition (filter, compress, consolidate)
 * 2. Encoding (attention, multi-modal fusion)
 * 3. Derivation (reflection, summarization, distillation, forgetting)
 * 4. Retrieval (indexing, matching)
 * 5. Neural Memory (associative memory, parameter integration)
 * 6. Utilization (RAG, context management, hallucination mitigation)
 */

/**
 * Concurrency and rate limiting configuration for LLM and vector operations
 */
export type ConcurrencyConfig = {
    /** Maximum concurrent operations */
    maxConcurrency: number;
    /** Rate limit: requests per minute */
    rateLimit: number;
    /** Batch size for bulk operations */
    batchSize: number;
    /** Timeout for individual operations (ms) */
    timeout: number;
    /** Retry configuration */
    retry: {
        maxAttempts: number;
        backoffMs: number;
        exponentialBackoff: boolean;
    };
};

/**
 * Provider-specific configuration for external services
 */
export type ProviderConfig = {
    /** Provider name (e.g., 'openai', 'anthropic', 'local') */
    provider: string;
    /** Model or service identifier */
    model?: string;
    /** API endpoint override */
    endpoint?: string;
    /** Provider-specific options */
    options?: Record<string, unknown>;
    /** Concurrency controls for this provider */
    concurrency?: Partial<ConcurrencyConfig>;
};

/**
 * Stage-specific configuration with implementation selection
 */
export type StageConfiguration = {
    acquisition: {
        /** Filter implementation (e.g., 'simple', 'llm-based', 'rule-based') */
        filter: string;
        /** Compression implementation (e.g., 'gzip', 'llm-summary', 'semantic') */
        compressor: string;
        /** Consolidation implementation (e.g., 'merge', 'deduplicate', 'cluster') */
        consolidator: string;
        /** Configuration for each component */
        config?: {
            filter?: Record<string, unknown>;
            compressor?: Record<string, unknown>;
            consolidator?: Record<string, unknown>;
        };
    };
    encoding: {
        /** Attention mechanism (e.g., 'simple', 'llm-scoring', 'transformer') */
        attention: string;
        /** Multi-modal fusion (e.g., 'concat', 'cross-attention', 'late-fusion') */
        fusion: string;
        /** Configuration for each component */
        config?: {
            attention?: Record<string, unknown>;
            fusion?: Record<string, unknown>;
        };
    };
    derivation: {
        /** Reflection implementation (e.g., 'simple', 'llm-reflection', 'meta-cognitive') */
        reflection: string;
        /** Summarization implementation (e.g., 'extractive', 'llm-summary', 'hierarchical') */
        summarization: string;
        /** Distillation implementation (e.g., 'key-value', 'concept-extraction', 'llm-distill') */
        distillation: string;
        /** Forgetting mechanism (e.g., 'time-based', 'relevance-based', 'capacity-based') */
        forgetting: string;
        /** Configuration for each component */
        config?: {
            reflection?: Record<string, unknown>;
            summarization?: Record<string, unknown>;
            distillation?: Record<string, unknown>;
            forgetting?: Record<string, unknown>;
        };
    };
    retrieval: {
        /** Indexing strategy (e.g., 'vector', 'keyword', 'hybrid', 'graph') */
        indexing: string;
        /** Matching algorithm (e.g., 'cosine', 'semantic', 'bm25', 'neural') */
        matching: string;
        /** Configuration for each component */
        config?: {
            indexing?: Record<string, unknown>;
            matching?: Record<string, unknown>;
        };
    };
    neuralMemory: {
        /** Associative memory (e.g., 'hopfield', 'attention-based', 'graph-neural') */
        associative: string;
        /** Parameter integration (e.g., 'lora', 'qlora', 'adapter', 'fine-tune') */
        parameterIntegration: string;
        /** Configuration for each component */
        config?: {
            associative?: Record<string, unknown>;
            parameterIntegration?: Record<string, unknown>;
        };
    };
    utilization: {
        /** RAG implementation (e.g., 'simple', 'fusion', 'iterative', 'graph-rag') */
        rag: string;
        /** Long context management (e.g., 'sliding-window', 'hierarchical', 'compression') */
        longContext: string;
        /** Hallucination mitigation (e.g., 'confidence-scoring', 'fact-checking', 'retrieval-verification') */
        hallucinationMitigation: string;
        /** Configuration for each component */
        config?: {
            rag?: Record<string, unknown>;
            longContext?: Record<string, unknown>;
            hallucinationMitigation?: Record<string, unknown>;
        };
    };
};

/**
 * Memory type-specific configuration profiles
 */
export type MemoryTypeConfig = {
    /** Stage configuration for this memory type */
    stages: StageConfiguration;
    /** Provider configurations for external services */
    providers?: Record<string, ProviderConfig>;
    /** Global concurrency settings for this memory type */
    concurrency?: ConcurrencyConfig;
    /** Enable/disable specific stages */
    enabledStages?: {
        acquisition?: boolean;
        encoding?: boolean;
        derivation?: boolean;
        retrieval?: boolean;
        neuralMemory?: boolean;
        utilization?: boolean;
    };
};

/**
 * Complete MLO configuration covering all memory types
 */
export type MemoryLifecycleConfig = {
    /** Configuration profile name (e.g., 'development', 'production', 'research') */
    profile?: string;
    /** Working memory configuration */
    workingMemory: MemoryTypeConfig;
    /** Semantic long-term memory configuration */
    semanticLTM: MemoryTypeConfig;
    /** Episodic long-term memory configuration */
    episodicLTM: MemoryTypeConfig;
    /** Retrieval-specific configuration */
    retrieval: MemoryTypeConfig;
    /** Global settings that apply across all memory types */
    global?: {
        /** Global concurrency limits */
        concurrency?: ConcurrencyConfig;
        /** Global provider configurations */
        providers?: Record<string, ProviderConfig>;
        /** Tenant-specific overrides */
        tenantOverrides?: Record<string, Partial<MemoryLifecycleConfig>>;
        /** Debug and monitoring settings */
        monitoring?: {
            enableMetrics: boolean;
            enableTracing: boolean;
            logLevel: 'debug' | 'info' | 'warn' | 'error';
        };
    };
};

/**
 * Runtime configuration that can be dynamically updated
 */
export type RuntimeConfig = {
    /** Current active configuration */
    config: MemoryLifecycleConfig;
    /** Configuration version for cache invalidation */
    version: string;
    /** Last updated timestamp */
    updatedAt: string;
    /** Configuration source (e.g., 'file', 'database', 'api') */
    source: string;
};

/**
 * Configuration validation result
 */
export type ConfigValidationResult = {
    /** Whether the configuration is valid */
    valid: boolean;
    /** Validation errors if any */
    errors: string[];
    /** Validation warnings */
    warnings: string[];
    /** Suggested fixes */
    suggestions?: string[];
};

/**
 * Default configuration profiles for different environments
 */
export type ConfigProfile = 'minimal' | 'development' | 'production' | 'research' | 'high-performance';

/**
 * Configuration builder options for creating configurations programmatically
 */
export type ConfigBuilderOptions = {
    /** Base profile to start from */
    profile: ConfigProfile;
    /** Memory types to configure */
    memoryTypes: Array<'workingMemory' | 'semanticLTM' | 'episodicLTM' | 'retrieval'>;
    /** Override specific implementations */
    overrides?: Partial<MemoryLifecycleConfig>;
    /** Enable experimental features */
    experimental?: boolean;
}; 