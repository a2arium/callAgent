import { jest } from '@jest/globals';
import { WorkingMemoryVersionConflictError } from '@a2arium/callagent-types';
import { InMemorySessionManager } from '../src/orchestration/InMemorySessionManager.js';
import {
    SnapshotReconciliationError,
    reconcileSnapshotMutation,
} from '../src/orchestration/persistence/SnapshotRepository.js';

const conflict = (expected: bigint, actual: bigint) =>
    new WorkingMemoryVersionConflictError({
        tenantId: 'tenant',
        sessionId: 'session',
        expectedWmVersion: expected.toString(),
        actualWmVersion: actual.toString(),
    }, 'CAS_MISMATCH');

describe('reconcileSnapshotMutation', () => {
    test('reloads and reapplies a logical mutation after a conflicting writer wins', async () => {
        let current = { wmVersion: BigInt(1), snapshot: { parent: true }, agentId: 'agent' };
        let writes = 0;
        const session = {
            load: jest.fn(async () => current),
            saveSnapshot: jest.fn(async (params: any) => {
                writes += 1;
                if (writes === 1) {
                    current = {
                        wmVersion: BigInt(2),
                        snapshot: { ...current.snapshot, concurrent: true },
                        agentId: 'agent',
                    };
                    throw conflict(params.expectedWmVersion, current.wmVersion);
                }
                current = {
                    wmVersion: params.expectedWmVersion + BigInt(1),
                    snapshot: params.snapshot,
                    agentId: 'agent',
                };
                return { newVersion: current.wmVersion };
            }),
        };

        const result = await reconcileSnapshotMutation({
            session,
            tenantId: 'tenant',
            sessionId: 'session',
            operation: 'test.merge',
            random: () => 0,
            mutate: ({ snapshot }) => ({
                kind: 'write',
                snapshot: { ...snapshot, child: true },
                value: 'ok',
            }),
        });

        expect(result).toMatchObject({ status: 'committed', value: 'ok', attempts: 2 });
        expect(current.snapshot).toEqual({ parent: true, concurrent: true, child: true });
    });

    test('can commit on the final allowed attempt', async () => {
        let version = BigInt(1);
        const session = {
            load: jest.fn(async () => ({ wmVersion: version, snapshot: {}, agentId: 'agent' })),
            saveSnapshot: jest.fn(async (params: any) => {
                if (params.expectedWmVersion < BigInt(3)) {
                    version += BigInt(1);
                    throw conflict(params.expectedWmVersion, version);
                }
                version += BigInt(1);
                return { newVersion: version };
            }),
        };

        const result = await reconcileSnapshotMutation({
            session,
            tenantId: 'tenant',
            sessionId: 'session',
            operation: 'test.final_attempt',
            maxAttempts: 3,
            random: () => 0,
            mutate: ({ snapshot }) => ({ kind: 'write', snapshot, value: undefined }),
        });

        expect(result.attempts).toBe(3);
        expect(result.status).toBe('committed');
    });

    test('throws a typed sanitized error after permanent conflicts', async () => {
        const session = {
            load: jest.fn(async () => ({ wmVersion: BigInt(7), snapshot: { secret: 'do-not-leak' }, agentId: 'agent' })),
            saveSnapshot: jest.fn(async () => { throw conflict(BigInt(7), BigInt(8)); }),
        };

        let thrown: unknown;
        try {
            await reconcileSnapshotMutation({
                session,
                tenantId: 'tenant',
                sessionId: 'session',
                operation: 'child.dispatch.register',
                maxAttempts: 2,
                random: () => 0,
                mutate: ({ snapshot }) => ({ kind: 'write', snapshot, value: undefined }),
            });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(SnapshotReconciliationError);
        expect(thrown).toMatchObject({
            code: 'WM_SNAPSHOT_RECONCILIATION_EXHAUSTED',
            reconciliation: {
                operation: 'child.dispatch.register',
                attempts: 2,
                expectedWmVersion: '7',
                actualWmVersion: '8',
                storageCode: 'WM_VERSION_CONFLICT',
            },
        });
        expect(JSON.stringify(thrown)).not.toContain('do-not-leak');
        expect((thrown as Error).message).not.toContain('CAS_MISMATCH');
    });
});

describe('InMemorySessionManager CAS parity', () => {
    test('rejects a nonzero expected version when the row does not exist', async () => {
        const store = new InMemorySessionManager();
        await expect(store.writeSnapshotCAS({
            tenantId: 'tenant',
            sessionId: 'missing',
            agentId: 'agent',
            expectedWmVersion: BigInt(2),
            snapshot: {},
        })).rejects.toMatchObject({
            code: 'WM_VERSION_CONFLICT',
            conflict: { expectedWmVersion: '2', actualWmVersion: '0' },
        });
    });

    test('preserves the original agent identity on updates', async () => {
        const store = new InMemorySessionManager();
        await store.writeSnapshotCAS({
            tenantId: 'tenant', sessionId: 'session', agentId: 'original',
            expectedWmVersion: BigInt(0), snapshot: { first: true },
        });
        await store.writeSnapshotCAS({
            tenantId: 'tenant', sessionId: 'session', agentId: 'replacement',
            expectedWmVersion: BigInt(1), snapshot: { second: true },
        });
        expect(await store.getSessionSnapshot('tenant', 'session')).toMatchObject({
            agentId: 'original',
            wmVersion: BigInt(2),
            snapshot: { second: true },
        });
    });
});
