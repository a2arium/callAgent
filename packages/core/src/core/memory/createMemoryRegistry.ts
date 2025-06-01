import {
    IMemory,
    MemoryRegistry,
    SemanticMemoryBackend,
    EpisodicMemoryBackend,
    EmbedMemoryBackend,
    WorkingMemoryBackend,
    GetManyInput,
    GetManyOptions
} from '@callagent/types';
import { logger } from '@callagent/utils';
import { createEmbeddingFunction, isEmbeddingAvailable } from '../llm/LLMFactory.js';

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
export async function createMemoryRegistry(tenantId?: string, agentId?: string): Promise<ExtendedIMemory> {
    const adapterType = process.env.MEMORY_ADAPTER || 'sql';
    const resolvedTenantId = tenantId || 'default';
    const resolvedAgentId = agentId || 'default';

    memoryLogger.info('Creating memory registry', {
        adapterType,
        tenantId: resolvedTenantId,
        agentId: resolvedAgentId
    });

    if (adapterType === 'sql') {
        // Import SQL adapters
        const { PrismaClient } = await import('@prisma/client');
        const { MemorySQLAdapter } = await import('@callagent/memory-sql');

        const prisma = new PrismaClient();

        // Create embedding function if available
        let embedFunction: ((text: string) => Promise<number[]>) | undefined;
        const embeddingAvailable = isEmbeddingAvailable();

        if (embeddingAvailable) {
            try {
                embedFunction = await createEmbeddingFunction();
                memoryLogger.debug('Embedding function created successfully');
            } catch (error) {
                memoryLogger.warn('Failed to create embedding function:', error);
            }
        }

        // Create underlying adapters
        const semanticAdapter = new MemorySQLAdapter(prisma, embedFunction, {
            defaultTenantId: resolvedTenantId
        });

        // Create semantic memory registry using the existing adapter
        const semantic: MemoryRegistry<SemanticMemoryBackend> = {
            getDefaultBackend: () => 'sql',
            setDefaultBackend: () => { },
            backends: { sql: semanticAdapter },
            get: <T>(key: string, opts?: { backend?: string }) => semanticAdapter.get(key),
            set: <T>(key: string, value: T, opts?: { backend?: string; tags?: string[] }) =>
                semanticAdapter.set(key, value, opts),
            getMany: <T>(input: GetManyInput, options?: GetManyOptions) =>
                semanticAdapter.getMany(input, options),
            delete: (key: string, opts?: { backend?: string }) => semanticAdapter.delete(key),
            entities: semanticAdapter.entities,
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

/**
 * Legacy factory function for backward compatibility
 */
export async function getMemoryAdapter(tenantId?: string): Promise<IMemory> {
    const registry = await createMemoryRegistry(tenantId);
    return {
        semantic: registry.semantic,
        episodic: registry.episodic,
        embed: registry.embed
    };
} 