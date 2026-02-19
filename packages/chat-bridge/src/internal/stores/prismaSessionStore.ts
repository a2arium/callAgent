import type { SessionRecord, SessionStore } from '../../types.js';

export class PrismaSessionStore implements SessionStore {
    // Accept any Prisma client that exposes chatSession/chatIdempotency models
    constructor(private readonly prisma: any) { }

    async get(key: string): Promise<SessionRecord | null> {
        // try { console.debug(`[chat-prisma] get key=${key}`); } catch { }
        // Use raw SQL to avoid relying on generated model names on the default PrismaClient
        const rows = await (this.prisma as any).$queryRaw`SELECT key, "agentId", "taskId", state, token, "lastEventSeq", "updatedAt" FROM "ChatSession" WHERE key = ${key} LIMIT 1`;
        const row = Array.isArray(rows) ? rows[0] : undefined;
        if (!row) return null;
        // try { console.debug(`[chat-prisma] get:hit key=${key} state=${row.state} taskId=${row.taskId} token=${row.token}`); } catch { }
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
        // try { console.info(`[chat-prisma] upsert key=${rec.key} state=${rec.state} taskId=${rec.taskId} token=${rec.token}`); } catch { }
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
        // try { console.info(`[chat-prisma] clear key=${key}`); } catch { }
        await (this.prisma as any).$executeRaw`DELETE FROM "ChatSession" WHERE key = ${key}`.catch(() => { });
    }

    // Optional idempotency helpers
    async markProcessed(key: string, messageId: string): Promise<void> {
        const id = `${key}:${messageId}`;
        // try { console.debug(`[chat-prisma] markProcessed id=${id}`); } catch { }
        await (this.prisma as any).$executeRaw`INSERT INTO "ChatIdempotency" (id, key, "messageId") VALUES (${id}, ${key}, ${messageId})
            ON CONFLICT (id) DO NOTHING`;
    }

    async wasProcessed(key: string, messageId: string): Promise<boolean> {
        const id = `${key}:${messageId}`;
        const rows = await (this.prisma as any).$queryRaw`SELECT 1 FROM "ChatIdempotency" WHERE id = ${id} LIMIT 1`;
        // try { console.debug(`[chat-prisma] wasProcessed id=${id} -> ${Array.isArray(rows) && rows.length > 0}`); } catch { }
        return Array.isArray(rows) && rows.length > 0;
    }
}


