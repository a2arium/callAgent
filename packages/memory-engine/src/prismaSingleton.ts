import { PrismaClient } from '@prisma/client';

let singletonPrismaClient: PrismaClient | null = null;

/**
 * Get the singleton PrismaClient instance, creating it if it doesn't exist
 */
export async function getMemoryPrismaClient(): Promise<PrismaClient> {
    if (!singletonPrismaClient) {
        singletonPrismaClient = new PrismaClient();
    }
    return singletonPrismaClient;
}

/**
 * Set the singleton PrismaClient instance
 */
export function setMemoryPrismaClient(client: PrismaClient): void {
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