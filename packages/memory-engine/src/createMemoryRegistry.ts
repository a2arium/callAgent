import {
    IMemory,
    MemoryRegistry,
    SemanticMemoryBackend,
    EpisodicMemoryBackend,
    EmbedMemoryBackend,
    WorkingMemoryBackend,
    GetManyInput,
    GetManyOptions,
    RecognitionOptions,
    RecognitionResult,
    EnrichmentOptions,
    EnrichmentResult,
    SemanticAddInput,
    SemanticItem,
    SemanticReadFilter,
    SemanticRemoveFilter,
    SemanticPredicateFilter
} from '@a2arium/callagent-types';
import { logger } from '@a2arium/callagent-utils';
// import { createEmbeddingFunction, isEmbeddingAvailable } from '../llm/LLMFactory.js'; // REMOVED: Injected via config
import { SemanticMemoryRegistry } from './types/semantic/SemanticMemoryRegistry.js';
import { EpisodicMemoryRegistry } from './types/episodic/EpisodicMemoryRegistry.js';
import { EmbedMemoryRegistry } from './types/embed/EmbedMemoryRegistry.js';
import { WorkingMemoryRegistry } from './types/working/WorkingMemoryRegistry.js';

const memoryLogger = logger.createLogger({ prefix: 'MemoryRegistry' });

/**
 * Extended IMemory interface that includes working memory
 */
export type ExtendedIMemory = IMemory & {
    working: MemoryRegistry<WorkingMemoryBackend>;
};

/**
 * Create a comprehensive memory registry with all memory types
 * Routes all operations through MLO while maintaining backward compatibility
 */
/**
 * Configuration options for memory registry
 */
export interface MemoryRegistryConfig {
    /** Database configuration */
    database?: {
        /** Database connection URL */
        url?: string;
        /** Pre-configured Prisma client */
        prismaClient?: any;
    };
    /** Custom memory adapters */
    adapters?: {
        /** Custom semantic memory adapter */
        semantic?: SemanticMemoryBackend;
        /** Custom working memory adapter */
        working?: WorkingMemoryBackend;
    };
    /** Embedding function provider */
    embeddingFunction?: (text: string) => Promise<number[]>;
}

export async function createMemoryRegistry(
    tenantId?: string,
    agentId?: string,
    taskContext?: any,
    config?: MemoryRegistryConfig
): Promise<ExtendedIMemory> {
    const adapterType = process.env.MEMORY_ADAPTER || 'sql';
    const resolvedTenantId = tenantId || 'default';
    const resolvedAgentId = agentId || 'default';

    memoryLogger.info('Creating memory registry', {
        adapterType,
        tenantId: resolvedTenantId,
        agentId: resolvedAgentId
    });

    if (adapterType === 'sql') {
        let semanticAdapter: SemanticMemoryBackend;
        let embedFunction: ((text: string) => Promise<number[]>) | undefined;

        if (config?.adapters?.semantic) {
            // Use provided semantic adapter
            semanticAdapter = config.adapters.semantic;
            memoryLogger.debug('Using provided semantic memory adapter');
        } else {
            // Create SQL adapter
            try {
                const { MemorySQLAdapter } = await import('@a2arium/callagent-memory-sql');

                // Create adapter with flexible configuration
                semanticAdapter = new MemorySQLAdapter({
                    prismaClient: config?.database?.prismaClient,
                    databaseUrl: config?.database?.url,
                    defaultTenantId: resolvedTenantId,
                    embedFunction: config?.embeddingFunction
                });

                memoryLogger.debug('Created MemorySQLAdapter with configuration');
            } catch (error) {
                throw new Error(`
Failed to initialize semantic memory adapter. Please either:
1. Install @a2arium/callagent-memory-sql and configure database
2. Provide your own semantic memory adapter via config.adapters.semantic

Error: ${error}
                `.trim());
            }
        }

        // Create semantic memory registry using the existing adapter
        const semantic: IMemory['semantic'] = {
            getDefaultBackend: () => 'sql',
            setDefaultBackend: () => { },
            backends: { sql: semanticAdapter },
            get: <T>(key: string, opts?: { backend?: string }) => semanticAdapter.get(key),
            set: <T>(key: string, value: T, opts?: { backend?: string; tags?: string[] }) =>
                semanticAdapter.set(key, value, opts),
            read: <T>(input: GetManyInput, options?: GetManyOptions) =>
                (semanticAdapter as any).read?.(input, options) ?? (semanticAdapter as any).getMany?.(input, options),
            delete: (key: string, opts?: { backend?: string }) => semanticAdapter.delete(key),
            remove: (input: GetManyInput, options?: GetManyOptions) =>
                (semanticAdapter as any).remove?.(input, options) ?? (semanticAdapter as any).deleteMany?.(input, options),

            // ── High-level Agent API ──
            add: async (item: SemanticAddInput) => {
                await semanticAdapter.set(item.id, item.value, { tags: item.tags, entities: item.entities });
            },
            readItems: async (filter?: SemanticReadFilter) => {
                if (filter?.id) {
                    const ids = Array.isArray(filter.id) ? filter.id : [filter.id];
                    const results: SemanticItem[] = [];
                    for (const id of ids) {
                        const val = await semanticAdapter.get<unknown>(id);
                        if (val !== null && val !== undefined) {
                            results.push({ id, value: val, tags: undefined, entities: undefined });
                        }
                    }
                    return typeof filter.limit === 'number' ? results.slice(0, filter.limit) : results;
                }
                const query: any = {};
                if (filter?.tag) query.tag = filter.tag;
                if (filter?.filters) query.filters = filter.filters;
                if (filter?.limit) query.limit = filter.limit;
                if (filter?.orderBy) query.orderBy = filter.orderBy;

                const rawResults = await semanticAdapter.read(Object.keys(query).length > 0 ? query : '*');
                const mapped = Array.isArray(rawResults)
                    ? rawResults.map((x: any) => ({
                        id: x?.key ?? x?.id,
                        value: x?.value,
                        tags: x?.tags,
                        entities: x?.entities,
                    }))
                    : [];

                if (filter?.tags && filter.tags.length > 0 && !filter?.tag) {
                    return mapped.filter((m: any) =>
                        filter.tags!.every((t: string) => (m.tags || []).includes(t))
                    );
                }
                return mapped;
            },
            removeItem: async (idOrFilter: string | SemanticRemoveFilter | SemanticPredicateFilter) => {
                try {
                    if (typeof idOrFilter === 'string') {
                        await semanticAdapter.delete(idOrFilter);
                        return;
                    }
                    if (typeof idOrFilter === 'object' && idOrFilter !== null && typeof idOrFilter !== 'function') {
                        const removeQuery: any = {};
                        if ((idOrFilter as any).tag) removeQuery.tag = (idOrFilter as any).tag;
                        if ((idOrFilter as any).filters) removeQuery.filters = (idOrFilter as any).filters;
                        if ((idOrFilter as any).limit) removeQuery.limit = (idOrFilter as any).limit;
                        if (Object.keys(removeQuery).length > 0) {
                            await semanticAdapter.remove(removeQuery);
                            return;
                        }
                    }
                    if (typeof idOrFilter === 'function') {
                        const all = await semanticAdapter.read('*');
                        if (Array.isArray(all)) {
                            for (const rawItem of all) {
                                const item = rawItem as Record<string, unknown>;
                                const mapped = { id: (item.key ?? item.id) as string, value: item.value, tags: item.tags, entities: item.entities };
                                if ((idOrFilter as (f: typeof mapped) => boolean)(mapped)) await semanticAdapter.delete(mapped.id);
                            }
                        }
                    }
                } catch { /* noop */ }
            },

            entities: semanticAdapter.entities,
            recognize: <T>(candidateData: T, options?: RecognitionOptions): Promise<RecognitionResult<T>> =>
                semanticAdapter.recognize(candidateData, {
                    ...options,
                    taskContext: options?.taskContext || taskContext
                }),
            enrich: <T>(key: string, additionalData: T[], options?: EnrichmentOptions): Promise<EnrichmentResult<T>> =>
                semanticAdapter.enrich(key, additionalData, {
                    ...options,
                    taskContext: options?.taskContext || taskContext
                })
        };

        // Create working memory registry (placeholder implementation for now)
        const working: MemoryRegistry<WorkingMemoryBackend> = {
            getDefaultBackend: () => 'placeholder',
            setDefaultBackend: () => { },
            backends: {},
            setGoal: async (goal: string) => {
                memoryLogger.info('Working memory setGoal called', { goal, agentId: resolvedAgentId });
            },
            getGoal: async () => {
                memoryLogger.info('Working memory getGoal called', { agentId: resolvedAgentId });
                return null;
            },
            addThought: async (thought) => {
                memoryLogger.info('Working memory addThought called', { thought, agentId: resolvedAgentId });
            },
            getThoughts: async () => {
                memoryLogger.info('Working memory getThoughts called', { agentId: resolvedAgentId });
                return [];
            },
            makeDecision: async (key, decision) => {
                memoryLogger.info('Working memory makeDecision called', { key, decision, agentId: resolvedAgentId });
            },
            getDecision: async (key) => {
                memoryLogger.info('Working memory getDecision called', { key, agentId: resolvedAgentId });
                return null;
            },
            getAllDecisions: async () => {
                memoryLogger.info('Working memory getAllDecisions called', { agentId: resolvedAgentId });
                return {};
            },
            setVariable: async (key, value) => {
                memoryLogger.info('Working memory setVariable called', { key, value, agentId: resolvedAgentId });
            },
            getVariable: async (key) => {
                memoryLogger.info('Working memory getVariable called', { key, agentId: resolvedAgentId });
                return undefined;
            },
            clearSession: async () => {
                memoryLogger.info('Working memory clearSession called', { agentId: resolvedAgentId });
            },
            getSessionState: async () => {
                memoryLogger.info('Working memory getSessionState called', { agentId: resolvedAgentId });
                return {
                    currentGoal: null,
                    thoughtChain: [],
                    decisions: {},
                    variables: {},
                    loadedLongTermMemories: [],
                    meta: {
                        lastUpdatedAt: new Date().toISOString(),
                        version: '1.0.0',
                        agentId: resolvedAgentId
                    }
                };
            },
        };

        // Create episodic memory registry (placeholder for now)
        const episodic: MemoryRegistry<EpisodicMemoryBackend> = {
            getDefaultBackend: () => 'none',
            setDefaultBackend: () => { },
            backends: {},
            append: async () => { throw new Error('Episodic memory not implemented yet'); },
            getEvents: async () => [],
            deleteEvent: async () => { throw new Error('Episodic memory not implemented yet'); },
        };

        // Create embed memory registry (placeholder for now)
        const embed: MemoryRegistry<EmbedMemoryBackend> = {
            getDefaultBackend: () => 'none',
            setDefaultBackend: () => { },
            backends: {},
            upsert: async () => { throw new Error('Embed memory not implemented yet'); },
            queryByVector: async () => [],
            delete: async () => { throw new Error('Embed memory not implemented yet'); },
        };

        memoryLogger.info('Memory registry created successfully', {
            tenantId: resolvedTenantId,
            agentId: resolvedAgentId,
            embeddingEnabled: !!embedFunction
        });

        return {
            semantic,
            episodic,
            embed,
            working
        };
    }

    throw new Error(`Unknown MEMORY_ADAPTER: ${adapterType}`);
}
