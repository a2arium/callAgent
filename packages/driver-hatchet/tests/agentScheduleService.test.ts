import { describe, expect, it, jest } from '@jest/globals';
import type { OperatorRequestContext } from '@a2arium/callagent-core';
import { HatchetAgentScheduleService } from '../src/agentScheduleService.js';
import { scheduleMetadata, type ScheduleDispatchInput } from '../src/tasks/scheduleDispatch.js';

type Row = {
    metadata: { id: string; createdAt: string; updatedAt: string };
    input: ScheduleDispatchInput;
    additionalMetadata: Record<string, string>;
    cron?: string;
    triggerAt?: string;
    enabled?: boolean;
    workflowRunStatus?: string;
};

const admin: OperatorRequestContext = {
    tenantId: 'tenant-a', actorId: 'admin-1', actorType: 'user', production: true, role: 'admin',
};
const operator: OperatorRequestContext = { ...admin, actorId: 'operator-1', role: 'operator' };
const viewer: OperatorRequestContext = { ...admin, actorId: 'viewer-1', role: 'viewer' };

function managedRow(input: Partial<ScheduleDispatchInput> & Pick<ScheduleDispatchInput, 'scheduleId' | 'kind' | 'agentId'>, createdAt: string): Row {
    const complete: ScheduleDispatchInput = {
        schemaVersion: 1,
        revision: 1,
        tenantId: 'tenant-a',
        displayName: input.scheduleId,
        input: {},
        ...input,
    } as ScheduleDispatchInput;
    return {
        metadata: { id: `provider-${complete.scheduleId}-${complete.revision}`, createdAt, updatedAt: createdAt },
        input: complete,
        additionalMetadata: scheduleMetadata(complete),
        ...(complete.kind === 'cron' ? { cron: '0 * * * *', enabled: true } : { triggerAt: '2026-09-01T00:00:00.000Z', workflowRunStatus: 'PENDING' }),
    };
}

function fakeHatchet(initial: Row[] = []) {
    const rows = [...initial];
    const auditWrites: Array<Record<string, unknown>> = [];
    const cronNames = new Set<string>();
    let nextId = 1;
    let failCreate = false;
    let failCreateAfterCommit = false;
    let failDelete = false;
    let failEnable = false;
    const filtered = (kind: 'cron' | 'once', query: any) => rows
        .filter((row) => row.input.kind === kind)
        .filter((row) => metadataMatches(row, query.additionalMetadata ?? []))
        .sort((a, b) => b.metadata.createdAt.localeCompare(a.metadata.createdAt) || b.metadata.id.localeCompare(a.metadata.id))
        .slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 100));
    const declaration = {
        cron: jest.fn(async (name: string, expression: string, input: ScheduleDispatchInput, options: any) => {
            if (failCreate) throw new Error('create unavailable');
            if (cronNames.has(name)) throw { status: 409, message: 'cron name already exists' };
            cronNames.add(name);
            const row = managedRow(input, new Date(2030, 0, nextId++).toISOString());
            row.cron = expression; row.additionalMetadata = options.additionalMetadata; rows.push(row);
            if (failCreateAfterCommit) throw new Error('response lost after create');
            return row;
        }),
        schedule: jest.fn(async (date: Date, input: ScheduleDispatchInput, options: any) => {
            const row = managedRow(input, new Date(2030, 0, nextId++).toISOString());
            row.triggerAt = date.toISOString(); row.additionalMetadata = options.additionalMetadata; rows.push(row); return row;
        }),
        runNoWait: jest.fn(async () => ({ getWorkflowRunId: async () => 'workflow-run-1' })),
    };
    const hatchet = {
        tenantId: 'provider-tenant',
        task: jest.fn(() => declaration),
        crons: {
            list: jest.fn(async (query: any) => ({ rows: filtered('cron', query) })),
            get: jest.fn(async (id: string) => rows.find((row) => row.metadata.id === id)),
            delete: jest.fn(async (id: string) => {
                if (failDelete) throw new Error('delete unavailable');
                const index = rows.findIndex((row) => row.metadata.id === id); if (index >= 0) rows.splice(index, 1);
            }),
        },
        scheduled: {
            list: jest.fn(async (query: any) => ({ rows: filtered('once', query) })),
            update: jest.fn(async (id: string, update: { triggerAt: string }) => {
                const row = rows.find((candidate) => candidate.metadata.id === id)!; row.triggerAt = new Date(update.triggerAt).toISOString(); return row;
            }),
            delete: jest.fn(async (id: string) => { const index = rows.findIndex((row) => row.metadata.id === id); if (index >= 0) rows.splice(index, 1); }),
        },
        api: {
            workflowCronUpdate: jest.fn(async (_tenant: string, id: string, update: { enabled: boolean }) => {
                if (failEnable && update.enabled) throw new Error('enable unavailable');
                const row = rows.find((candidate) => candidate.metadata.id === id)!; row.enabled = update.enabled; return row;
            }),
        },
    };
    const prisma = { operatorAuditEvent: { create: jest.fn(async ({ data }: any) => { auditWrites.push(data); }) } };
    return {
        rows, hatchet, prisma, auditWrites, declaration,
        setFailCreate(value: boolean) { failCreate = value; },
        setFailCreateAfterCommit(value: boolean) { failCreateAfterCommit = value; },
        setFailDelete(value: boolean) { failDelete = value; },
        setFailEnable(value: boolean) { failEnable = value; },
    };
}

function metadataMatches(row: Row, filters: string[]): boolean {
    return filters.every((filter) => {
        const index = filter.indexOf(':');
        return row.additionalMetadata[filter.slice(0, index)] === filter.slice(index + 1);
    });
}

describe('HatchetAgentScheduleService', () => {
    it('merges cron and one-time pages deterministically without leaking other tenants', async () => {
        const ownedCron = managedRow({ scheduleId: 'cron-a', kind: 'cron', agentId: 'agent-a' }, '2026-07-31T12:00:00.000Z');
        const ownedOnce = managedRow({ scheduleId: 'once-a', kind: 'once', agentId: 'missing-agent' }, '2026-07-31T11:00:00.000Z');
        const other = managedRow({ scheduleId: 'other', kind: 'cron', agentId: 'agent-a', tenantId: 'tenant-b' }, '2026-07-31T13:00:00.000Z');
        const unmanaged = managedRow({ scheduleId: 'unmanaged', kind: 'cron', agentId: 'agent-a' }, '2026-07-31T14:00:00.000Z');
        unmanaged.additionalMetadata.managedBy = 'someone-else';
        const fake = fakeHatchet([ownedCron, ownedOnce, other, unmanaged]);
        const service = new HatchetAgentScheduleService({ hatchet: fake.hatchet as never, prisma: fake.prisma, isAgentAvailable: (id) => id === 'agent-a' });

        const first = await service.list(admin, { limit: 1 });
        const second = await service.list(admin, { limit: 1, cursor: first.nextCursor });
        expect(first.items.map((item) => item.id)).toEqual(['cron-a']);
        expect(second.items.map((item) => item.id)).toEqual(['once-a']);
        expect(second.items[0]).toMatchObject({ agentAvailable: false });
        expect([...first.items, ...second.items].map((item) => item.id)).not.toContain('other');
        expect([...first.items, ...second.items].map((item) => item.id)).not.toContain('unmanaged');
        expect(fake.hatchet.crons.list).toHaveBeenCalledWith(expect.objectContaining({
            orderByField: 'createdAt', orderByDirection: 'DESC',
        }));
    });

    it('fails closed when managed metadata and input disagree', async () => {
        const corrupt = managedRow({ scheduleId: 'corrupt', kind: 'cron', agentId: 'agent-a' }, '2026-07-31T12:00:00.000Z');
        corrupt.input.agentId = 'agent-b';
        const fake = fakeHatchet([corrupt]);
        const service = new HatchetAgentScheduleService({ hatchet: fake.hatchet as never, prisma: fake.prisma, isAgentAvailable: () => true });
        await expect(service.list(admin)).rejects.toMatchObject({ code: 'SCHEDULE_CORRUPT', status: 409 });
    });

    it('advances independent provider offsets when a state filter needs another page', async () => {
        const newest = managedRow({ scheduleId: 'cron-newest', kind: 'cron', agentId: 'agent-a' }, '2026-07-31T14:00:00.000Z');
        const middle = managedRow({ scheduleId: 'cron-middle', kind: 'cron', agentId: 'agent-a' }, '2026-07-31T13:00:00.000Z');
        const paused = managedRow({ scheduleId: 'cron-paused', kind: 'cron', agentId: 'agent-a' }, '2026-07-31T12:00:00.000Z');
        paused.enabled = false;
        const fake = fakeHatchet([newest, middle, paused]);
        const service = new HatchetAgentScheduleService({ hatchet: fake.hatchet as never, prisma: fake.prisma, isAgentAvailable: () => true });

        const first = await service.list(viewer, { kind: 'cron', state: 'paused', limit: 1 });
        expect(first.items).toEqual([]);
        expect(first.nextCursor).toBeDefined();
        const second = await service.list(viewer, { kind: 'cron', state: 'paused', limit: 1, cursor: first.nextCursor });
        expect(second.items.map((item) => item.id)).toEqual(['cron-paused']);
    });

    it('enforces the viewer, operator, and admin mutation boundary', async () => {
        const current = managedRow({ scheduleId: 'cron-a', kind: 'cron', agentId: 'agent-a' }, '2026-07-31T12:00:00.000Z');
        const fake = fakeHatchet([current]);
        const service = new HatchetAgentScheduleService({ hatchet: fake.hatchet as never, prisma: fake.prisma, isAgentAvailable: () => true });

        await expect(service.list(viewer)).resolves.toMatchObject({ items: [expect.objectContaining({ id: 'cron-a' })] });
        await expect(service.runNow(viewer, 'cron-a')).rejects.toMatchObject({ status: 403 });
        await expect(service.runNow(operator, 'cron-a')).resolves.toEqual({ providerRunId: 'workflow-run-1' });
        await expect(service.create(operator, {
            kind: 'cron', displayName: 'forbidden', agentId: 'agent-a', input: {}, cronExpression: '0 * * * *',
        })).rejects.toMatchObject({ status: 403 });
    });

    it('keeps missing-agent schedules manageable while rejecting execution', async () => {
        const current = managedRow({ scheduleId: 'missing', kind: 'cron', agentId: 'removed-agent' }, '2026-07-31T12:00:00.000Z');
        const fake = fakeHatchet([current]);
        const service = new HatchetAgentScheduleService({ hatchet: fake.hatchet as never, prisma: fake.prisma, isAgentAvailable: () => false });

        await expect(service.get(viewer, 'missing')).resolves.toMatchObject({ agentAvailable: false });
        await expect(service.runNow(operator, 'missing')).rejects.toMatchObject({ code: 'SCHEDULE_AGENT_UNAVAILABLE' });
        await expect(service.delete(admin, 'missing')).resolves.toEqual({ deleted: true });
    });

    it('reschedules only pending one-time runs', async () => {
        const pending = managedRow({ scheduleId: 'once-a', kind: 'once', agentId: 'agent-a' }, '2026-07-31T12:00:00.000Z');
        const fake = fakeHatchet([pending]);
        const service = new HatchetAgentScheduleService({ hatchet: fake.hatchet as never, prisma: fake.prisma, isAgentAvailable: () => true });

        await expect(service.reschedule(admin, 'once-a', '2099-01-01T00:00:00.000Z')).resolves.toMatchObject({
            id: 'once-a', triggerAt: '2099-01-01T00:00:00.000Z',
        });
        pending.workflowRunStatus = 'SUCCEEDED';
        await expect(service.reschedule(admin, 'once-a', '2099-01-02T00:00:00.000Z')).rejects.toMatchObject({
            code: 'SCHEDULE_OPERATION_UNSUPPORTED', status: 409,
        });
    });

    it('rejects duplicate current revisions instead of choosing one silently', async () => {
        const first = managedRow({ scheduleId: 'cron-a', kind: 'cron', agentId: 'agent-a' }, '2026-07-31T12:00:00.000Z');
        const duplicate = managedRow({ scheduleId: 'cron-a', kind: 'cron', agentId: 'agent-a' }, '2026-07-31T13:00:00.000Z');
        duplicate.metadata.id = 'provider-cron-a-duplicate';
        const fake = fakeHatchet([first, duplicate]);
        const service = new HatchetAgentScheduleService({ hatchet: fake.hatchet as never, prisma: fake.prisma, isAgentAvailable: () => true });

        await expect(service.get(viewer, 'cron-a')).rejects.toMatchObject({ code: 'SCHEDULE_CONFLICT', status: 409 });
    });

    it('rolls a failed cron replacement back to the old enabled revision', async () => {
        const current = managedRow({ scheduleId: 'cron-a', kind: 'cron', agentId: 'agent-a' }, '2026-07-31T12:00:00.000Z');
        const fake = fakeHatchet([current]); fake.setFailCreate(true);
        const service = new HatchetAgentScheduleService({ hatchet: fake.hatchet as never, prisma: fake.prisma, isAgentAvailable: () => true });
        await expect(service.replaceCron(admin, 'cron-a', {
            expectedRevision: 1, displayName: 'replacement', agentId: 'agent-a', input: { next: true }, cronExpression: '5 * * * *',
        })).rejects.toMatchObject({ code: 'SCHEDULE_PROVIDER_UNAVAILABLE', status: 503 });
        expect(current.enabled).toBe(true);
        expect(fake.hatchet.api.workflowCronUpdate).toHaveBeenNthCalledWith(1, 'provider-tenant', current.metadata.id, { enabled: false });
        expect(fake.hatchet.api.workflowCronUpdate).toHaveBeenNthCalledWith(2, 'provider-tenant', current.metadata.id, { enabled: true });
    });

    it('returns a visible degraded revision if old cron cleanup fails', async () => {
        const current = managedRow({ scheduleId: 'cron-a', kind: 'cron', agentId: 'agent-a' }, '2026-07-31T12:00:00.000Z');
        const fake = fakeHatchet([current]); fake.setFailDelete(true);
        const service = new HatchetAgentScheduleService({ hatchet: fake.hatchet as never, prisma: fake.prisma, isAgentAvailable: () => true });
        const result = await service.replaceCron(admin, 'cron-a', {
            expectedRevision: 1, displayName: 'replacement', agentId: 'agent-a', input: { next: true }, cronExpression: '5 * * * *',
        });
        expect(result).toMatchObject({ id: 'cron-a', revision: 2, state: 'degraded' });
        expect(result.cleanupRequired?.providerIds).toHaveLength(2);
        expect(fake.auditWrites.map((row) => row.resultStatus)).toEqual(expect.arrayContaining(['requested', 'cleanup_required']));

        const listed = await service.list(viewer, { kind: 'cron', limit: 1 });
        expect(listed.items).toEqual([
            expect.objectContaining({ id: 'cron-a', revision: 2, state: 'degraded' }),
        ]);
        expect(listed.items[0]!.cleanupRequired?.providerIds).toHaveLength(2);
        const remainder = await service.list(viewer, { kind: 'cron', limit: 1, cursor: listed.nextCursor });
        expect(remainder.items).toEqual([]);
    });

    it('fails visibly when replacement creation and rollback both fail', async () => {
        const current = managedRow({ scheduleId: 'cron-a', kind: 'cron', agentId: 'agent-a' }, '2026-07-31T12:00:00.000Z');
        const fake = fakeHatchet([current]);
        fake.setFailCreate(true);
        fake.setFailEnable(true);
        const service = new HatchetAgentScheduleService({ hatchet: fake.hatchet as never, prisma: fake.prisma, isAgentAvailable: () => true });

        await expect(service.replaceCron(admin, 'cron-a', {
            expectedRevision: 1, displayName: 'replacement', agentId: 'agent-a', input: {}, cronExpression: '5 * * * *',
        })).rejects.toMatchObject({
            code: 'SCHEDULE_REPLACEMENT_ROLLBACK_FAILED',
            status: 503,
            details: { providerId: current.metadata.id },
        });
        expect(current.enabled).toBe(false);
        expect(fake.auditWrites.map((row) => row.resultStatus)).toEqual(expect.arrayContaining(['requested', 'failed']));
    });

    it('serializes concurrent replacements and admits only one next revision', async () => {
        const current = managedRow({ scheduleId: 'cron-a', kind: 'cron', agentId: 'agent-a' }, '2026-07-31T12:00:00.000Z');
        const fake = fakeHatchet([current]);
        const service = new HatchetAgentScheduleService({ hatchet: fake.hatchet as never, prisma: fake.prisma, isAgentAvailable: () => true });
        const replacement = {
            expectedRevision: 1, displayName: 'replacement', agentId: 'agent-a', input: {}, cronExpression: '5 * * * *',
        };

        const results = await Promise.allSettled([
            service.replaceCron(admin, 'cron-a', replacement),
            service.replaceCron(admin, 'cron-a', replacement),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
        expect(results.find((result) => result.status === 'rejected')).toMatchObject({
            reason: { code: 'SCHEDULE_CONFLICT', status: 409 },
        });
        expect(fake.rows).toHaveLength(1);
        expect(fake.rows[0]!.input.revision).toBe(2);
        expect(fake.rows[0]!.enabled).toBe(true);
    });

    it('uses the deterministic revision name as a cross-instance replacement CAS', async () => {
        const current = managedRow({ scheduleId: 'cron-a', kind: 'cron', agentId: 'agent-a' }, '2026-07-31T12:00:00.000Z');
        const fake = fakeHatchet([current]);
        const firstService = new HatchetAgentScheduleService({ hatchet: fake.hatchet as never, prisma: fake.prisma, isAgentAvailable: () => true });
        const secondService = new HatchetAgentScheduleService({ hatchet: fake.hatchet as never, prisma: fake.prisma, isAgentAvailable: () => true });
        const replacement = {
            expectedRevision: 1, displayName: 'replacement', agentId: 'agent-a', input: {}, cronExpression: '5 * * * *',
        };

        const results = await Promise.allSettled([
            firstService.replaceCron(admin, 'cron-a', replacement),
            secondService.replaceCron(admin, 'cron-a', replacement),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
        expect(results.find((result) => result.status === 'rejected')).toMatchObject({
            reason: { code: 'SCHEDULE_CONFLICT', status: 409 },
        });
        expect(fake.rows).toHaveLength(1);
        expect(fake.rows[0]).toMatchObject({ input: { revision: 2 }, enabled: true });
        expect(fake.hatchet.api.workflowCronUpdate).not.toHaveBeenCalledWith(
            'provider-tenant', current.metadata.id, { enabled: true },
        );
    });

    it('converges when Hatchet commits the replacement but its response is lost', async () => {
        const current = managedRow({ scheduleId: 'cron-a', kind: 'cron', agentId: 'agent-a' }, '2026-07-31T12:00:00.000Z');
        const fake = fakeHatchet([current]);
        fake.setFailCreateAfterCommit(true);
        const service = new HatchetAgentScheduleService({ hatchet: fake.hatchet as never, prisma: fake.prisma, isAgentAvailable: () => true });

        await expect(service.replaceCron(admin, 'cron-a', {
            expectedRevision: 1, displayName: 'replacement', agentId: 'agent-a', input: {}, cronExpression: '5 * * * *',
        })).resolves.toMatchObject({ id: 'cron-a', revision: 2, state: 'enabled' });
        expect(fake.rows).toHaveLength(1);
        expect(fake.rows[0]).toMatchObject({ input: { revision: 2 }, enabled: true });
        expect(fake.hatchet.api.workflowCronUpdate).not.toHaveBeenCalledWith(
            'provider-tenant', current.metadata.id, { enabled: true },
        );
    });

    it('persists an initial one-time trigger and rejects invalid cron syntax locally', async () => {
        const fake = fakeHatchet();
        const service = new HatchetAgentScheduleService({ hatchet: fake.hatchet as never, prisma: fake.prisma, isAgentAvailable: () => true });
        const triggerAt = '2099-01-01T00:00:00.000Z';

        await service.create(admin, {
            kind: 'once', displayName: 'once', agentId: 'agent-a', input: {}, triggerAt,
        });
        expect(fake.declaration.schedule.mock.calls[0]?.[1]).toMatchObject({ scheduledFor: triggerAt });
        await expect(service.create(admin, {
            kind: 'cron', displayName: 'invalid', agentId: 'agent-a', input: {}, cronExpression: '61 * * * *',
        })).rejects.toMatchObject({ code: 'SCHEDULE_INVALID', status: 400 });
        expect(fake.declaration.cron).not.toHaveBeenCalled();
    });

    it('maps provider validation responses to SCHEDULE_INVALID instead of an outage', async () => {
        const fake = fakeHatchet();
        fake.declaration.cron.mockRejectedValueOnce({ status: 422, message: 'cron rejected' } as never);
        const service = new HatchetAgentScheduleService({ hatchet: fake.hatchet as never, prisma: fake.prisma, isAgentAvailable: () => true });

        await expect(service.create(admin, {
            kind: 'cron', displayName: 'provider-invalid', agentId: 'agent-a', input: {}, cronExpression: '0 * * * *',
        })).rejects.toMatchObject({ code: 'SCHEDULE_INVALID', status: 400 });
    });

    it('writes correlated intent and outcome audits without storing payload values', async () => {
        const fake = fakeHatchet();
        const service = new HatchetAgentScheduleService({ hatchet: fake.hatchet as never, prisma: fake.prisma, isAgentAvailable: () => true });
        const created = await service.create(admin, {
            kind: 'cron', displayName: 'sweep', agentId: 'agent-a', input: { secretLikeValue: 'do-not-copy' }, cronExpression: '0 * * * *',
        });
        expect(created.payloadKeys).toEqual(['secretLikeValue']);
        expect(fake.auditWrites).toHaveLength(2);
        expect((fake.auditWrites[0]!.metadata as any).operationId).toBe((fake.auditWrites[1]!.metadata as any).operationId);
        expect(JSON.stringify(fake.auditWrites)).not.toContain('do-not-copy');
    });

    it('audits payload reads separately without copying the payload into audit metadata', async () => {
        const current = managedRow({ scheduleId: 'cron-a', kind: 'cron', agentId: 'agent-a', input: { privateValue: 'do-not-audit' } }, '2026-07-31T12:00:00.000Z');
        const fake = fakeHatchet([current]);
        const service = new HatchetAgentScheduleService({ hatchet: fake.hatchet as never, prisma: fake.prisma, isAgentAvailable: () => true });

        await expect(service.getPayload(operator, 'cron-a')).resolves.toEqual({
            scheduleId: 'cron-a', input: { privateValue: 'do-not-audit' },
        });
        expect(fake.auditWrites.map((row) => row.resultStatus)).toEqual(['requested', 'succeeded']);
        expect(JSON.stringify(fake.auditWrites)).not.toContain('do-not-audit');
    });

    it('maps provider failures to the stable unavailable error', async () => {
        const fake = fakeHatchet();
        fake.hatchet.crons.list.mockRejectedValueOnce(new Error('provider offline'));
        const service = new HatchetAgentScheduleService({ hatchet: fake.hatchet as never, prisma: fake.prisma, isAgentAvailable: () => true });

        await expect(service.list(viewer)).rejects.toMatchObject({
            code: 'SCHEDULE_PROVIDER_UNAVAILABLE', status: 503,
        });
    });
});
