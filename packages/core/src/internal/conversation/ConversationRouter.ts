import type { SessionManager } from '../../orchestration/SessionManager.js';
import {
    conversationInboxDeliveryKey,
    filterInboxCurrentByConversationDeliveryKeys,
    inboxAllHasConversationDeliveryKey,
    readConsumedConversationDeliveryKeysFromMeta,
} from '../../loop/conversationInboxIdentity.js';
import { normalizeObservationInbox } from '../../loop/types.js';
import type { Observation } from '../../types/observation.js';

type RouteObservationParams = {
    tenantId: string;
    sessionId: string;
    agentId: string;
    observation: Observation;
};

export class ConversationRouter {
    constructor(private readonly sessionManager: SessionManager) {}

    async routeObservation(params: RouteObservationParams): Promise<void> {
        const loaded = await this.sessionManager.load(params.tenantId, params.sessionId);
        const baseSnapshot = (loaded?.snapshot as Record<string, unknown>) ?? {};
        const baseMeta = (baseSnapshot as { meta?: Record<string, unknown> }).meta ?? {};
        const consumedKeys = readConsumedConversationDeliveryKeysFromMeta(baseMeta);
        const rawInbox = normalizeObservationInbox((baseSnapshot as { inbox?: unknown }).inbox);
        const originalCurrentLength = rawInbox.current.length;
        const inbox = filterInboxCurrentByConversationDeliveryKeys(rawInbox, consumedKeys);
        const deliveryKey = conversationInboxDeliveryKey(params.observation);
        if (
            deliveryKey !== undefined &&
            (consumedKeys.has(deliveryKey) || inboxAllHasConversationDeliveryKey(inbox, deliveryKey))
        ) {
            if (inbox.current.length !== originalCurrentLength) {
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
            }
            return;
        }
        inbox.current.push(params.observation);
        inbox.all.push(params.observation);

        const expectedWmVersion = loaded?.wmVersion ?? BigInt(0);
        const snapshot = {
            ...baseSnapshot,
            inbox,
            meta: {
                ...baseMeta,
                agentId: params.agentId,
            },
        };
        await this.sessionManager.saveSnapshot({
            tenantId: params.tenantId,
            sessionId: params.sessionId,
            agentId: params.agentId,
            expectedWmVersion,
            snapshot,
        });
    }

    async routeObservations(targets: RouteObservationParams[]): Promise<void> {
        for (const t of targets) {
            await this.routeObservation(t);
        }
    }
}

