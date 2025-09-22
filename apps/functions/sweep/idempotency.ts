// Cleanup ChatIdempotency entries older than TTL
// CRON USAGE: run daily/hourly as desired
// Env:
// - CHAT_DATABASE_URL
// - IDEMPOTENCY_TTL_MS (default: 24h)

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function handler(): Promise<{ removed: number }> {
    const ttl = Number(process.env.IDEMPOTENCY_TTL_MS) || (24 * 60 * 60 * 1000);
    const cutoff = new Date(Date.now() - ttl);
    const rows = await (prisma as any).chatIdempotency.findMany({ where: { createdAt: { lt: cutoff } }, select: { id: true } });
    let removed = 0;
    for (const r of rows) {
        try { await (prisma as any).chatIdempotency.delete({ where: { id: r.id } }); removed++; } catch { }
    }
    return { removed };
}


