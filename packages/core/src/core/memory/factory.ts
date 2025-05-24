import { IMemory } from '@callagent/types';

export async function getMemoryAdapter(): Promise<IMemory> {
    const adapterType = process.env.MEMORY_ADAPTER || 'sql';
    if (adapterType === 'sql') {
        const { PrismaClient } = await import('@prisma/client');
        const { MemorySQLAdapter } = await import('@callagent/memory-sql');
        const prisma = new PrismaClient();
        const sqlAdapter = new MemorySQLAdapter(prisma);
        const semantic: import('@callagent/types').MemoryRegistry<import('@callagent/types').SemanticMemoryBackend> = {
            getDefaultBackend: () => 'sql',
            setDefaultBackend: () => { },
            backends: { sql: sqlAdapter },
            get: <T>(key: string, opts?: { backend?: string }) => sqlAdapter.get<T>(key),
            set: <T>(key: string, value: T, opts?: { backend?: string; tags?: string[] }) => sqlAdapter.set<T>(key, value, opts),
            query: <T>(opts: import('@callagent/types').MemoryQueryOptions & { backend?: string }) => sqlAdapter.query<T>(opts),
            delete: (key: string, opts?: { backend?: string }) => sqlAdapter.delete(key),
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