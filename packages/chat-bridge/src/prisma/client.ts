import { PrismaClient } from '@chat-prisma/index.js';
import type { PrismaClient as PrismaClientType } from '@chat-prisma/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { getSafePgConfig } from '@a2arium/callagent-memory-sql';

let singleton: PrismaClientType | null = null;

export function getChatPrismaClient(): PrismaClientType {
    if (!singleton) {
        const url = process.env.CHAT_DATABASE_URL;
        if (url && typeof url !== 'string') {
            throw new Error(`Invalid type for CHAT_DATABASE_URL: expected string, received ${typeof url}`);
        }

        const config = getSafePgConfig(url || '');
        const adapter = new PrismaPg(config);
        singleton = new (PrismaClient as any)({ adapter });
    }
    return singleton as PrismaClientType;
}


