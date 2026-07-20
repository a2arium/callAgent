#!/usr/bin/env node
import 'dotenv/config';
import { WorkingMemorySessionStore } from '@a2arium/callagent-memory-sql';
import { OperatorProjectionRepository } from './semanticProjection.js';

async function main(): Promise<void> {
    const store = new WorkingMemorySessionStore();
    await store.connect();
    const prisma = store.getPrismaClient();
    const projection = new OperatorProjectionRepository(prisma as never);
    const rawBatchSize = Number.parseInt(process.env.CALLAGENT_PROJECTION_RECONCILE_BATCH_SIZE ?? '', 10);
    const batchSize = Number.isInteger(rawBatchSize) && rawBatchSize > 0 ? rawBatchSize : 100;
    try {
        const summary = await projection.reconcileAllDurableTerminals({
            batchSize,
            onBatch: (progress) => {
                console.info('[TerminalProjectionReconciler] progress', progress);
            },
        });
        console.info('[TerminalProjectionReconciler] complete', summary);
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((error) => {
    console.error('[TerminalProjectionReconciler] failed', {
        message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
});
