import { IMemory } from '@callagent/types';
import { createEmbeddingFunction, isEmbeddingAvailable } from '../llm/LLMFactory.js';
import { logger } from '@callagent/utils';

const memoryLogger = logger.createLogger({ prefix: 'MemoryFactory' });

export async function getMemoryAdapter(): Promise<IMemory> {
    const adapterType = process.env.MEMORY_ADAPTER || 'sql';
    memoryLogger.debug('Memory factory - adapter type:', adapterType);
    memoryLogger.debug('Environment check:', {
        EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
        EMBEDDING_MODEL: process.env.EMBEDDING_MODEL,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ? 'SET' : 'NOT SET'
    });

    if (adapterType === 'sql') {
        const { PrismaClient } = await import('@prisma/client');
        const { MemorySQLAdapter } = await import('@callagent/memory-sql');
        const prisma = new PrismaClient();

        // Create embedding function if available
        let embedFunction: ((text: string) => Promise<number[]>) | undefined;
        const embeddingAvailable = isEmbeddingAvailable();
        memoryLogger.debug('Embedding available:', embeddingAvailable);

        if (embeddingAvailable) {
            try {
                memoryLogger.debug('Creating embedding function...');
                embedFunction = await createEmbeddingFunction();
                memoryLogger.debug('Embedding function created successfully');
            } catch (error) {
                memoryLogger.warn('Failed to create embedding function:', error);
            }
        }

        const sqlAdapter = new MemorySQLAdapter(prisma, embedFunction);
        memoryLogger.debug('MemorySQLAdapter created with embedding function:', !!embedFunction);
        const semantic: import('@callagent/types').MemoryRegistry<import('@callagent/types').SemanticMemoryBackend> = {
            getDefaultBackend: () => 'sql',
            setDefaultBackend: () => { },
            backends: { sql: sqlAdapter },
            get: <T>(key: string, opts?: { backend?: string }) => sqlAdapter.get(key),
            set: <T>(key: string, value: T, opts?: { backend?: string; tags?: string[] }) => sqlAdapter.set(key, value, opts),
            getMany: <T>(input: import('@callagent/types').GetManyInput, options?: import('@callagent/types').GetManyOptions) => sqlAdapter.getMany(input, options),
            delete: (key: string, opts?: { backend?: string }) => sqlAdapter.delete(key),
            entities: sqlAdapter.entities,
        };
        return {
            semantic,
            episodic: {
                getDefaultBackend: () => 'none',
                setDefaultBackend: () => { },
                backends: {},
                append: async () => { throw new Error('Episodic memory not implemented'); },
                getEvents: async () => [],
                deleteEvent: async () => { throw new Error('Episodic memory not implemented'); },
            },
            embed: {
                getDefaultBackend: () => 'none',
                setDefaultBackend: () => { },
                backends: {},
                upsert: async () => { throw new Error('Embed memory not implemented'); },
                queryByVector: async () => [],
                delete: async () => { throw new Error('Embed memory not implemented'); },
            }
        };
    }
    throw new Error(`Unknown MEMORY_ADAPTER: ${adapterType}`);
} 