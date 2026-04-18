import type { SessionManager } from '../../orchestration/SessionManager.js';
import type { TopicRef } from '../../public-types/conversation/types.js';
import type { Observation } from '../../types/observation.js';
import { ConversationRouter } from './ConversationRouter.js';
import { wallClock, type Clock } from './Clock.js';

export type TopicLifecycleSweepResult = {
    archivedTopicIds: string[];
};

/**
 * Auto-archives topics that have been `closed` longer than `autoArchiveAfterMs` (operator opt-in).
 */
export class TopicLifecycleSweeper {
    private readonly router: ConversationRouter;

    constructor(
        private readonly sessionManager: SessionManager,
        private readonly clock: Clock = wallClock
    ) {
        this.router = new ConversationRouter(sessionManager);
    }

    async sweepTenant(params: {
        tenantId: string;
        nowIso?: string;
        limit?: number;
        autoArchiveAfterMs?: number | null;
    }): Promise<TopicLifecycleSweepResult> {
        const nowIso = params.nowIso ?? this.clock.now().toISOString();
        const limit = params.limit ?? 100;
        const autoMs = params.autoArchiveAfterMs;
        const archivedTopicIds: string[] = [];
        if (autoMs == null || autoMs <= 0) {
            return { archivedTopicIds };
        }
        const closedBeforeIso = new Date(Date.parse(nowIso) - autoMs).toISOString();
        const rows = await this.sessionManager.listConversationTopicsForSweep({
            tenantId: params.tenantId,
            closedBeforeIso,
            limit,
        });
        for (const row of rows) {
            const topicRef: TopicRef = { kind: 'topic', id: row.conversationId };
            await this.sessionManager.updateConversationTopic({
                tenantId: row.tenantId,
                conversationId: row.conversationId,
                patch: {
                    status: 'archived',
                    archivedAt: nowIso,
                    archivedByAgentId: null,
                    archivedByMemberId: null,
                    archivedReasonText: null,
                },
            });
            const archivedObs = {
                source: 'conversation',
                payload: {
                    kind: 'topic.archived' as const,
                    topic: topicRef,
                    ts: nowIso,
                },
            } as Observation;
            const members = await this.sessionManager.listConversationTopicMembers({
                tenantId: row.tenantId,
                conversationId: row.conversationId,
                activeOnly: true,
            });
            await this.router.routeObservations(
                members.map((m) => ({
                    tenantId: row.tenantId,
                    sessionId: m.sessionId,
                    agentId: m.agentId,
                    observation: archivedObs,
                }))
            );
            archivedTopicIds.push(row.conversationId);
        }
        return { archivedTopicIds };
    }
}
