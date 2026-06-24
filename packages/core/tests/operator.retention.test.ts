import { jest } from '@jest/globals';
import { OperatorRetentionService } from '../src/operator/retention.js';
import { defaultMetricsRegistry } from '../src/observability/metrics.js';

function delegate(rows: Array<Record<string, unknown>>) {
    return {
        count: jest.fn(async () => rows.length),
        findMany: jest.fn(async (args: any) => rows.slice(0, args.take ?? rows.length)),
        deleteMany: jest.fn(async (args: any) => {
            const ids = args.where.id?.in ?? args.where.eventId?.in ?? [];
            return { count: ids.length };
        }),
    };
}

describe('OperatorRetentionService', () => {
    afterEach(() => {
        defaultMetricsRegistry.reset();
        delete process.env.CALLAGENT_RETENTION_APPLY;
        delete process.env.CALLAGENT_RETENTION_PRUNE_WM_EVENTS;
    });

    it('dry-runs debug candidates without deleting semantic summaries', async () => {
        const driverRun = delegate([{ id: 'driver-1' }, { id: 'driver-2' }]);
        const service = new OperatorRetentionService({ driverRun }, {
            semanticDays: 365,
            auditDays: 365,
            debugDays: 7,
            batchSize: 1,
        });

        const plan = await service.plan({
            tenantId: 'tenant-1',
            now: new Date('2026-06-24T00:00:00.000Z'),
        });

        expect(plan.dryRun).toBe(true);
        expect(plan.tables).toEqual(expect.arrayContaining([
            expect.objectContaining({ table: 'driver_runs', count: 2, retentionClass: 'debug', preserved: false }),
            expect.objectContaining({ table: 'agent_runs', count: 0, retentionClass: 'semantic', preserved: true }),
            expect.objectContaining({ table: 'turn_runs', count: 0, retentionClass: 'semantic', preserved: true }),
        ]));
        expect(driverRun.findMany).toHaveBeenCalledWith(expect.objectContaining({
            select: { id: true },
        }));
        expect(driverRun.deleteMany).not.toHaveBeenCalled();
    });

    it('requires explicit apply env before deleting rows', async () => {
        const driverRun = delegate([{ id: 'driver-1' }]);
        const service = new OperatorRetentionService({ driverRun }, {
            semanticDays: 365,
            auditDays: 365,
            debugDays: 7,
            batchSize: 1,
        });

        await expect(service.apply({
            tenantId: 'tenant-1',
            actorId: 'tester',
            actorType: 'service',
        })).rejects.toThrow('CALLAGENT_RETENTION_APPLY=true');
        expect(driverRun.deleteMany).not.toHaveBeenCalled();
    });

    it('applies bounded debug pruning and writes an audit record', async () => {
        process.env.CALLAGENT_RETENTION_APPLY = 'true';
        const driverRun = delegate([{ id: 'driver-1' }, { id: 'driver-2' }]);
        const create = jest.fn(async () => ({}));
        const service = new OperatorRetentionService({
            driverRun,
            operatorAuditEvent: { create },
        }, {
            semanticDays: 365,
            auditDays: 365,
            debugDays: 7,
            batchSize: 1,
        });

        const plan = await service.apply({
            tenantId: 'tenant-1',
            actorId: 'tester',
            actorType: 'service',
            now: new Date('2026-06-24T00:00:00.000Z'),
        });

        expect(plan.apply).toBe(true);
        expect(driverRun.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1 }));
        expect(driverRun.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['driver-1'] } } });
        expect(create).toHaveBeenNthCalledWith(1, {
            data: expect.objectContaining({
                tenantId: 'tenant-1',
                action: 'delete',
                actorId: 'tester',
                accepted: true,
                resultStatus: 'requested',
            }),
        });
        expect(create).toHaveBeenNthCalledWith(2, {
            data: expect.objectContaining({
                tenantId: 'tenant-1',
                action: 'delete',
                actorId: 'tester',
                accepted: true,
                resultStatus: 'applied',
            }),
        });
    });

    it('does not prune raw wm_events unless semantic readiness is explicitly confirmed', async () => {
        process.env.CALLAGENT_RETENTION_APPLY = 'true';
        const wMEvent = delegate([{ eventId: 'event-1' }]);
        const create = jest.fn(async () => ({}));
        const service = new OperatorRetentionService({
            wMEvent,
            operatorAuditEvent: { create },
        }, {
            semanticDays: 365,
            auditDays: 365,
            debugDays: 7,
            batchSize: 1,
        });

        const plan = await service.apply({
            tenantId: 'tenant-1',
            actorId: 'tester',
            actorType: 'service',
        });

        expect(plan.tables).toEqual(expect.arrayContaining([
            expect.objectContaining({
                table: 'wm_events',
                count: 1,
                applyEnabled: false,
                applyBlocker: 'CALLAGENT_RETENTION_PRUNE_WM_EVENTS=true is required',
            }),
        ]));
        expect(wMEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
            select: { eventId: true },
        }));
        expect(wMEvent.deleteMany).not.toHaveBeenCalled();

        process.env.CALLAGENT_RETENTION_PRUNE_WM_EVENTS = 'true';
        await service.apply({
            tenantId: 'tenant-1',
            actorId: 'tester',
            actorType: 'service',
        });
        expect(wMEvent.deleteMany).toHaveBeenCalledWith({ where: { eventId: { in: ['event-1'] } } });
    });

    it('does not include ambiguous outbox rows as pruning targets', async () => {
        const service = new OperatorRetentionService({}, {
            semanticDays: 365,
            auditDays: 365,
            debugDays: 7,
            batchSize: 1,
        });

        const plan = await service.plan({ tenantId: 'tenant-1' });

        expect(plan.tables.some((table) => table.table === 'outbox')).toBe(false);
    });
});
