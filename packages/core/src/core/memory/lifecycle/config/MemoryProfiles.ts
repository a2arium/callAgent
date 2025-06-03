import { MemoryLifecycleConfig, StageConfiguration, MemoryTypeConfig } from './types.js';
import { getDefaultConcurrency, DEFAULT_CONFIGS } from './defaults.js';

/**
 * Memory Profiles provide concrete implementations for different use cases.
 * These profiles specify exact component implementations for each stage of the MLO pipeline.
 * 
 * Phase 1 Implementation Notes:
 * - Uses placeholder implementations that will be replaced with actual components in Phase 2
 * - Focuses on establishing the pipeline structure and configuration patterns
 * - All profiles use tenant-aware components for multi-tenant support
 */

/**
 * Basic profile stage configuration - minimal functionality for simple use cases
 */
const BASIC_STAGE_CONFIG: StageConfiguration = {
    acquisition: {
        filter: 'TenantAwareFilter',
        compressor: 'TextTruncationCompressor',
        consolidator: 'NoveltyConsolidator',
        config: {
            filter: {
                maxInputSize: 2500, // Increased to accommodate MLO processing overhead
                tenantIsolation: true,
                basicRelevanceThreshold: 0.1
            },
            compressor: {
                maxLength: 500,
                preserveStructure: false
            },
            consolidator: {
                enabled: false
            }
        }
    },
    encoding: {
        attention: 'ConversationAttention',
        fusion: 'ModalityFusion',
        config: {
            attention: {
                passThrough: true,
                preserveOrder: true
            },
            fusion: {
                enabled: false,
                modalityType: 'text',
                concatenationStrategy: 'simple'
            }
        }
    },
    derivation: {
        reflection: 'ConversationReflection',
        summarization: 'SimpleSummarizer',
        distillation: 'SimpleDistiller',
        forgetting: 'TimeDecayForgetter',
        config: {
            reflection: {
                enabled: true,
                placeholder: false
            },
            summarization: {
                strategy: 'truncate',
                maxSummaryLength: 200
            },
            distillation: {
                enabled: true,
                placeholder: false
            },
            forgetting: {
                decayRate: 0.1,
                timeWindow: '24h',
                retentionThreshold: 0.3
            }
        }
    },
    retrieval: {
        indexing: 'DirectMemoryIndexer',
        matching: 'SimpleTopKMatcher',
        config: {
            indexing: {
                strategy: 'direct',
                cacheEnabled: true,
                tenantIsolation: true
            },
            matching: {
                topK: 5,
                similarityThreshold: 0.5,
                algorithm: 'simple'
            }
        }
    },
    neuralMemory: {
        associative: 'PlaceholderAssociative',
        parameterIntegration: 'PlaceholderParameterIntegration',
        config: {
            associative: {
                enabled: false,
                placeholder: true
            },
            parameterIntegration: {
                enabled: false,
                placeholder: true
            }
        }
    },
    utilization: {
        rag: 'SimpleRAG',
        longContext: 'SimpleLongContextManager',
        hallucinationMitigation: 'SimpleHallucinationMitigator',
        config: {
            rag: {
                strategy: 'simple',
                maxRetrievedItems: 3,
                contextWindow: 1000
            },
            longContext: {
                windowSize: 2000,
                overlapSize: 200,
                strategy: 'sliding'
            },
            hallucinationMitigation: {
                enabled: false,
                placeholder: true
            }
        }
    }
};

/**
 * Conversational profile stage configuration - optimized for dialogue and chat scenarios
 */
const CONVERSATIONAL_STAGE_CONFIG: StageConfiguration = {
    acquisition: {
        filter: 'TenantAwareFilter',
        compressor: 'TextTruncationCompressor',
        consolidator: 'NoveltyConsolidator',
        config: {
            filter: {
                maxInputSize: 2000,
                tenantIsolation: true,
                conversationAware: true,
                relevanceThreshold: 0.2
            },
            compressor: {
                maxLength: 800,
                preserveStructure: true,
                conversationFormat: true
            },
            consolidator: {
                enabled: true,
                strategy: 'conversation',
                mergeAdjacentTurns: true,
                preserveContext: true
            }
        }
    },
    encoding: {
        attention: 'ConversationAttention',
        fusion: 'ModalityFusion',
        config: {
            attention: {
                conversationAware: true,
                speakerTracking: true,
                turnBoundaries: true
            },
            fusion: {
                modalityType: 'conversation',
                speakerEmbedding: true,
                temporalOrdering: true
            }
        }
    },
    derivation: {
        reflection: 'ConversationReflection',
        summarization: 'SimpleSummarizer',
        distillation: 'SimpleDistiller',
        forgetting: 'TimeDecayForgetter',
        config: {
            reflection: {
                enabled: true,
                conversationAware: true,
                trackMisunderstandings: true
            },
            summarization: {
                strategy: 'dialogue',
                preserveSpeakers: true,
                maxSummaryLength: 300,
                topicAware: true
            },
            distillation: {
                enabled: true,
                extractTopics: true,
                trackIntents: true
            },
            forgetting: {
                decayRate: 0.05,
                timeWindow: '7d',
                retentionThreshold: 0.4,
                preserveImportantTurns: true
            }
        }
    },
    retrieval: {
        indexing: 'DirectMemoryIndexer',
        matching: 'SimpleTopKMatcher',
        config: {
            indexing: {
                strategy: 'conversation',
                speakerAware: true,
                topicIndexing: true,
                tenantIsolation: true
            },
            matching: {
                topK: 8,
                similarityThreshold: 0.4,
                algorithm: 'contextual',
                conversationAware: true
            }
        }
    },
    neuralMemory: {
        associative: 'PlaceholderAssociative',
        parameterIntegration: 'PlaceholderParameterIntegration',
        config: {
            associative: {
                enabled: true,
                conversationMemory: true,
                speakerAssociations: true
            },
            parameterIntegration: {
                enabled: false,
                placeholder: true
            }
        }
    },
    utilization: {
        rag: 'SimpleRAG',
        longContext: 'SimpleLongContextManager',
        hallucinationMitigation: 'SimpleHallucinationMitigator',
        config: {
            rag: {
                strategy: 'conversation',
                maxRetrievedItems: 5,
                contextWindow: 1500,
                preserveDialogueFlow: true
            },
            longContext: {
                windowSize: 3000,
                overlapSize: 300,
                strategy: 'dialogue',
                preserveTurnBoundaries: true
            },
            hallucinationMitigation: {
                enabled: true,
                consistencyChecking: true,
                conversationAware: true
            }
        }
    }
};

/**
 * Research-optimized profile stage configuration - designed for complex analysis and research tasks
 * Note: Many components are placeholders that will be enhanced with LLM integration in Phase 2
 */
const RESEARCH_OPTIMIZED_STAGE_CONFIG: StageConfiguration = {
    acquisition: {
        filter: 'TenantAwareFilter',
        compressor: 'TextTruncationCompressor', // Will become LLMSummaryCompressor in Phase 2
        consolidator: 'PlaceholderConsolidator', // Will become NoveltyScoringConsolidator in Phase 2
        config: {
            filter: {
                maxInputSize: 5000,
                tenantIsolation: true,
                researchMode: true,
                relevanceThreshold: 0.3,
                complexityAware: true
            },
            compressor: {
                maxLength: 2000,
                preserveStructure: true,
                preserveReferences: true,
                // Future LLM config:
                // llmProvider: 'anthropic',
                // summaryStyle: 'academic'
            },
            consolidator: {
                enabled: false, // Will be enabled in Phase 2
                placeholder: true,
                // Future config:
                // noveltyThreshold: 0.7,
                // duplicateDetection: true
            }
        }
    },
    encoding: {
        attention: 'PassThroughAttention', // Will become LLMScoringAttention in Phase 2
        fusion: 'ResearchFusion',
        config: {
            attention: {
                passThrough: true,
                preserveOrder: true,
                // Future LLM config:
                // llmProvider: 'openai',
                // scoringCriteria: ['relevance', 'novelty', 'importance']
            },
            fusion: {
                modalityType: 'research',
                preserveReferences: true,
                structureAware: true
            }
        }
    },
    derivation: {
        reflection: 'PlaceholderReflection', // Will become InsightReflection in Phase 2
        summarization: 'PlaceholderSummarizer', // Will become TopicAwareSummarizer in Phase 2
        distillation: 'PlaceholderDistiller', // Will become RuleExtractionDistiller in Phase 2
        forgetting: 'PlaceholderForgetter', // Will become SimilarityDedupe in Phase 2
        config: {
            reflection: {
                enabled: false,
                placeholder: true,
                // Future config:
                // insightExtraction: true,
                // llmProvider: 'anthropic'
            },
            summarization: {
                strategy: 'placeholder',
                maxSummaryLength: 500,
                // Future config:
                // topicAware: true,
                // hierarchicalSummary: true,
                // llmProvider: 'openai'
            },
            distillation: {
                enabled: false,
                placeholder: true,
                // Future config:
                // extractRules: true,
                // patternRecognition: true
            },
            forgetting: {
                decayRate: 0.02,
                timeWindow: '30d',
                retentionThreshold: 0.6,
                // Future config:
                // similarityDeduplication: true,
                // preserveUnique: true
            }
        }
    },
    retrieval: {
        indexing: 'ResearchIndexer',
        matching: 'SemanticMatcher',
        config: {
            indexing: {
                strategy: 'research',
                hierarchicalIndexing: true,
                topicClustering: true,
                tenantIsolation: true
            },
            matching: {
                topK: 10,
                similarityThreshold: 0.3,
                algorithm: 'semantic',
                researchMode: true
            }
        }
    },
    neuralMemory: {
        associative: 'ResearchAssociative',
        parameterIntegration: 'PlaceholderParameterIntegration', // Will become SimpleParameterUpdater in Phase 2
        config: {
            associative: {
                enabled: true,
                researchMemory: true,
                conceptAssociations: true,
                crossReferencing: true
            },
            parameterIntegration: {
                enabled: false,
                placeholder: true,
                // Future Phase 2 config:
                // method: 'lora',
                // targetLayers: ['attention', 'feedforward'],
                // learningRate: 0.0001
            }
        }
    },
    utilization: {
        rag: 'ResearchRAG',
        longContext: 'HierarchicalContextManager',
        hallucinationMitigation: 'FactChecker',
        config: {
            rag: {
                strategy: 'research',
                maxRetrievedItems: 15,
                contextWindow: 4000,
                hierarchicalRetrieval: true
            },
            longContext: {
                windowSize: 8000,
                overlapSize: 800,
                strategy: 'hierarchical',
                preserveStructure: true
            },
            hallucinationMitigation: {
                enabled: true,
                factChecking: true,
                sourceVerification: true,
                researchMode: true
            }
        }
    }
};

/**
 * Create a memory type configuration for a given stage configuration and profile
 */
function createMemoryTypeConfig(
    stageConfig: StageConfiguration,
    profileName: string
): MemoryTypeConfig {
    // Use appropriate concurrency based on profile complexity
    let concurrencyProfile: 'minimal' | 'development' | 'production';

    switch (profileName) {
        case 'basic':
            concurrencyProfile = 'minimal';
            break;
        case 'conversational':
            concurrencyProfile = 'development';
            break;
        case 'research-optimized':
            concurrencyProfile = 'production';
            break;
        default:
            concurrencyProfile = 'development';
    }

    return {
        stages: stageConfig,
        providers: {
            // Use default providers but with profile-specific models
            openai: {
                provider: 'openai',
                model: profileName === 'research-optimized' ? 'gpt-4o' : 'gpt-4o-mini',
                concurrency: getDefaultConcurrency(concurrencyProfile)
            },
            anthropic: {
                provider: 'anthropic',
                model: profileName === 'research-optimized' ? 'claude-3-5-sonnet-20241022' : 'claude-3-haiku-20240307',
                concurrency: getDefaultConcurrency(concurrencyProfile)
            },
            local: {
                provider: 'local',
                model: 'llama-3.1-8b',
                concurrency: getDefaultConcurrency('minimal') // Local is always conservative
            }
        },
        concurrency: getDefaultConcurrency(concurrencyProfile),
        enabledStages: {
            acquisition: true,
            encoding: true,
            derivation: true,
            retrieval: true,
            neuralMemory: profileName !== 'basic', // Disable neural memory for basic profile
            utilization: true
        }
    };
}

/**
 * Memory Profiles provide concrete implementations for different use cases
 */
export const MemoryProfiles: Record<string, MemoryLifecycleConfig> = {
    /**
     * Basic Profile - Minimal functionality for simple use cases
     * - Uses placeholder implementations for most advanced features
     * - Focuses on basic text processing and simple retrieval
     * - Suitable for lightweight applications with minimal memory requirements
     */
    basic: {
        profile: 'basic',
        workingMemory: createMemoryTypeConfig(BASIC_STAGE_CONFIG, 'basic'),
        semanticLTM: createMemoryTypeConfig(BASIC_STAGE_CONFIG, 'basic'),
        episodicLTM: createMemoryTypeConfig(BASIC_STAGE_CONFIG, 'basic'),
        retrieval: createMemoryTypeConfig(BASIC_STAGE_CONFIG, 'basic'),
        global: {
            concurrency: getDefaultConcurrency('minimal'),
            providers: {
                openai: {
                    provider: 'openai',
                    model: 'gpt-4o-mini',
                    concurrency: getDefaultConcurrency('minimal')
                },
                anthropic: {
                    provider: 'anthropic',
                    model: 'claude-3-haiku-20240307',
                    concurrency: getDefaultConcurrency('minimal')
                }
            },
            monitoring: {
                enableMetrics: false,
                enableTracing: false,
                logLevel: 'warn'
            }
        }
    },

    /**
     * Conversational Profile - Optimized for dialogue and chat scenarios
     * - Enhanced conversation-aware processing
     * - Speaker tracking and turn boundary preservation
     * - Topic-aware summarization and context management
     * - Suitable for chatbots, virtual assistants, and dialogue systems
     */
    conversational: {
        profile: 'conversational',
        workingMemory: createMemoryTypeConfig(CONVERSATIONAL_STAGE_CONFIG, 'conversational'),
        semanticLTM: createMemoryTypeConfig(CONVERSATIONAL_STAGE_CONFIG, 'conversational'),
        episodicLTM: createMemoryTypeConfig(CONVERSATIONAL_STAGE_CONFIG, 'conversational'),
        retrieval: createMemoryTypeConfig(CONVERSATIONAL_STAGE_CONFIG, 'conversational'),
        global: {
            concurrency: getDefaultConcurrency('development'),
            providers: {
                openai: {
                    provider: 'openai',
                    model: 'gpt-4o-mini',
                    concurrency: getDefaultConcurrency('development')
                },
                anthropic: {
                    provider: 'anthropic',
                    model: 'claude-3-haiku-20240307',
                    concurrency: getDefaultConcurrency('development')
                }
            },
            monitoring: {
                enableMetrics: true,
                enableTracing: true,
                logLevel: 'info'
            }
        }
    },

    /**
     * Research-Optimized Profile - Designed for complex analysis and research tasks
     * - Enhanced processing for academic and research content
     * - Hierarchical context management and semantic indexing
     * - Fact-checking and source verification capabilities
     * - Many components are placeholders for Phase 2 LLM integration
     * - Suitable for research assistants, academic tools, and knowledge work
     */
    'research-optimized': {
        profile: 'research-optimized',
        workingMemory: createMemoryTypeConfig(RESEARCH_OPTIMIZED_STAGE_CONFIG, 'research-optimized'),
        semanticLTM: createMemoryTypeConfig(RESEARCH_OPTIMIZED_STAGE_CONFIG, 'research-optimized'),
        episodicLTM: createMemoryTypeConfig(RESEARCH_OPTIMIZED_STAGE_CONFIG, 'research-optimized'),
        retrieval: createMemoryTypeConfig(RESEARCH_OPTIMIZED_STAGE_CONFIG, 'research-optimized'),
        global: {
            concurrency: getDefaultConcurrency('production'),
            providers: {
                openai: {
                    provider: 'openai',
                    model: 'gpt-4o',
                    concurrency: getDefaultConcurrency('production')
                },
                anthropic: {
                    provider: 'anthropic',
                    model: 'claude-3-5-sonnet-20241022',
                    concurrency: getDefaultConcurrency('production')
                }
            },
            monitoring: {
                enableMetrics: true,
                enableTracing: true,
                logLevel: 'debug'
            }
        }
    }
};

/**
 * Get a memory profile by name with deep copy to prevent mutation
 */
export function getMemoryProfile(profileName: string): MemoryLifecycleConfig | undefined {
    const profile = MemoryProfiles[profileName];
    return profile ? JSON.parse(JSON.stringify(profile)) : undefined;
}

/**
 * List all available memory profile names
 */
export function getAvailableProfiles(): string[] {
    return Object.keys(MemoryProfiles);
}

/**
 * Check if a profile name is valid
 */
export function isValidProfile(profileName: string): boolean {
    return profileName in MemoryProfiles;
}

/**
 * Get profile recommendations based on use case
 */
export function getProfileRecommendations(useCase: string): string[] {
    const recommendations: Record<string, string[]> = {
        'chatbot': ['conversational', 'basic'],
        'assistant': ['conversational', 'research-optimized'],
        'research': ['research-optimized', 'conversational'],
        'simple': ['basic', 'conversational'],
        'academic': ['research-optimized'],
        'dialogue': ['conversational', 'basic'],
        'analysis': ['research-optimized', 'conversational'],
        'lightweight': ['basic'],
        'production': ['conversational', 'research-optimized'],
        'development': ['basic', 'conversational']
    };

    return recommendations[useCase.toLowerCase()] || ['basic'];
} 