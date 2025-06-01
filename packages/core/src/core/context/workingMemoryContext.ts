import { UnifiedMemoryService } from '../memory/UnifiedMemoryService.js';
import { MemoryLifecycleConfig } from '../memory/lifecycle/config/types.js';
import { getMemoryProfile } from '../memory/lifecycle/config/MemoryProfiles.js';
import { WorkingVariables } from '../../shared/types/workingMemory.js';
import { TaskContext } from '../../shared/types/index.js';
import { MLOSemanticBackend, MLOEpisodicBackend, MLOEmbedBackend } from '../memory/MLOBackends.js';
import { SemanticMemoryRegistry } from '../memory/SemanticMemoryRegistry.js';
import { EpisodicMemoryRegistry } from '../memory/EpisodicMemoryRegistry.js';
import { EmbedMemoryRegistry } from '../memory/EmbedMemoryRegistry.js';
import { logger } from '@callagent/utils';

const contextLogger = logger.createLogger({ prefix: 'WorkingMemoryContext' });

/**
 * Creates a simple working variables proxy that provides immediate synchronous access
 * with background persistence through the MLO pipeline.
 * 
 * This approach:
 * 1. Maintains local cache for immediate access
 * 2. Returns cached values synchronously for reads
 * 3. Updates cache immediately for writes
 * 4. Syncs to database in background for persistence
 * 
 * Note: This means variables are only available after being set in the current session.
 * For persistence across sessions, agents should reload their state explicitly.
 */
function createSimpleWorkingVariablesProxy(
    unifiedMemory: UnifiedMemoryService,
    agentId: string
): WorkingVariables {
    // Local cache for immediate synchronous access
    const cache = new Map<string, unknown>();

    contextLogger.debug('Created working variables proxy with local cache', {
        agentId
    });

    return new Proxy({} as WorkingVariables, {
        get(target, prop: string) {
            // Return cached value synchronously
            return cache.get(prop);
        },

        set(target, prop: string, value: unknown) {
            // Update cache immediately for synchronous access
            cache.set(prop, value);

            // Persist to database in background (fire and forget)
            unifiedMemory.setWorkingVariable(prop, value, agentId).catch(error => {
                contextLogger.warn(`Failed to persist working variable ${prop}`, {
                    agentId,
                    error
                });
                // On failure, we could implement retry logic or revert cache
            });

            return true;
        },

        has(target, prop: string) {
            return cache.has(prop);
        },

        deleteProperty(target, prop: string) {
            // Remove from cache immediately
            cache.delete(prop);

            // Delete from database in background
            unifiedMemory.setWorkingVariable(prop, undefined, agentId).catch(error => {
                contextLogger.warn(`Failed to delete working variable ${prop}`, {
                    agentId,
                    error
                });
            });

            return true;
        },

        ownKeys(target) {
            return Array.from(cache.keys());
        },

        getOwnPropertyDescriptor(target, prop: string) {
            if (cache.has(prop)) {
                return {
                    enumerable: true,
                    configurable: true,
                    value: cache.get(prop)
                };
            }
            return undefined;
        }
    });
}

/**
 * Legacy async proxy for backward compatibility
 * @deprecated Use createCachedWorkingVariablesProxy instead
 */
function createAsyncWorkingVariablesProxy(
    unifiedMemory: UnifiedMemoryService,
    agentId: string
): WorkingVariables {
    return new Proxy({} as WorkingVariables, {
        get(target, prop: string) {
            // Return a Promise for async operations
            // Note: This breaks the sync interface but is necessary for MLO integration
            return unifiedMemory.getWorkingVariable(prop, agentId);
        },
        set(target, prop: string, value: unknown) {
            // Fire and forget for set operations
            unifiedMemory.setWorkingVariable(prop, value, agentId).catch(error => {
                console.warn(`Failed to set working variable ${prop}:`, error);
            });
            return true;
        },
        has(target, prop: string) {
            // This is problematic as it needs to be sync but the underlying operation is async
            // For now, return true and let the get operation handle the actual check
            return true;
        },
        deleteProperty(target, prop: string) {
            // Delete by setting to undefined
            unifiedMemory.setWorkingVariable(prop, undefined, agentId).catch(error => {
                console.warn(`Failed to delete working variable ${prop}:`, error);
            });
            return true;
        }
    });
}

/**
 * Resolve memory configuration from agent manifest
 * 
 * This function extracts memory configuration from the agent's manifest
 * and applies any overrides specified in the agent.json file.
 */
function resolveMemoryConfiguration(agentConfig: unknown): MemoryLifecycleConfig {
    let config = getMemoryProfile('basic'); // Default profile

    if (!config) {
        throw new Error('Failed to load basic memory profile');
    }

    // Type-safe access to agent config
    const typedConfig = agentConfig as {
        memory?: {
            profile?: string;
            workingMemory?: Record<string, unknown>;
        };
    };

    // Apply profile from agent.json if specified
    if (typedConfig?.memory?.profile) {
        const profileConfig = getMemoryProfile(typedConfig.memory.profile);
        if (profileConfig) {
            config = profileConfig;
        } else {
            console.warn(`Unknown memory profile '${typedConfig.memory.profile}', using basic profile`);
        }
    }

    // Apply working memory overrides from agent.json
    if (typedConfig?.memory?.workingMemory) {
        config = {
            ...config,
            workingMemory: {
                ...config.workingMemory,
                ...typedConfig.memory.workingMemory
            }
        };
    }

    return config;
}

/**
 * Extend context with full memory capabilities
 * 
 * This function creates a UnifiedMemoryService instance and integrates it
 * with the TaskContext to provide comprehensive memory operations including:
 * - Working memory operations (goals, thoughts, decisions, variables)
 * - Semantic memory operations (backward compatible)
 * - Episodic memory operations (backward compatible)
 * - Unified recall/remember operations
 * - Direct MLO access
 */
export function extendContextWithMemory(
    baseContext: Record<string, unknown>,
    tenantId: string,
    agentId: string,
    agentConfig: unknown,
    existingSemanticAdapter?: unknown
): TaskContext {
    const memoryConfig = resolveMemoryConfiguration(agentConfig);

    // Create UnifiedMemoryService with proper configuration
    const unifiedMemory = new UnifiedMemoryService(tenantId, {
        memoryLifecycleConfig: memoryConfig,
        semanticAdapter: existingSemanticAdapter as any, // Type assertion for backward compatibility
        agentId
    });

    const context = baseContext as TaskContext;

    // Add working memory operations
    context.setGoal = async (goal: string) => unifiedMemory.setGoal(goal, agentId);
    context.getGoal = async () => unifiedMemory.getGoal(agentId);
    context.addThought = async (thought: string) => unifiedMemory.addThought(thought, agentId);
    context.getThoughts = async () => unifiedMemory.getThoughts(agentId);
    context.makeDecision = async (key: string, decision: string, reasoning?: string) =>
        unifiedMemory.makeDecision(key, decision, reasoning, agentId);
    context.getDecision = async (key: string) => unifiedMemory.getDecision(key, agentId);

    // Add simple working variables for synchronous access
    context.vars = createSimpleWorkingVariablesProxy(unifiedMemory, agentId);

    // Add unified operations
    context.recall = async (query: string, options?: any) => unifiedMemory.recall(query, options);
    context.remember = async (key: string, value: unknown, options?: any) =>
        unifiedMemory.remember(key, value, options);

    // Replace memory interface with MLO-backed registries
    context.memory = {
        // Create MLO-backed registries that route all operations through UnifiedMemoryService
        semantic: new SemanticMemoryRegistry(
            { mlo: new MLOSemanticBackend(unifiedMemory, existingSemanticAdapter) },
            'mlo'
        ),
        episodic: new EpisodicMemoryRegistry(
            { mlo: new MLOEpisodicBackend(unifiedMemory) },
            'mlo'
        ),
        embed: new EmbedMemoryRegistry(
            { mlo: new MLOEmbedBackend(unifiedMemory) },
            'mlo'
        ),

        // Direct MLO access for advanced use cases
        mlo: unifiedMemory,
    };

    return context;
}

/**
 * Legacy function name for backward compatibility
 * @deprecated Use extendContextWithMemory instead
 */
export function extendContextWithWorkingMemory(
    baseContext: Record<string, unknown>,
    workingMemory: unknown
): Record<string, unknown> {
    console.warn('extendContextWithWorkingMemory is deprecated. Use extendContextWithMemory instead.');

    // For backward compatibility, return the base context with minimal working memory operations
    return {
        ...baseContext,
        setGoal: async () => { throw new Error('Legacy working memory not supported. Use extendContextWithMemory.'); },
        getGoal: async () => { throw new Error('Legacy working memory not supported. Use extendContextWithMemory.'); },
        addThought: async () => { throw new Error('Legacy working memory not supported. Use extendContextWithMemory.'); },
        getThoughts: async () => { throw new Error('Legacy working memory not supported. Use extendContextWithMemory.'); },
        makeDecision: async () => { throw new Error('Legacy working memory not supported. Use extendContextWithMemory.'); },
        getDecision: async () => { throw new Error('Legacy working memory not supported. Use extendContextWithMemory.'); },
        vars: {},
        recall: async () => [],
        remember: async () => { },
    };
}

/**
 * Legacy function for creating working variables proxy
 * @deprecated Use extendContextWithMemory instead
 */
export function createLegacyWorkingVariablesProxy(wm: unknown): WorkingVariables {
    console.warn('createWorkingVariablesProxy is deprecated. Use extendContextWithMemory instead.');
    return {};
} 