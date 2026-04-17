import type { SessionManager } from '../../orchestration/SessionManager.js';
import type { ThreadRef } from '../../public-types/conversation/types.js';
import type { Observation } from '../../types/observation.js';
import { ConversationRouter } from './ConversationRouter.js';
import { wallClock, type Clock } from './Clock.js';
import type { ConversationServiceDeps } from './types.js';

export type ThreadLifecycleSweepResult = {
    expiredThreadIds: string[];
    archivedThreadIds: string[];
};

export class ThreadLifecycleSweeper {
    private readonly router: ConversationRouter;

    constructor(
        private readonly sessionManager: SessionManager,
        private readonly routeTargetForThread: ConversationServiceDeps['routeTargetForThread'],
        private readonly clock: Clock = wallClock
    ) {
        this.router = new ConversationRouter(sessionManager);
    }

    async sweepTenant(params: {
        tenantId: string;
        nowIso?: string;
        limit?: number;
        autoArchiveAfterMs?: number | null;
    }): Promise<ThreadLifecycleSweepResult> {
        const nowIso = params.nowIso ?? this.clock.now().toISOString();
        const limit = params.limit ?? 100;
        const expiredThreadIds: string[] = [];
        const expiredRows = await this.sessionManager.listConversationThreadsForSweep({
            tenantId: params.tenantId,
            mode: 'expireOpen',
            nowIso,
            limit,
        });
        for (const row of expiredRows) {
            const threadRef: ThreadRef = { kind: 'thread', id: row.conversationId };
            await this.sessionManager.updateConversationThreadStatus({
                kind: 'close',
                tenantId: row.tenantId,
                conversationId: row.conversationId,
                closedAt: nowIso,
                closeReason: 'ttl',
                closeReasonText: null,
                closedByAgentId: null,
            });
            const threadClosedObs = {
                source: 'conversation',
                payload: {
                    kind: 'thread.closed' as const,
                    thread: threadRef,
                    ts: nowIso,
                    closedReason: 'ttl' as const,
                },
            } as Observation;
            const ownerTarget = this.routeTargetForThread({
                tenantId: row.tenantId,
                threadId: row.conversationId,
                recipientAgentId: row.ownerAgentId,
            });
            const participantTarget = this.routeTargetForThread({
                tenantId: row.tenantId,
                threadId: row.conversationId,
                recipientAgentId: row.participantAgentId,
            });
            await this.router.routeObservations([
                {
                    tenantId: row.tenantId,
                    sessionId: ownerTarget.sessionId,
                    agentId: row.ownerAgentId,
                    observation: threadClosedObs,
                },
                {
                    tenantId: row.tenantId,
                    sessionId: participantTarget.sessionId,
                    agentId: row.participantAgentId,
                    observation: threadClosedObs,
                },
            ]);
            expiredThreadIds.push(row.conversationId);
        }

        const archivedThreadIds: string[] = [];
        const autoMs = params.autoArchiveAfterMs;
        if (autoMs != null && autoMs > 0) {
            const closedBeforeIso = new Date(Date.parse(nowIso) - autoMs).toISOString();
            const archiveRows = await this.sessionManager.listConversationThreadsForSweep({
                tenantId: params.tenantId,
                mode: 'archiveClosed',
                nowIso,
                closedBeforeIso,
                limit,
            });
            for (const row of archiveRows) {
                const threadRef: ThreadRef = { kind: 'thread', id: row.conversationId };
                await this.sessionManager.updateConversationThreadStatus({
                    kind: 'archive',
                    tenantId: row.tenantId,
                    conversationId: row.conversationId,
                    archivedAt: nowIso,
                    archivedByAgentId: null,
                    archivedReasonText: null,
                });
                const archivedObs = {
                    source: 'conversation',
                    payload: {
                        kind: 'thread.archived' as const,
                        thread: threadRef,
                        ts: nowIso,
                    },
                } as Observation;
                const ownerTarget = this.routeTargetForThread({
                    tenantId: row.tenantId,
                    threadId: row.conversationId,
                    recipientAgentId: row.ownerAgentId,
                });
                const participantTarget = this.routeTargetForThread({
                    tenantId: row.tenantId,
                    threadId: row.conversationId,
                    recipientAgentId: row.participantAgentId,
                });
                await this.router.routeObservations([
                    {
                        tenantId: row.tenantId,
                        sessionId: ownerTarget.sessionId,
                        agentId: row.ownerAgentId,
                        observation: archivedObs,
                    },
                    {
                        tenantId: row.tenantId,
                        sessionId: participantTarget.sessionId,
                        agentId: row.participantAgentId,
                        observation: archivedObs,
                    },
                ]);
                archivedThreadIds.push(row.conversationId);
            }
        }

        return { expiredThreadIds, archivedThreadIds };
    }
}
