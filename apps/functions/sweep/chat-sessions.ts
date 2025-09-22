// Sweep waitingInput sessions that exceeded input timeout
// CRON USAGE (examples):
// - AWS: schedule this Lambda every 5 minutes
// - GCP Cloud Scheduler: HTTP trigger every 5 minutes
// - Vercel/Netlify cron: configure per platform
// Env:
// - CHAT_DATABASE_URL: Prisma DB URL
// - INPUT_WAIT_MS: timeout in ms (default: 15 * 60 * 1000)

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function handler(): Promise<{ removed: number }> {
    const ttlMs = Number(process.env.INPUT_WAIT_MS) || (15 * 60 * 1000);
    const cutoff = new Date(Date.now() - ttlMs);
    // Delete sessions stuck in waitingInput beyond cutoff
    const res = await (prisma as any).chatSession.deleteMany({
        where: { state: 'waitingInput', updatedAt: { lt: cutoff } }
    });
    return { removed: res.count || 0 };
}


