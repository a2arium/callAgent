import { IMemory } from '@callagent/types';

export async function getMemoryAdapter(): Promise<IMemory> {
    const adapterType = process.env.MEMORY_ADAPTER || 'sql';
    if (adapterType === 'sql') {
        const { PrismaClient } = await import('@prisma/client');
        const { MemorySQLAdapter } = await import('@callagent/memory-sql');
        const prisma = new PrismaClient();
        return new MemorySQLAdapter(prisma);
    }
    throw new Error(`Unknown MEMORY_ADAPTER: ${adapterType}`);
} 