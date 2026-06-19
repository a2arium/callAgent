import type { IEventBus } from '@a2arium/callagent-core/unstable';
import {
    deleteOutboxRow,
    dispatchOutboxRow,
    handleOutboxDispatchFailure,
    HATCHET_OUTBOX_DISPATCH_RETRIES,
    type OutboxRow,
} from '@a2arium/callagent-core/unstable';
import type { Context } from '@hatchet-dev/typescript-sdk/v1/client/worker/context.js';
import type { HatchetClient } from '../hatchetClient.js';
import { DriverRunsRepository } from '../driverRunsRepository.js';

export const OUTBOX_DISPATCH_TASK_NAME = 'aplret.outbox.dispatch';

export type OutboxDispatchInput = {
    outboxRowId: string;
    eventType: string;
    tenantId?: string;
    taskId?: string;
    agentId?: string;
    traceId?: string;
    token?: string;
};

export type OutboxDispatchOutput = {
    ok: boolean;
    skipped?: boolean;
};

export type OutboxDispatchDeps = {
    eventBus: IEventBus;
    prisma: {
        outbox: {
            findUnique: (args: { where: { id: string } }) => Promise<OutboxRow | null>;
            delete: (args: { where: { id: string } }) => Promise<unknown>;
            update?: (args: {
                where: { id: string };
                data: { retryCount: number };
            }) => Promise<unknown>;
        };
        conversationDeadLetter?: {
            create: (args: {
                data: {
                    tenantId: string;
                    conversationId: string;
                    sequenceNumber: number;
                    consumerId: string;
                    record: object;
                    lastError: string;
                    attempts: number;
                    deadletteredAt: Date;
                };
            }) => Promise<unknown>;
        };
    };
    driverRuns?: DriverRunsRepository;
};

function driverRunFields(input: OutboxDispatchInput, row: OutboxRow) {
    return {
        tenantId: input.tenantId ?? row.tenantId,
        taskId: input.taskId ?? row.key,
        agentId: input.agentId ?? null,
        traceId: input.traceId ?? null,
        token: input.token ?? null,
    };
}

export async function executeOutboxDispatch(
    input: OutboxDispatchInput,
    ctx: Context<OutboxDispatchInput>,
    deps: OutboxDispatchDeps
): Promise<OutboxDispatchOutput> {
    const row = (await deps.prisma.outbox.findUnique({
        where: { id: input.outboxRowId },
    })) as OutboxRow | null;

    if (!row) {
        return { ok: true, skipped: true };
    }

    const fields = driverRunFields(input, row);

    if (deps.driverRuns) {
        await deps.driverRuns.upsertByProviderRunId({
            providerRunId: ctx.workflowRunId(),
            providerTaskRunId: ctx.taskRunExternalId(),
            tenantId: fields.tenantId,
            taskId: fields.taskId,
            agentId: fields.agentId,
            traceId: fields.traceId,
            token: fields.token,
            operation: 'effect.outbox.dispatch',
            status: 'running',
            outboxRowId: input.outboxRowId,
        });
    }

    try {
        await dispatchOutboxRow({ eventBus: deps.eventBus, row });
        await deleteOutboxRow({ prisma: deps.prisma, id: row.id });

        if (deps.driverRuns) {
            await deps.driverRuns.upsertByProviderRunId({
                providerRunId: ctx.workflowRunId(),
                providerTaskRunId: ctx.taskRunExternalId(),
                tenantId: fields.tenantId,
                taskId: fields.taskId,
                agentId: fields.agentId,
                traceId: fields.traceId,
                token: fields.token,
                operation: 'effect.outbox.dispatch',
                status: 'completed',
                outboxRowId: input.outboxRowId,
            });
        }

        return { ok: true };
    } catch (error) {
        if (deps.driverRuns) {
            await deps.driverRuns.upsertByProviderRunId({
                providerRunId: ctx.workflowRunId(),
                providerTaskRunId: ctx.taskRunExternalId(),
                tenantId: fields.tenantId,
                taskId: fields.taskId,
                agentId: fields.agentId,
                traceId: fields.traceId,
                token: fields.token,
                operation: 'effect.outbox.dispatch',
                status: 'failed',
                outboxRowId: input.outboxRowId,
            });
        }

        if (ctx.retryCount() >= HATCHET_OUTBOX_DISPATCH_RETRIES) {
            await handleOutboxDispatchFailure({
                prisma: deps.prisma as Parameters<typeof handleOutboxDispatchFailure>[0]['prisma'],
                row,
                error,
                maxRetries: (row.retryCount ?? 0) + 1,
            });
        }

        throw error;
    }
}

export function createOutboxDispatchTask(hatchet: HatchetClient, deps: OutboxDispatchDeps) {
    return hatchet.task<OutboxDispatchInput, OutboxDispatchOutput>({
        name: OUTBOX_DISPATCH_TASK_NAME,
        retries: HATCHET_OUTBOX_DISPATCH_RETRIES,
        fn: async (input: OutboxDispatchInput, ctx: Context<OutboxDispatchInput>) =>
            executeOutboxDispatch(input, ctx, deps),
    });
}
