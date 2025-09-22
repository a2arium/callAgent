import type { SessionRecord, SessionStore } from '../../types.js';

export class PrismaSessionStore implements SessionStore {
    // Accept any Prisma client that exposes chatSession/chatIdempotency models
    constructor(private readonly prisma: any) { }

    async get(key: string): Promise<SessionRecord | null> {
        // Use raw SQL to avoid relying on generated model names on the default PrismaClient
        const rows = await (this.prisma as any).$queryRaw`SELECT key, "agentId", "taskId", state, token, "lastEventSeq", "updatedAt" FROM "ChatSession" WHERE key = ${key} LIMIT 1`;
        const row = Array.isArray(rows) ? rows[0] : undefined;
        if (!row) return null;
        return {
            key: row.key as string,
            agentId: row.agentId as string,
            taskId: row.taskId as string,
            state: row.state as SessionRecord['state'],
            token: row.token ?? undefined,
            lastEventSeq: (row.lastEventSeq as number | null) ?? undefined,
            lastActivityAt: new Date(row.updatedAt as string | Date).getTime()
        };
    }

    async upsert(rec: SessionRecord): Promise<void> {
        await (this.prisma as any).$executeRaw`INSERT INTO "ChatSession" (key, "agentId", "taskId", state, token, "lastEventSeq", "updatedAt")
            VALUES (${rec.key}, ${rec.agentId}, ${rec.taskId}, ${rec.state}, ${rec.token ?? null}, ${rec.lastEventSeq ?? null}, NOW())
            ON CONFLICT (key) DO UPDATE SET
                "agentId" = EXCLUDED."agentId",
                "taskId" = EXCLUDED."taskId",
                state = EXCLUDED.state,
                token = EXCLUDED.token,
                "lastEventSeq" = EXCLUDED."lastEventSeq",
                "updatedAt" = NOW()`;
    }

    async clear(key: string): Promise<void> {
        await (this.prisma as any).$executeRaw`DELETE FROM "ChatSession" WHERE key = ${key}`.catch(() => { });
    }

    // Optional idempotency helpers
    async markProcessed(key: string, messageId: string): Promise<void> {
        const id = `${key}:${messageId}`;
        await (this.prisma as any).$executeRaw`INSERT INTO "ChatIdempotency" (id, key, "messageId") VALUES (${id}, ${key}, ${messageId})
            ON CONFLICT (id) DO NOTHING`;
    }

    async wasProcessed(key: string, messageId: string): Promise<boolean> {
        const id = `${key}:${messageId}`;
        const rows = await (this.prisma as any).$queryRaw`SELECT 1 FROM "ChatIdempotency" WHERE id = ${id} LIMIT 1`;
        return Array.isArray(rows) && rows.length > 0;
    }
}


