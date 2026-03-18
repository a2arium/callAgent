import { UnifiedMemoryService } from '../../../UnifiedMemoryService.js';
import { MemoryLifecycleConfig } from '../../../lifecycle/config/types.js';
import { getMemoryProfile } from '../../../lifecycle/config/MemoryProfiles.js';
import { TaskContext } from '../../../shared/types/index.js';
import type { WorkingVariables } from '../../../shared/types/workingMemory.js';
import { WorkingMemoryBackend, IMemory } from '@a2arium/callagent-types';
import { MLOSemanticBackend, MLOEpisodicBackend, MLOEmbedBackend } from '../../../MLOBackends.js';
import { SemanticMemoryRegistry } from '../../semantic/SemanticMemoryRegistry.js';
import { EpisodicMemoryRegistry } from '../../episodic/EpisodicMemoryRegistry.js';
import { EmbedMemoryRegistry } from '../../embed/EmbedMemoryRegistry.js';
import { PrismaClient } from '@a2arium/callagent-memory-sql/generated';
import type { PrismaClient as PrismaClientType } from '@a2arium/callagent-memory-sql/generated';
import { logger } from '@a2arium/callagent-utils';

const contextLogger = logger.createLogger({ prefix: 'WorkingMemoryContext' });

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
    let prisma = existingPrismaClient as PrismaClientType;
    try {
        const { WorkingMemorySQLAdapter } = await import('@a2arium/callagent-memory-sql') as any;

        // Use existing PrismaClient if provided
        if (!prisma) {
            throw new Error('No Prisma client provided and MEMORY_DATABASE_URL is missing');
        }

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
    // ✅ FIX: Auto-instantiate Semantic SQL adapter if Prisma is available but adapter is missing
    let semanticMemoryAdapter = existingSemanticAdapter as any;
    if (!semanticMemoryAdapter && prisma) {
        try {
            const { MemorySQLAdapter } = await import('@a2arium/callagent-memory-sql') as any;
            semanticMemoryAdapter = new MemorySQLAdapter({ prismaClient: prisma });
            contextLogger.debug('Semantic memory adapter auto-created from existing Prisma client', {
                tenantId,
                agentId
            });
        } catch (error) {
            contextLogger.warn('Failed to auto-create semantic memory adapter', {
                tenantId,
                agentId,
                error: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    }

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

    // Add unified operations
    context.recall = async (query: string, options?: any) => unifiedMemory.recall(query, options);
    context.remember = async (key: string, value: unknown, options?: any) =>
        unifiedMemory.remember(key, value, options);

    // Replace memory interface with MLO-backed registries
    // ✅ FIX: Preserve the SQL backend alongside MLO backend
    const mloSemanticBackend = new MLOSemanticBackend(unifiedMemory, semanticMemoryAdapter, context);
    const semanticBackends: Record<string, any> = { mlo: mloSemanticBackend };
    if (semanticMemoryAdapter) {
        semanticBackends.sql = semanticMemoryAdapter;
    } else {
        contextLogger.warn('[extendContextWithMemory] WARNING: No semantic adapter could be resolved, SQL backend will be missing!');
    }

    context.memory = {
        // Create MLO-backed registries that route all operations through UnifiedMemoryService
        // IMPORTANT: Include both SQL and MLO backends so direct .set() calls work
        semantic: new SemanticMemoryRegistry(
            semanticBackends,
            'mlo' // MLO is default, but SQL backend is available too
        ) as unknown as IMemory['semantic'],
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

    // Legacy semantic facades for backward compatibility
    const semanticRegistryAccessor = () => (context.memory as any)?.semantic;

    context.semantic = {
        add: async (item: { id: string; value?: unknown; data?: unknown; tags?: string[]; entities?: Record<string, unknown> }) => {
            const registry = semanticRegistryAccessor();
            const val = item.value !== undefined ? item.value : item.data;
            if (!registry?.set) {
                console.warn('[ctx.semantic.add] ctx.memory.semantic.set not available');
                return;
            }
            try {
                await registry.set(item.id, val, { tags: item.tags, entities: item.entities });
            } catch (err) {
                console.error('[ctx.semantic.add] Failed to save semantic memory:', {
                    id: item.id,
                    error: err instanceof Error ? err.message : String(err)
                });
            }
        },
        remove: async (idOrPredicate: string | Record<string, unknown> | ((entry: { id: string; value: unknown; tags?: string[]; entities?: Record<string, unknown> }) => boolean)) => {
            const registry = semanticRegistryAccessor();
            if (!registry) return;
            try {
                // ID string remove
                if (typeof idOrPredicate === 'string') {
                    await registry.delete?.(idOrPredicate);
                    return;
                }

                // Object-based remove with filters/tags — delegate to adapter
                if (typeof idOrPredicate === 'object' && idOrPredicate !== null && typeof idOrPredicate !== 'function') {
                    const removeQuery: any = {};
                    if ((idOrPredicate as any).tag) removeQuery.tag = (idOrPredicate as any).tag;
                    if ((idOrPredicate as any).filters) removeQuery.filters = (idOrPredicate as any).filters;
                    if ((idOrPredicate as any).limit) removeQuery.limit = (idOrPredicate as any).limit;

                    const removeFn = registry.remove;
                    // Only delegate if we have at least one filter criterion and the function exists
                    if (removeFn && Object.keys(removeQuery).length > 0) {
                        await removeFn(removeQuery);
                        return;
                    }
                }

                // Legacy: predicate-function-based deletion
                if (typeof idOrPredicate === 'function') {
                    const all = await registry.read?.('*');
                    if (Array.isArray(all)) {
                        for (const item of all) {
                            const mapped = { id: item?.key ?? item?.id, value: item?.value, tags: item?.tags, entities: item?.entities };
                            if ((idOrPredicate as any)(mapped)) {
                                await registry.delete?.(mapped.id);
                            }
                        }
                    }
                }
            } catch { /* noop */ }
        },
        read: async (filter?: { id?: string | string[]; tag?: string; tags?: string[]; filters?: any[]; limit?: number; orderBy?: any; random?: boolean } | any) => {
            const registry = semanticRegistryAccessor();
            if (!registry?.read) {
                return [];
            }
            try {
                // ID-based lookup: fetch specific records by key
                if (filter?.id) {
                    const ids = Array.isArray(filter.id) ? filter.id : [filter.id];
                    const results: any[] = [];
                    for (const id of ids) {
                        const val = await registry.get?.(id);
                        if (val !== null && val !== undefined) {
                            results.push({ id, value: val, tags: undefined, entities: undefined });
                        }
                    }
                    return typeof filter.limit === 'number' ? results.slice(0, filter.limit) : results;
                }

                // Build query object for the adapter's read() method
                const query: any = {};
                // If filter is undefined/null, query remains empty -> means "all" (*) or handled below
                if (filter?.tag) query.tag = filter.tag;
                if (filter?.filters) query.filters = filter.filters;
                if (filter?.limit) query.limit = filter.limit;
                if (filter?.orderBy) query.orderBy = filter.orderBy;
                if (filter?.random) query.random = filter.random;

                // Delegate to adapter which uses SQL-level filtering
                // If query object is empty, pass '*' to fetch all
                const queryArg = Object.keys(query).length > 0 ? query : '*';
                const rawResults = await registry.read(queryArg);

                // Map adapter shape { key, value } → facade shape { id, value }
                const mapped = Array.isArray(rawResults)
                    ? rawResults.map((x: any) => ({
                        id: x?.key ?? x?.id,
                        value: x?.value,
                        tags: x?.tags,
                        entities: x?.entities,
                    }))
                    : [];

                // Multi-tag filtering (adapter supports single tag; apply extra tags in JS if needed)
                if (filter?.tags && filter.tags.length > 0 && !filter?.tag) {
                    return mapped.filter((m: any) =>
                        filter.tags!.every((t: string) => (m.tags || []).includes(t))
                    );
                }

                return mapped;
            } catch (err) {
                console.error('[ctx.semantic.read] Error:', err instanceof Error ? err.message : String(err));
                return [];
            }
        }
    };

    // registry constructed

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
