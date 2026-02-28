import { getSafePgConfig } from '@a2arium/callagent-memory-sql';
import { PrismaClient } from '@a2arium/callagent-memory-sql/generated';
import type { PrismaClient as PrismaClientType } from '@a2arium/callagent-memory-sql/generated';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

let singletonPrismaClient: PrismaClientType | null = null;

/**
 * Get the singleton PrismaClient instance, creating it if it doesn't exist
 */
export async function getMemoryPrismaClient(): Promise<PrismaClientType> {
    if (!singletonPrismaClient) {
        const dbUrl = process.env.MEMORY_DATABASE_URL;
        if (dbUrl) {
            if (typeof dbUrl !== 'string') {
                throw new Error(`Invalid type for MEMORY_DATABASE_URL in prismaSingleton: expected string, received ${typeof dbUrl}`);
            }
            const config = getSafePgConfig(dbUrl);
            const adapter = new PrismaPg(config);
            singletonPrismaClient = new PrismaClient({ adapter }) as any;
        } else {
            // Fallback for cases where DB is not needed or initialized later
            // DO NOT create PrismaClient without options as it throws in this version
            return null as any;
        }
    }
    return singletonPrismaClient!;
}

/**
 * Set the singleton PrismaClient instance
 */
export function setMemoryPrismaClient(client: PrismaClientType): void {
    singletonPrismaClient = client;
}

/**
 * Disconnect the singleton PrismaClient if it exists
 */
export async function disconnectMemoryPrismaClient(): Promise<void> {
    if (singletonPrismaClient) {
        await singletonPrismaClient.$disconnect();
        singletonPrismaClient = null;
    }
}