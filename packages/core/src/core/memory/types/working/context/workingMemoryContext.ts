import { UnifiedMemoryService } from '../../../UnifiedMemoryService.js';
import { MemoryLifecycleConfig } from '../../../lifecycle/config/types.js';
import { getMemoryProfile } from '../../../lifecycle/config/MemoryProfiles.js';
import { WorkingVariables } from '../../../../../shared/types/workingMemory.js';
import { TaskContext } from '../../../../../shared/types/index.js';
import { WorkingMemoryBackend } from '@a2arium/callagent-types';
import { MLOSemanticBackend, MLOEpisodicBackend, MLOEmbedBackend } from '../../../MLOBackends.js';
import { SemanticMemoryRegistry } from '../../semantic/SemanticMemoryRegistry.js';
import { EpisodicMemoryRegistry } from '../../episodic/EpisodicMemoryRegistry.js';
import { EmbedMemoryRegistry } from '../../embed/EmbedMemoryRegistry.js';
import { logger } from '@a2arium/callagent-utils';

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
export async function extendContextWithMemory(
    baseContext: Record<string, unknown>,
    tenantId: string,
    agentId: string,
    agentConfig: unknown,
    existingSemanticAdapter?: unknown,
    existingPrismaClient?: unknown
): Promise<TaskContext> {
    const memoryConfig = resolveMemoryConfiguration(agentConfig);

    // Create working memory adapter if SQL adapter is available
    let workingMemoryAdapter: WorkingMemoryBackend | undefined;
    try {
        const { PrismaClient } = await import('@prisma/client');
        const { WorkingMemorySQLAdapter } = await import('@a2arium/callagent-memory-sql') as any;

        // Use existing PrismaClient if provided, otherwise create new one
        const prisma = existingPrismaClient as any || new PrismaClient();
        workingMemoryAdapter = new WorkingMemorySQLAdapter(prisma, {
            defaultTenantId: tenantId
        });

        contextLogger.debug('Working memory adapter created successfully', {
            tenantId,
            agentId
        });
    } catch (error) {
        contextLogger.warn('Failed to create working memory adapter, using placeholder', {
            tenantId,
            agentId,
            error: error instanceof Error ? error.message : 'Unknown error'
        });
    }

    // Use the provided semantic adapter (should be inherited from parent)
    const semanticMemoryAdapter = existingSemanticAdapter as any;

    // Create UnifiedMemoryService with proper configuration
    const unifiedMemory = new UnifiedMemoryService(tenantId, {
        memoryLifecycleConfig: memoryConfig,
        workingMemoryAdapter,
        semanticAdapter: semanticMemoryAdapter,
        agentId
    });

    const context = baseContext as TaskContext;

    // Add new namespaced helpers
    (context as any).goals = {
        add: async (g: any) => unifiedMemory.setGoal(String(g?.title || g), agentId),
        update: async (_id: string, _patch: any) => { /* no-op for now */ },
        remove: async (_id: string) => { /* no-op for now */ },
        clear: async () => { /* no-op for now */ },
        read: async () => {
            const g = await unifiedMemory.getGoal(agentId);
            return g ? [{ id: 'current', title: g }] : [];
        }
    };
    (context as any).thoughts = { add: async (t: any) => unifiedMemory.addThought(String(t?.text ?? t), agentId) };
    (context as any).decisions = {
        add: async (key: string, value: unknown, reasoning?: string) => {
            const serialized = typeof value === 'string' ? value : JSON.stringify(value);
            await unifiedMemory.makeDecision(key, serialized, reasoning, agentId);
        },
        get: async (key: string) => {
            const decision = await unifiedMemory.getDecision(key, agentId);
            if (!decision) {
                return null;
            }
            return {
                key,
                value: decision.decision,
                reasoning: decision.reasoning,
                ts: decision.timestamp
            };
        },
        read: async (filter?: { prefix?: string }) => {
            const decisions = await unifiedMemory.getAllDecisions(agentId);
            const entries = Object.entries(decisions).map(([decisionKey, entry]) => ({
                key: decisionKey,
                value: entry.decision,
                reasoning: entry.reasoning,
                ts: entry.timestamp
            }));

            if (filter?.prefix) {
                return entries.filter(({ key }) => key.startsWith(filter.prefix!));
            }

            return entries;
        }
    };

    // Add simple working variables for synchronous access
    context.vars = createSimpleWorkingVariablesProxy(unifiedMemory, agentId) as any;

    // Add unified operations
    context.recall = async (query: string, options?: any) => unifiedMemory.recall(query, options);
    context.remember = async (key: string, value: unknown, options?: any) =>
        unifiedMemory.remember(key, value, options);

    // Replace memory interface with MLO-backed registries
    context.memory = {
        // Create MLO-backed registries that route all operations through UnifiedMemoryService
        semantic: new SemanticMemoryRegistry(
            { mlo: new MLOSemanticBackend(unifiedMemory, existingSemanticAdapter, context) },
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

    // registry constructed

    // Semantic facade wired to memory.semantic, supporting tags/entities
    (context as any).semantic = {
        add: async (item: { id: string; value: unknown; tags?: string[]; entities?: Record<string, unknown> }) => {
            await (context.memory as any)?.semantic?.set?.(item.id, item.value, { tags: item.tags, entities: item.entities });
        },
        read: async (filter?: { id?: string | string[]; tag?: string; tags?: string[]; limit?: number; filters?: unknown[] }) => {
            // Delegate complex queries directly
            if (filter && (filter.filters || filter.tag || filter.tags)) {
                const res = await (context.memory as any)?.semantic?.read?.(filter);
                return Array.isArray(res)
                    ? res.map((r: any) => ({ id: r?.key ?? r?.id, value: r?.value, tags: r?.tags, entities: r?.entities }))
                    : [];
            }
            // Prefer direct pattern when id is a string or array of strings
            if (filter?.id) {
                const ids = Array.isArray(filter.id) ? filter.id : [filter.id];
                const results: any[] = [];
                for (const id of ids) {
                    const res = await (context.memory as any)?.semantic?.read?.(id);
                    if (Array.isArray(res)) results.push(...res);
                }
                const mapped = results.map((r: any) => ({ id: r?.key ?? r?.id, value: r?.value, tags: r?.tags, entities: r?.entities }));
                return typeof filter.limit === 'number' ? mapped.slice(0, Math.max(0, filter.limit)) : mapped;
            }

            // Fallback: read all then filter client-side
            const res = await (context.memory as any)?.semantic?.read?.('*');
            const mapped = Array.isArray(res)
                ? res.map((r: any) => ({ id: r?.key ?? r?.id, value: r?.value, tags: r?.tags, entities: r?.entities }))
                : [];
            return typeof filter?.limit === 'number' ? mapped.slice(0, Math.max(0, filter.limit!)) : mapped;
        },
        remove: async (idOrPredicate: string | ((item: { id: string; value: unknown; tags?: string[]; entities?: Record<string, unknown> }) => boolean)) => {
            if (typeof idOrPredicate === 'string') {
                await (context.memory as any)?.semantic?.delete?.(idOrPredicate);
                return;
            }
            const all = await (context.memory as any)?.semantic?.read?.('*');
            if (Array.isArray(all)) {
                for (const item of all) {
                    const mapped = { id: item?.key ?? item?.id, value: item?.value, tags: item?.tags, entities: item?.entities } as any;
                    if ((idOrPredicate as any)(mapped)) await (context.memory as any)?.semantic?.delete?.(mapped.id);
                }
            }
        }
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