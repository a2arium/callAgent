import type { SessionManager } from '../../orchestration/SessionManager.js';
import {
    conversationInboxDeliveryKey,
    filterInboxCurrentByConversationDeliveryKeys,
    inboxAllHasConversationDeliveryKey,
    readConsumedConversationDeliveryKeysFromMeta,
} from '../../loop/conversationInboxIdentity.js';
import { normalizeObservationInbox } from '../../loop/types.js';
import { ObservationSchema, type Observation } from '../../types/observation.js';

type RouteObservationParams = {
    tenantId: string;
    sessionId: string;
    agentId: string;
    observation: Observation;
};

export class ConversationRouter {
    constructor(private readonly sessionManager: SessionManager) {}

    async routeObservation(params: RouteObservationParams): Promise<void> {
        const observation = ObservationSchema.parse(params.observation);
        const maxAttempts = 5;
        let lastError: unknown;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const loaded = await this.sessionManager.load(params.tenantId, params.sessionId);
            const baseSnapshot = (loaded?.snapshot as Record<string, unknown>) ?? {};
            const baseMeta = (baseSnapshot as { meta?: Record<string, unknown> }).meta ?? {};
            const consumedKeys = readConsumedConversationDeliveryKeysFromMeta(baseMeta);
            const rawInbox = normalizeObservationInbox((baseSnapshot as { inbox?: unknown }).inbox);
            const originalCurrentLength = rawInbox.current.length;
            const inbox = filterInboxCurrentByConversationDeliveryKeys(rawInbox, consumedKeys);
            const deliveryKey = conversationInboxDeliveryKey(observation);
            if (
                deliveryKey !== undefined &&
                (consumedKeys.has(deliveryKey) || inboxAllHasConversationDeliveryKey(inbox, deliveryKey))
            ) {
                if (inbox.current.length === originalCurrentLength) {
                    return;
                }
                try {
                    await this.sessionManager.saveSnapshot({
                        tenantId: params.tenantId,
                        sessionId: params.sessionId,
                        agentId: params.agentId,
                        expectedWmVersion: loaded?.wmVersion ?? BigInt(0),
                        snapshot: {
                            ...baseSnapshot,
                            inbox,
                            meta: {
                                ...baseMeta,
                                agentId: params.agentId,
                            },
                        },
                    });
                    return;
                } catch (err) {
                    lastError = err;
                    if (isCasMismatch(err) && attempt < maxAttempts) {
                        await backoff(attempt);
                        continue;
                    }
                    throw err;
                }
            }
            inbox.current.push(observation);
            inbox.all.push(observation);

            const expectedWmVersion = loaded?.wmVersion ?? BigInt(0);
            const snapshot = {
                ...baseSnapshot,
                inbox,
                meta: {
                    ...baseMeta,
                    agentId: params.agentId,
                },
            };
            try {
                await this.sessionManager.saveSnapshot({
                    tenantId: params.tenantId,
                    sessionId: params.sessionId,
                    agentId: params.agentId,
                    expectedWmVersion,
                    snapshot,
                });
                return;
            } catch (err) {
                lastError = err;
                if (isCasMismatch(err) && attempt < maxAttempts) {
                    await backoff(attempt);
                    continue;
                }
                throw err;
            }
        }

        throw lastError instanceof Error ? lastError : new Error('ConversationRouter routeObservation failed');
    }

    async routeObservations(targets: RouteObservationParams[]): Promise<void> {
        for (const t of targets) {
            await this.routeObservation(t);
        }
    }
}

const isCasMismatch = (err: unknown): boolean => {
    const message = err instanceof Error ? err.message : String(err);
    return message === 'CAS_MISMATCH' || message === 'WM_VERSION_CONFLICT';
};

const backoff = (attempt: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, attempt * 10));
