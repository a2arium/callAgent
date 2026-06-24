import { PrismaClient } from '../packages/memory-sql/src/generated/prisma/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { getSafePgConfig } from '../packages/memory-sql/src/safePool.js';
import { OperatorRetentionService, readRetentionPolicyFromEnv } from '../packages/core/src/operator/retention.js';

type CliArgs = {
    tenantId: string;
    apply: boolean;
    reason?: string;
};

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const databaseUrl = process.env.MEMORY_DATABASE_URL;
    if (!databaseUrl) {
        throw new Error('MEMORY_DATABASE_URL is required');
    }
    const prisma = new (PrismaClient as any)({
        adapter: new PrismaPg(getSafePgConfig(databaseUrl)),
    });
    try {
        const service = new OperatorRetentionService(prisma, readRetentionPolicyFromEnv());
        const plan = args.apply
            ? await service.apply({
                tenantId: args.tenantId,
                actorId: 'operator-retention-cli',
                actorType: 'service',
                reason: args.reason,
            })
            : await service.plan({ tenantId: args.tenantId });
        console.log(JSON.stringify(plan, null, 2));
    } finally {
        await prisma.$disconnect();
    }
}

function parseArgs(argv: string[]): CliArgs {
    let tenantId = 'default';
    let apply = false;
    let reason: string | undefined;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--tenant' || arg === '--tenant-id') {
            tenantId = requiredValue(argv, index);
            index += 1;
            continue;
        }
        if (arg === '--apply') {
            apply = true;
            continue;
        }
        if (arg === '--dry-run') {
            apply = false;
            continue;
        }
        if (arg === '--reason') {
            reason = requiredValue(argv, index);
            index += 1;
            continue;
        }
        if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
    return { tenantId, apply, ...(reason ? { reason } : {}) };
}

function requiredValue(argv: string[], index: number): string {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
        throw new Error(`${argv[index]} requires a value`);
    }
    return value;
}

function printHelp(): void {
    console.log(`Usage: yarn operator:retention -- --tenant default [--dry-run|--apply]

Defaults to dry-run. Apply mode requires CALLAGENT_RETENTION_APPLY=true.
`);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
