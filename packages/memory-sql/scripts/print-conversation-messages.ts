import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/index.js';
import { getSafePgConfig } from '../src/safePool.js';

function parseCliArgs(): { tenantId: string; conversationId: string } {
    const scriptIdx = process.argv.findIndex((a) => a.includes('print-conversation-messages'));
    const fromScript =
        scriptIdx >= 0
            ? { tenant: process.argv[scriptIdx + 1], conv: process.argv[scriptIdx + 2] }
            : { tenant: process.argv[2], conv: process.argv[3] };
    const tenantId = (fromScript.tenant ?? 'default').trim() || 'default';
    const conversationId = (fromScript.conv ?? 'thread-conv-ref-1').trim() || 'thread-conv-ref-1';
    if (tenantId === 'yarn' || tenantId.startsWith('workspace@')) {
        console.error(
            [
                'Invalid first argument (looks like a duplicated yarn command).',
                'Run only:',
                '  yarn workspace @a2arium/callagent-memory-sql print-conversation [tenantId] [conversationId]',
                'Examples:',
                '  yarn workspace @a2arium/callagent-memory-sql print-conversation',
                '  yarn workspace @a2arium/callagent-memory-sql print-conversation default thread-conv-ref-1',
            ].join('\n')
        );
        process.exit(1);
    }
    return { tenantId, conversationId };
}

function resolveDatabaseUrl(): string {
    const url = (process.env.MEMORY_DATABASE_URL ?? process.env.DATABASE_URL ?? '').trim();
    if (!url) {
        console.error(
            [
                'Set MEMORY_DATABASE_URL (recommended) or DATABASE_URL to your Postgres URL, then re-run.',
                'Example:',
                '  MEMORY_DATABASE_URL="postgresql://user:pass@localhost:5432/db" yarn workspace @a2arium/callagent-memory-sql print-conversation',
            ].join('\n')
        );
        process.exit(1);
    }
    return url;
}

const { tenantId, conversationId } = parseCliArgs();

async function main(): Promise<void> {
    const prisma = new PrismaClient({
        adapter: new PrismaPg(getSafePgConfig(resolveDatabaseUrl())),
    });
    try {
        const rows = await prisma.conversationMessage.findMany({
            where: { tenantId, conversationId },
            orderBy: { sequenceNumber: 'asc' },
        });
        if (rows.length === 0) {
            console.log(
                JSON.stringify(
                    {
                        tenantId,
                        conversationId,
                        count: 0,
                        note: 'No rows — run an agent that persists conversation_messages first, then re-run this script.',
                    },
                    null,
                    2
                )
            );
            return;
        }
        console.log(
            JSON.stringify(
                {
                    tenantId,
                    conversationId,
                    count: rows.length,
                    messages: rows.map((r) => ({
                        sequenceNumber: r.sequenceNumber,
                        messageId: r.messageId,
                        senderAgentId: r.senderAgentId,
                        recipientAgentId: r.recipientAgentId,
                        speechAct: r.speechAct,
                        payload: r.payload,
                        createdAt: r.createdAt,
                    })),
                },
                null,
                2
            )
        );
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
});
