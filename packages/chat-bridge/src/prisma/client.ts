import { PrismaClient } from '../generated/prisma/index.js';
import type { PrismaClient as PrismaClientType } from '../generated/prisma/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import pgConnectionString from 'pg-connection-string';

const { parse: parseConnectionString } = pgConnectionString;

let singleton: PrismaClientType | null = null;

export function getChatPrismaClient(): PrismaClientType {
    if (!singleton) {
        const url = process.env.CHAT_DATABASE_URL;
        if (url && typeof url !== 'string') {
            throw new Error(`Invalid type for CHAT_DATABASE_URL: expected string, received ${typeof url}`);
        }
        // Parse URL manually to avoid pg-pool config leakage into ConnectionParameters.options
        const parsed = url ? parseConnectionString(url) : { host: 'localhost', port: '5432' };
        const pool = new pg.Pool({
            host: (parsed as any).host || 'localhost',
            port: (parsed as any).port ? parseInt((parsed as any).port, 10) : 5432,
            user: (parsed as any).user || undefined,
            password: (parsed as any).password || undefined,
            database: (parsed as any).database || undefined,
        });
        const adapter = new PrismaPg(pool);
        singleton = new (PrismaClient as any)({ adapter });
    }
    return singleton as PrismaClientType;
}


