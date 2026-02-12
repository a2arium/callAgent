import PrismaClientPkg from '@prisma/client';
import type { PrismaClient as PrismaClientType } from '@prisma/client';
const { PrismaClient } = PrismaClientPkg;

let singleton: PrismaClientType | null = null;

export function getChatPrismaClient(): PrismaClientType {
    if (!singleton) {
        const url = process.env.CHAT_DATABASE_URL;
        // Force datasource URL to chat-bridge DB even if @prisma/client was last generated for another schema
        const opts = url ? { datasources: { db: { url } } } as any : undefined;
        singleton = new (PrismaClient as any)(opts);
    }
    return singleton as PrismaClientType;
}


