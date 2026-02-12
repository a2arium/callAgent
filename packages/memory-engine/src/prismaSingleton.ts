import PrismaClientPkg from '@prisma/client';
import type { PrismaClient as PrismaClientType } from '@prisma/client';
const { PrismaClient } = PrismaClientPkg;

let singletonPrismaClient: PrismaClientType | null = null;

/**
 * Get the singleton PrismaClient instance, creating it if it doesn't exist
 */
export async function getMemoryPrismaClient(): Promise<PrismaClientType> {
    if (!singletonPrismaClient) {
        singletonPrismaClient = new (PrismaClient as any)();
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