import { PrismaClient } from '@prisma/client';
import type { PrismaClient as PrismaClientType } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import pgConnectionString from 'pg-connection-string';

const { parse: parseConnectionString } = pgConnectionString;

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
            const parsed = parseConnectionString(dbUrl);
            const pool = new pg.Pool({
                host: parsed.host || 'localhost',
                port: parsed.port ? parseInt(parsed.port, 10) : 5432,
                user: parsed.user || undefined,
                password: parsed.password || undefined,
                database: parsed.database || undefined,
            });
            const adapter = new PrismaPg(pool);
            singletonPrismaClient = new PrismaClient({ adapter }) as any;
        } else {
            // Fallback for cases where DB is not needed or initialized later
            singletonPrismaClient = new PrismaClient() as any;
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