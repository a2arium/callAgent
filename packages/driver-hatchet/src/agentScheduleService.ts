import { randomUUID } from 'node:crypto';
import {
    AgentScheduleError,
    PluginManager,
    type AgentSchedule,
    type AgentScheduleListPage,
    type AgentScheduleQuery,
    type AgentScheduleService,
    type CreateAgentScheduleInput,
    type ReplaceAgentCronInput,
    type OperatorRequestContext,
} from '@a2arium/callagent-core';
import {
    writeOperatorAudit,
    type OperatorAuditAction,
    type OperatorAuditPrisma,
} from '@a2arium/callagent-core/unstable';
import type { JsonValue } from '@hatchet-dev/typescript-sdk/v1/types.js';
import { CronExpressionParser } from 'cron-parser';
import {
    CronWorkflowsOrderByField,
    ScheduledWorkflowsOrderByField,
    WorkflowRunOrderByDirection,
} from '@hatchet-dev/typescript-sdk/clients/rest/generated/data-contracts.js';
import { createHatchetClient, type HatchetClient } from './hatchetClient.js';
import {
    createScheduleDispatchTask,
    scheduleMetadata,
    validateScheduleDispatchInput,
    type ScheduleDispatchInput,
} from './tasks/scheduleDispatch.js';

type ProviderRow = {
    metadata: { id: string; createdAt: string; updatedAt: string };
    input?: Record<string, unknown>;
    additionalMetadata?: Record<string, unknown>;
    triggerAt?: string;
    cron?: string;
    enabled?: boolean;
    workflowRunStatus?: string;
};

type ManagedRow = { provider: ProviderRow; input: ScheduleDispatchInput };
type Cursor = {
    v: 2;
    cronOffset: number;
    onceOffset: number;
    suppressedProviderIds: string[];
};

export type CreateHatchetAgentScheduleServiceParams = {
    hatchet?: HatchetClient;
    prisma: OperatorAuditPrisma | object;
    isAgentAvailable?: (agentId: string) => boolean;
};

export function createHatchetAgentScheduleService(
    params: CreateHatchetAgentScheduleServiceParams
): AgentScheduleService {
    return new HatchetAgentScheduleService(params);
}

export class HatchetAgentScheduleService implements AgentScheduleService {
    private readonly hatchet: HatchetClient;
    private readonly dispatchTask: ReturnType<typeof createScheduleDispatchTask>;
    private readonly isAgentAvailable: (agentId: string) => boolean;
    private readonly scheduleMutationTails = new Map<string, Promise<void>>();

    constructor(private readonly params: CreateHatchetAgentScheduleServiceParams) {
        this.hatchet = params.hatchet ?? createHatchetClient();
        this.dispatchTask = createScheduleDispatchTask(this.hatchet);
        this.isAgentAvailable = params.isAgentAvailable ?? ((agentId) => PluginManager.findAgent(agentId) !== undefined);
    }

    async list(context: OperatorRequestContext, query: AgentScheduleQuery = {}): Promise<AgentScheduleListPage> {
        requireRole(context, 'viewer');
        const limit = Math.max(1, Math.min(query.limit ?? 50, 100));
        const cursor = decodeCursor(query.cursor);
        try {
            const filters = metadataFilters(context.tenantId, query.agentId);
            const [cronPage, oncePage] = await Promise.all([
                query.kind === 'once'
                    ? Promise.resolve({ rows: [] as ProviderRow[] })
                    : this.hatchet.crons.list({
                        offset: cursor.cronOffset,
                        limit: limit + 1,
                        workflow: this.dispatchTask,
                        additionalMetadata: filters,
                        orderByField: CronWorkflowsOrderByField.CreatedAt,
                        orderByDirection: WorkflowRunOrderByDirection.DESC,
                    }) as Promise<{ rows?: ProviderRow[] }>,
                query.kind === 'cron'
                    ? Promise.resolve({ rows: [] as ProviderRow[] })
                    : this.hatchet.scheduled.list({
                        offset: cursor.onceOffset,
                        limit: limit + 1,
                        workflow: this.dispatchTask,
                        additionalMetadata: filters,
                        orderByField: ScheduledWorkflowsOrderByField.CreatedAt,
                        orderByDirection: WorkflowRunOrderByDirection.DESC,
                    }) as Promise<{ rows?: ProviderRow[] }>,
            ]);
            const crons = (cronPage.rows ?? []).map((provider) => this.parseManaged(provider, context.tenantId, 'cron'));
            const once = (oncePage.rows ?? []).map((provider) => this.parseManaged(provider, context.tenantId, 'once'));
            const merged = [...crons, ...once].sort(compareRows);
            const selected: AgentSchedule[] = [];
            const suppressedProviderIds = new Set(cursor.suppressedProviderIds);
            const emittedScheduleIds = new Set<string>();
            const pageScheduleCounts = new Map<string, number>();
            for (const row of merged) {
                pageScheduleCounts.set(row.input.scheduleId, (pageScheduleCounts.get(row.input.scheduleId) ?? 0) + 1);
            }
            let consumedCron = 0;
            let consumedOnce = 0;
            for (const row of merged) {
                if (selected.length >= limit) break;
                if (row.input.kind === 'cron') consumedCron += 1;
                else consumedOnce += 1;
                if (suppressedProviderIds.has(row.provider.metadata.id) || emittedScheduleIds.has(row.input.scheduleId)) {
                    continue;
                }

                let schedule: AgentSchedule;
                if (row.input.kind === 'cron' && (
                    row.input.revision > 1 || (pageScheduleCounts.get(row.input.scheduleId) ?? 0) > 1
                )) {
                    const logicalRows = await this.findRows(context.tenantId, row.input.scheduleId);
                    const current = this.currentRow(logicalRows);
                    for (const logicalRow of logicalRows) {
                        if (logicalRow.provider.metadata.id !== current.provider.metadata.id) {
                            suppressedProviderIds.add(logicalRow.provider.metadata.id);
                        }
                    }
                    if (current.provider.metadata.id !== row.provider.metadata.id) continue;
                    schedule = this.resolveLogical(logicalRows);
                } else {
                    schedule = this.toSchedule(row);
                }
                emittedScheduleIds.add(schedule.id);
                if (!query.state || schedule.state === query.state) selected.push(schedule);
            }
            const hasMore = crons.length > consumedCron || once.length > consumedOnce ||
                crons.length === limit + 1 || once.length === limit + 1;
            return {
                items: selected,
                ...(hasMore
                    ? { nextCursor: encodeCursor({
                        v: 2,
                        cronOffset: cursor.cronOffset + consumedCron,
                        onceOffset: cursor.onceOffset + consumedOnce,
                        suppressedProviderIds: [...suppressedProviderIds].sort(),
                    }) }
                    : {}),
            };
        } catch (error) {
            throw providerError(error);
        }
    }

    async get(context: OperatorRequestContext, scheduleId: string): Promise<AgentSchedule> {
        requireRole(context, 'viewer');
        const rows = await this.findRows(context.tenantId, scheduleId);
        return this.resolveLogical(rows);
    }

    async getPayload(context: OperatorRequestContext, scheduleId: string) {
        requireRole(context, 'operator');
        const operationId = randomUUID();
        await this.audit(context, 'schedule.payload.view', scheduleId, operationId, 'requested', true);
        try {
            const rows = await this.findRows(context.tenantId, scheduleId);
            const current = this.currentRow(rows);
            await this.audit(context, 'schedule.payload.view', scheduleId, operationId, 'succeeded', true, current.input.agentId).catch(() => undefined);
            return { scheduleId, input: current.input.input };
        } catch (error) {
            await this.audit(context, 'schedule.payload.view', scheduleId, operationId, 'failed', false, undefined, error).catch(() => undefined);
            throw error;
        }
    }

    async create(context: OperatorRequestContext, value: CreateAgentScheduleInput): Promise<AgentSchedule> {
        requireRole(context, 'admin');
        const normalized = normalizeCreate(value);
        this.assertAgent(normalized.agentId);
        const scheduleId = randomUUID();
        const operationId = randomUUID();
        await this.audit(context, 'schedule.create', scheduleId, operationId, 'requested', true, normalized.agentId);
        try {
            const input = buildInput(context.tenantId, scheduleId, 1, normalized);
            const metadata = scheduleMetadata(input);
            const provider = normalized.kind === 'cron'
                ? await this.dispatchTask.cron(cronName(scheduleId, 1), normalized.cronExpression!, input, { additionalMetadata: metadata })
                : await this.dispatchTask.schedule(new Date(normalized.triggerAt!), input, { additionalMetadata: metadata });
            const row = this.parseManaged(provider as ProviderRow, context.tenantId, normalized.kind);
            await this.audit(context, 'schedule.create', scheduleId, operationId, 'succeeded', true, normalized.agentId).catch(() => undefined);
            return this.toSchedule(row);
        } catch (error) {
            await this.audit(context, 'schedule.create', scheduleId, operationId, 'failed', false, normalized.agentId, error).catch(() => undefined);
            throw providerError(error);
        }
    }

    async runNow(context: OperatorRequestContext, scheduleId: string): Promise<{ providerRunId: string }> {
        requireRole(context, 'operator');
        const rows = await this.findRows(context.tenantId, scheduleId);
        const current = this.currentRow(rows);
        this.assertAgent(current.input.agentId);
        const operationId = randomUUID();
        await this.audit(context, 'schedule.run_now', scheduleId, operationId, 'requested', true, current.input.agentId);
        try {
            const ref = await this.dispatchTask.runNoWait(current.input, {
                additionalMetadata: scheduleMetadata(current.input),
            });
            const providerRunId = await ref.getWorkflowRunId();
            await this.audit(context, 'schedule.run_now', scheduleId, operationId, 'succeeded', true, current.input.agentId).catch(() => undefined);
            return { providerRunId };
        } catch (error) {
            await this.audit(context, 'schedule.run_now', scheduleId, operationId, 'failed', false, current.input.agentId, error).catch(() => undefined);
            throw providerError(error);
        }
    }

    async pause(context: OperatorRequestContext, scheduleId: string): Promise<AgentSchedule> {
        return this.setCronEnabled(context, scheduleId, false);
    }

    async resume(context: OperatorRequestContext, scheduleId: string): Promise<AgentSchedule> {
        return this.setCronEnabled(context, scheduleId, true);
    }

    async reschedule(context: OperatorRequestContext, scheduleId: string, triggerAt: string): Promise<AgentSchedule> {
        requireRole(context, 'admin');
        const when = validFutureTimestamp(triggerAt);
        const rows = await this.findRows(context.tenantId, scheduleId);
        const current = this.currentRow(rows);
        if (current.input.kind !== 'once' || normalizeOnceState(current.provider.workflowRunStatus) !== 'pending') {
            throw new AgentScheduleError('SCHEDULE_OPERATION_UNSUPPORTED', 'Only pending one-time schedules can be rescheduled', 409);
        }
        const operationId = randomUUID();
        await this.audit(context, 'schedule.reschedule', scheduleId, operationId, 'requested', true, current.input.agentId);
        try {
            const provider = await this.hatchet.scheduled.update(current.provider.metadata.id, { triggerAt: new Date(when) });
            const row = this.parseManaged(provider as ProviderRow, context.tenantId, 'once');
            await this.audit(context, 'schedule.reschedule', scheduleId, operationId, 'succeeded', true, current.input.agentId).catch(() => undefined);
            return this.toSchedule(row);
        } catch (error) {
            await this.audit(context, 'schedule.reschedule', scheduleId, operationId, 'failed', false, current.input.agentId, error).catch(() => undefined);
            throw providerError(error);
        }
    }

    async replaceCron(context: OperatorRequestContext, scheduleId: string, value: ReplaceAgentCronInput): Promise<AgentSchedule> {
        requireRole(context, 'admin');
        return this.withScheduleMutationLock(`${context.tenantId}\0${scheduleId}`, async () => {
            const normalized = normalizeReplacement(value);
            this.assertAgent(normalized.agentId);
            const rows = await this.findRows(context.tenantId, scheduleId);
            const current = this.currentRow(rows);
            if (current.input.kind !== 'cron') {
                throw new AgentScheduleError('SCHEDULE_OPERATION_UNSUPPORTED', 'Only cron schedules can be replaced', 409);
            }
            if (current.input.revision !== normalized.expectedRevision) {
                throw new AgentScheduleError('SCHEDULE_CONFLICT', 'Schedule revision changed', 409);
            }
            const revision = current.input.revision + 1;
            if (rows.some((row) => row.input.revision >= revision && row.provider.metadata.id !== current.provider.metadata.id)) {
                throw new AgentScheduleError('SCHEDULE_CONFLICT', 'A replacement revision already exists', 409);
            }
            const operationId = randomUUID();
            await this.audit(context, 'schedule.replace', scheduleId, operationId, 'requested', true, normalized.agentId);
            let replacement: ManagedRow | undefined;
            try {
                await this.setProviderCronEnabled(current.provider.metadata.id, false);
                const replacementInput = buildInput(context.tenantId, scheduleId, revision, { kind: 'cron', ...normalized });
                try {
                    const provider = await this.dispatchTask.cron(cronName(scheduleId, revision), normalized.cronExpression, replacementInput, {
                        additionalMetadata: {
                            ...scheduleMetadata(replacementInput),
                            replacementOperationId: operationId,
                        },
                    });
                    replacement = this.parseManaged(provider as ProviderRow, context.tenantId, 'cron');
                } catch (createError) {
                    const mappedCreateError = providerError(createError);
                    let observedRows: ManagedRow[] | undefined;
                    try {
                        observedRows = await this.findRows(context.tenantId, scheduleId);
                    } catch {
                        // The create outcome is uncertain. Rolling back while the provider is
                        // unreadable could activate both revisions, so fail visibly and leave
                        // the old revision disabled until state can be inspected.
                        throw new AgentScheduleError(
                            'SCHEDULE_REPLACEMENT_STATE_UNKNOWN',
                            'Replacement creation outcome could not be verified; the previous cron remains disabled',
                            503,
                            { providerId: current.provider.metadata.id, revision },
                        );
                    }
                    const observedReplacement = observedRows.find((row) => row.input.revision === revision);
                    if (observedReplacement) {
                        if (!ownedReplacement(
                            observedReplacement,
                            replacementInput,
                            normalized.cronExpression,
                            operationId,
                        )) {
                            throw new AgentScheduleError(
                                'SCHEDULE_CONFLICT',
                                'A different replacement won the schedule revision',
                                409,
                            );
                        }
                        // The provider committed the deterministic revision but the response was
                        // lost, or an identical concurrent request won. Continue converging.
                        replacement = observedReplacement;
                    } else {
                        if (mappedCreateError.code === 'SCHEDULE_CONFLICT') {
                            throw new AgentScheduleError(
                                'SCHEDULE_REPLACEMENT_STATE_UNKNOWN',
                                'The provider reported a revision conflict that could not be resolved',
                                503,
                                { providerId: current.provider.metadata.id, revision },
                            );
                        }
                        try {
                            await this.setProviderCronEnabled(current.provider.metadata.id, true);
                        } catch (rollbackError) {
                            throw new AgentScheduleError(
                                'SCHEDULE_REPLACEMENT_ROLLBACK_FAILED',
                                'Replacement creation failed and the previous cron could not be re-enabled',
                                503,
                                {
                                    providerId: current.provider.metadata.id,
                                    createErrorCode: mappedCreateError.code,
                                    rollbackErrorCode: providerError(rollbackError).code,
                                },
                            );
                        }
                        throw mappedCreateError;
                    }
                }
                try {
                    await this.hatchet.crons.delete(current.provider.metadata.id);
                } catch {
                    const convergedRows = await this.findRows(context.tenantId, scheduleId).catch(() => undefined);
                    if (convergedRows?.length === 1 &&
                        convergedRows[0]!.provider.metadata.id === replacement.provider.metadata.id) {
                        await this.audit(context, 'schedule.replace', scheduleId, operationId, 'succeeded', true, normalized.agentId).catch(() => undefined);
                        return this.toSchedule(replacement);
                    }
                    const schedule = this.toSchedule(replacement);
                    schedule.cleanupRequired = { providerIds: [current.provider.metadata.id, replacement.provider.metadata.id] };
                    schedule.state = 'degraded';
                    await this.audit(context, 'schedule.replace', scheduleId, operationId, 'cleanup_required', true, normalized.agentId).catch(() => undefined);
                    return schedule;
                }
                await this.audit(context, 'schedule.replace', scheduleId, operationId, 'succeeded', true, normalized.agentId).catch(() => undefined);
                return this.toSchedule(replacement);
            } catch (error) {
                await this.audit(context, 'schedule.replace', scheduleId, operationId, 'failed', false, normalized.agentId, error).catch(() => undefined);
                throw providerError(error);
            }
        });
    }

    async delete(context: OperatorRequestContext, scheduleId: string): Promise<{ deleted: true }> {
        requireRole(context, 'admin');
        const rows = await this.findRows(context.tenantId, scheduleId);
        const operationId = randomUUID();
        await this.audit(context, 'schedule.delete', scheduleId, operationId, 'requested', true, rows[0]?.input.agentId);
        try {
            await Promise.all(rows.map((row) => row.input.kind === 'cron'
                ? this.hatchet.crons.delete(row.provider.metadata.id)
                : this.hatchet.scheduled.delete(row.provider.metadata.id)));
            await this.audit(context, 'schedule.delete', scheduleId, operationId, 'succeeded', true, rows[0]?.input.agentId).catch(() => undefined);
            return { deleted: true };
        } catch (error) {
            await this.audit(context, 'schedule.delete', scheduleId, operationId, 'failed', false, rows[0]?.input.agentId, error).catch(() => undefined);
            throw providerError(error);
        }
    }

    private async setCronEnabled(context: OperatorRequestContext, scheduleId: string, enabled: boolean): Promise<AgentSchedule> {
        requireRole(context, 'operator');
        const rows = await this.findRows(context.tenantId, scheduleId);
        const current = this.currentRow(rows);
        if (current.input.kind !== 'cron') {
            throw new AgentScheduleError('SCHEDULE_OPERATION_UNSUPPORTED', 'Only cron schedules can be paused or resumed', 409);
        }
        const action: OperatorAuditAction = enabled ? 'schedule.resume' : 'schedule.pause';
        const operationId = randomUUID();
        await this.audit(context, action, scheduleId, operationId, 'requested', true, current.input.agentId);
        try {
            await this.setProviderCronEnabled(current.provider.metadata.id, enabled);
            const refreshed = await this.hatchet.crons.get(current.provider.metadata.id);
            const row = this.parseManaged(refreshed as ProviderRow, context.tenantId, 'cron');
            await this.audit(context, action, scheduleId, operationId, 'succeeded', true, current.input.agentId).catch(() => undefined);
            return this.toSchedule(row);
        } catch (error) {
            await this.audit(context, action, scheduleId, operationId, 'failed', false, current.input.agentId, error).catch(() => undefined);
            throw providerError(error);
        }
    }

    private setProviderCronEnabled(providerId: string, enabled: boolean): Promise<unknown> {
        return this.hatchet.api.workflowCronUpdate(this.hatchet.tenantId, providerId, { enabled });
    }

    private async findRows(tenantId: string, scheduleId: string): Promise<ManagedRow[]> {
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(scheduleId)) {
            throw new AgentScheduleError('SCHEDULE_INVALID', 'Schedule ID is invalid', 400);
        }
        try {
            const filters = metadataFilters(tenantId, undefined, scheduleId);
            const [crons, once] = await Promise.all([
                this.hatchet.crons.list({ workflow: this.dispatchTask, additionalMetadata: filters, limit: 100 }),
                this.hatchet.scheduled.list({ workflow: this.dispatchTask, additionalMetadata: filters, limit: 100 }),
            ]);
            const rows = [
                ...(crons.rows ?? []).map((row) => this.parseManaged(row as ProviderRow, tenantId, 'cron')),
                ...(once.rows ?? []).map((row) => this.parseManaged(row as ProviderRow, tenantId, 'once')),
            ];
            if (rows.length === 0) throw new AgentScheduleError('SCHEDULE_NOT_FOUND', 'Schedule was not found', 404);
            return rows;
        } catch (error) {
            throw providerError(error);
        }
    }

    private currentRow(rows: ManagedRow[]): ManagedRow {
        const sorted = [...rows].sort((a, b) => b.input.revision - a.input.revision || compareRows(a, b));
        if (sorted.length > 1 && sorted[0]!.input.revision === sorted[1]!.input.revision) {
            throw new AgentScheduleError('SCHEDULE_CONFLICT', 'Multiple provider resources have the current revision', 409);
        }
        return sorted[0]!;
    }

    private resolveLogical(rows: ManagedRow[]): AgentSchedule {
        const current = this.currentRow(rows);
        const schedule = this.toSchedule(current);
        if (rows.length > 1) {
            schedule.cleanupRequired = { providerIds: rows.map((row) => row.provider.metadata.id) };
            schedule.state = 'degraded';
        }
        return schedule;
    }

    private parseManaged(provider: ProviderRow, tenantId: string, kind: 'once' | 'cron'): ManagedRow {
        let input: ScheduleDispatchInput;
        try {
            input = validateScheduleDispatchInput(provider.input);
        } catch {
            throw new AgentScheduleError('SCHEDULE_CORRUPT', `Managed provider resource ${provider.metadata.id} has invalid input`, 409);
        }
        if (input.kind !== kind || input.tenantId !== tenantId) {
            throw new AgentScheduleError('SCHEDULE_CORRUPT', `Managed provider resource ${provider.metadata.id} has inconsistent identity`, 409);
        }
        const expected = scheduleMetadata(input);
        for (const [key, value] of Object.entries(expected)) {
            if (provider.additionalMetadata?.[key] !== value) {
                throw new AgentScheduleError('SCHEDULE_CORRUPT', `Managed provider resource ${provider.metadata.id} metadata mismatch`, 409);
            }
        }
        return { provider, input };
    }

    private toSchedule(row: ManagedRow): AgentSchedule {
        const state = row.input.kind === 'cron'
            ? row.provider.enabled === false ? 'paused' : 'enabled'
            : normalizeOnceState(row.provider.workflowRunStatus);
        return {
            id: row.input.scheduleId,
            providerId: row.provider.metadata.id,
            revision: row.input.revision,
            kind: row.input.kind,
            displayName: row.input.displayName,
            agentId: row.input.agentId,
            agentAvailable: this.isAgentAvailable(row.input.agentId),
            state,
            createdAt: row.provider.metadata.createdAt,
            updatedAt: row.provider.metadata.updatedAt,
            ...(row.provider.triggerAt ? { triggerAt: row.provider.triggerAt } : {}),
            ...(row.provider.cron ? { cronExpression: row.provider.cron } : {}),
            payloadKeys: jsonKeys(row.input.input),
            ...(row.input.options?.maxTurns !== undefined ? { maxTurns: row.input.options.maxTurns } : {}),
        };
    }

    private assertAgent(agentId: string): void {
        if (!this.isAgentAvailable(agentId)) {
            throw new AgentScheduleError('SCHEDULE_AGENT_UNAVAILABLE', `Agent ${agentId} is not registered`, 409);
        }
    }

    private audit(
        context: OperatorRequestContext,
        action: OperatorAuditAction,
        scheduleId: string,
        operationId: string,
        resultStatus: string,
        accepted: boolean,
        agentId?: string,
        error?: unknown
    ): Promise<void> {
        return writeOperatorAudit({
            prisma: this.params.prisma as OperatorAuditPrisma,
            context,
            required: resultStatus === 'requested',
            record: {
                action,
                accepted,
                resultStatus,
                ...(agentId ? { agentId } : {}),
                ...(error ? { errorCode: error instanceof Error ? error.name : 'Error' } : {}),
                metadata: { scheduleId, operationId },
            },
        });
    }

    private async withScheduleMutationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.scheduleMutationTails.get(key) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => { release = resolve; });
        const tail = previous.then(() => current);
        this.scheduleMutationTails.set(key, tail);
        await previous;
        try {
            return await operation();
        } finally {
            release();
            if (this.scheduleMutationTails.get(key) === tail) this.scheduleMutationTails.delete(key);
        }
    }
}

function normalizeCreate(input: CreateAgentScheduleInput): CreateAgentScheduleInput {
    if (input.kind !== 'once' && input.kind !== 'cron') invalid('kind must be once or cron');
    if (typeof input.displayName !== 'string' || input.displayName.trim().length === 0 || input.displayName.trim().length > 120) invalid('displayName is invalid');
    if (typeof input.agentId !== 'string' || input.agentId.trim().length === 0) invalid('agentId is invalid');
    const value = toJson(input.input);
    const maxTurns = normalizeMaxTurns(input.maxTurns);
    if (input.kind === 'once') {
        const triggerAt = validFutureTimestamp(input.triggerAt);
        return { kind: 'once', displayName: input.displayName.trim(), agentId: input.agentId.trim(), input: value, triggerAt, ...(maxTurns ? { maxTurns } : {}) };
    }
    const cronExpression = validCron(input.cronExpression);
    return { kind: 'cron', displayName: input.displayName.trim(), agentId: input.agentId.trim(), input: value, cronExpression, ...(maxTurns ? { maxTurns } : {}) };
}

function normalizeReplacement(input: ReplaceAgentCronInput): ReplaceAgentCronInput {
    const normalized = normalizeCreate({ kind: 'cron', ...input });
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) invalid('expectedRevision is invalid');
    return {
        expectedRevision: input.expectedRevision,
        displayName: normalized.displayName,
        agentId: normalized.agentId,
        input: normalized.input,
        cronExpression: normalized.cronExpression!,
        ...(normalized.maxTurns !== undefined ? { maxTurns: normalized.maxTurns } : {}),
    };
}

function buildInput(
    tenantId: string,
    scheduleId: string,
    revision: number,
    value: CreateAgentScheduleInput
): ScheduleDispatchInput {
    return {
        schemaVersion: 1,
        scheduleId,
        revision,
        kind: value.kind,
        tenantId,
        agentId: value.agentId,
        displayName: value.displayName,
        input: value.input as JsonValue,
        ...(value.maxTurns !== undefined ? { options: { maxTurns: value.maxTurns } } : {}),
        ...(value.kind === 'once' && value.triggerAt !== undefined ? { scheduledFor: value.triggerAt } : {}),
    };
}

function metadataFilters(tenantId: string, agentId?: string, scheduleId?: string): string[] {
    return [
        'managedBy:callagent',
        `tenantId:${tenantId}`,
        ...(agentId ? [`agentId:${agentId}`] : []),
        ...(scheduleId ? [`callagentScheduleId:${scheduleId}`] : []),
    ];
}

function requireRole(context: OperatorRequestContext, minimum: 'viewer' | 'operator' | 'admin'): void {
    const weight = { viewer: 1, operator: 2, admin: 3 } as const;
    const role = context.role ?? (context.production ? 'viewer' : 'admin');
    if (weight[role] < weight[minimum]) {
        throw new AgentScheduleError('SCHEDULE_INVALID', `${minimum} access is required`, 403);
    }
}

function validFutureTimestamp(value: unknown): string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) invalid('triggerAt must be an ISO timestamp');
    const normalized = new Date(value).toISOString();
    if (Date.parse(normalized) <= Date.now()) invalid('triggerAt must be in the future');
    return normalized;
}

function validCron(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 200) invalid('cronExpression is invalid');
    const normalized = value.trim();
    if (normalized.split(/\s+/).length !== 5) invalid('cronExpression must contain five UTC cron fields');
    try {
        CronExpressionParser.parse(normalized, { tz: 'UTC' });
    } catch {
        invalid('cronExpression is invalid');
    }
    return normalized;
}

function normalizeMaxTurns(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    if (!Number.isSafeInteger(value) || (value as number) <= 0) invalid('maxTurns must be a positive integer');
    return value as number;
}

function toJson(value: unknown): unknown {
    if (value === undefined) invalid('input must be durable JSON');
    let encoded: string;
    try { encoded = JSON.stringify(value); } catch { invalid('input must be durable JSON'); }
    if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 900_000) invalid('input must be durable JSON under 900KB');
    const parsed = JSON.parse(encoded);
    assertFiniteNumbers(value);
    return parsed;
}

function assertFiniteNumbers(value: unknown, seen = new WeakSet<object>()): void {
    if (typeof value === 'number' && !Number.isFinite(value)) invalid('input numbers must be finite');
    if (value === null || typeof value !== 'object') return;
    if (seen.has(value)) invalid('input cannot contain cycles');
    seen.add(value);
    for (const nested of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) assertFiniteNumbers(nested, seen);
    seen.delete(value);
}

function invalid(message: string): never {
    throw new AgentScheduleError('SCHEDULE_INVALID', message, 400);
}

function normalizeOnceState(value: unknown): AgentSchedule['state'] {
    switch (String(value ?? 'PENDING').toUpperCase()) {
        case 'RUNNING': return 'running';
        case 'SUCCEEDED': return 'succeeded';
        case 'FAILED': return 'failed';
        case 'CANCELLED':
        case 'CANCELED': return 'canceled';
        default: return 'pending';
    }
}

function cronName(scheduleId: string, revision: number): string {
    return `callagent-${scheduleId}-r${revision}`;
}

function jsonKeys(value: unknown): string[] {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.keys(value as Record<string, unknown>).sort()
        : [];
}

function ownedReplacement(
    row: ManagedRow,
    expected: ScheduleDispatchInput,
    cronExpression: string,
    operationId: string,
): boolean {
    return row.provider.additionalMetadata?.replacementOperationId === operationId &&
        row.provider.cron === cronExpression && canonicalJson(row.input) === canonicalJson(expected);
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
            .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'undefined';
}

function compareRows(left: ManagedRow, right: ManagedRow): number {
    return right.provider.metadata.createdAt.localeCompare(left.provider.metadata.createdAt) ||
        right.provider.metadata.id.localeCompare(left.provider.metadata.id);
}

function encodeCursor(cursor: Cursor): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string | undefined): Cursor {
    if (!value) return { v: 2, cronOffset: 0, onceOffset: 0, suppressedProviderIds: [] };
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
        if (!Number.isSafeInteger(parsed.cronOffset) || (parsed.cronOffset as number) < 0 ||
            !Number.isSafeInteger(parsed.onceOffset) || (parsed.onceOffset as number) < 0) throw new Error();
        if (parsed.v === 1) {
            return {
                v: 2,
                cronOffset: parsed.cronOffset as number,
                onceOffset: parsed.onceOffset as number,
                suppressedProviderIds: [],
            };
        }
        if (parsed.v !== 2 || !Array.isArray(parsed.suppressedProviderIds) ||
            parsed.suppressedProviderIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 255) ||
            parsed.suppressedProviderIds.length > 10_000) throw new Error();
        return parsed as Cursor;
    } catch {
        throw new AgentScheduleError('SCHEDULE_INVALID', 'Schedule cursor is invalid', 400);
    }
}

function providerError(error: unknown): AgentScheduleError {
    if (error instanceof AgentScheduleError) return error;
    const candidate = error as { response?: { status?: number }; status?: number; message?: string };
    const status = candidate.response?.status ?? candidate.status;
    if (status === 400 || status === 422) {
        return new AgentScheduleError('SCHEDULE_INVALID', candidate.message ?? 'Schedule provider rejected the request', 400);
    }
    if (status === 404) return new AgentScheduleError('SCHEDULE_NOT_FOUND', 'Schedule was not found', 404);
    if (status === 409) return new AgentScheduleError('SCHEDULE_CONFLICT', candidate.message ?? 'Schedule provider conflict', 409);
    return new AgentScheduleError('SCHEDULE_PROVIDER_UNAVAILABLE', candidate.message ?? 'Hatchet schedule provider is unavailable', 503);
}
