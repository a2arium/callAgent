
import { logger } from '@a2arium/callagent-utils';
import type { SessionManager } from '../SessionManager.js';
import type { TaskContext } from '../../shared/types/index.js';

const log = logger.createLogger({ prefix: 'SnapshotRepository' });

export type MutatorFn = (snapshot: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;

export interface SaveWithRetryOptions {
    tenantId: string;
    sessionId: string;
    agentId?: string;
    mutate: MutatorFn;
    maxRetries?: number;
    backoffMs?: number;
}

export class SnapshotRepository {
    constructor(private sessionManager: SessionManager) { }

    /**
     * Load a snapshot for a session.
     */
    async load(tenantId: string, sessionId: string) {
        return this.sessionManager.load(tenantId, sessionId);
    }

    /**
     * loads, mutates, and saves a snapshot with CAS retry.
     */
    async saveWithRetry(opts: SaveWithRetryOptions): Promise<void> {
        const { tenantId, sessionId, mutate, maxRetries = 3, backoffMs = 200 } = opts;

        let attempts = 0;
        let lastError: Error | undefined;

        while (attempts < maxRetries) {
            attempts++;
            try {
                // 1. Load latest
                const session = await this.sessionManager.load(tenantId, sessionId);
                const baseSnapshot = (session?.snapshot as Record<string, unknown>) || {};
                const expectedWmVersion = session?.wmVersion ?? BigInt(0);
                const currentAgentId = (session as any)?.agentId ?? opts.agentId ?? 'default';

                // 2. Apply mutation
                const nextSnapshot = await mutate(baseSnapshot);

                // 3. Save with expectation
                // If agentId is not passed in opts, preserve existing or fall back to default
                const agentIdToSave = opts.agentId || currentAgentId;

                await this.sessionManager.saveSnapshot({
                    tenantId,
                    sessionId,
                    agentId: agentIdToSave,
                    expectedWmVersion,
                    snapshot: nextSnapshot
                });

                // Success
                return;
            } catch (err: any) {
                lastError = err;
                if (err.message === 'CAS_MISMATCH') {
                    log.warn(`CAS mismatch for ${sessionId} (attempt ${attempts}/${maxRetries}). Retrying...`);
                    if (attempts < maxRetries) {
                        await new Promise(resolve => setTimeout(resolve, backoffMs * attempts));
                        continue;
                    }
                }
                // If not CAS error or max retries hit, throw
                throw err;
            }
        }

        throw lastError || new Error('Available retries exhausted for saveWithRetry');
    }

    /**
     * Helper to append an event, wrapping session manager.
     */
    async appendEvent(tenantId: string, sessionId: string, type: string, payload: Record<string, unknown>) {
        return this.sessionManager.appendEvent(tenantId, sessionId, type, payload);
    }

    /**
     * Helper to enqueue outcome/status to outbox.
     */
    async enqueueOutbox(tenantId: string, type: string, traceId: string, payload: Record<string, unknown>): Promise<void> {
        return this.sessionManager.enqueueOutbox(tenantId, type, traceId, payload);
    }
}
