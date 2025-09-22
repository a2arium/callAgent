// Second Prisma client dedicated to chat-bridge models
// Generated from packages/chat-bridge/prisma/schema.prisma
// Ensure you run: npx prisma generate --schema packages/chat-bridge/prisma/schema.prisma

import { PrismaClient } from '@prisma/client';

let singleton: PrismaClient | null = null;

export function getChatPrismaClient(): PrismaClient {
    if (!singleton) {
        const url = process.env.CHAT_DATABASE_URL;
        // Force datasource URL to chat-bridge DB even if @prisma/client was last generated for another schema
        const opts = url ? { datasources: { db: { url } } } as any : undefined;
        singleton = new PrismaClient(opts);
    }
    return singleton;
}


