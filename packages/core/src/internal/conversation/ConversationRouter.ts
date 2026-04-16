import type { SessionManager } from '../../orchestration/SessionManager.js';
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
        const inbox = normalizeObservationInbox((baseSnapshot as { inbox?: unknown }).inbox);
        inbox.current.push(params.observation);
        inbox.all.push(params.observation);

        const expectedWmVersion = loaded?.wmVersion ?? BigInt(0);
        const snapshot = {
            ...baseSnapshot,
            inbox,
            meta: {
                ...((baseSnapshot as { meta?: Record<string, unknown> }).meta ?? {}),
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
}

