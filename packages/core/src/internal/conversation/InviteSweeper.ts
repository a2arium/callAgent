import type { SessionManager } from '../../orchestration/SessionManager.js';
import type { Observation } from '../../types/observation.js';
import { InviteTokenSchema, MemberIdSchema, TopicRefSchema } from '../../public-types/conversation/schemas.js';
import { ConversationRouter } from './ConversationRouter.js';
import { wallClock, type Clock } from './Clock.js';

export class InviteSweeper {
    private readonly router: ConversationRouter;

    constructor(
        private readonly sessionManager: SessionManager,
        private readonly clock: Clock = wallClock
    ) {
        this.router = new ConversationRouter(this.sessionManager);
    }

    async runExpirySweep(params: {
        tenantId: string;
        nowIso?: string;
        limit?: number;
    }): Promise<string[]> {
        const nowIso = params.nowIso ?? this.clock.now().toISOString();
        const rows = await this.sessionManager.listExpiredConversationTopicInvites({
            tenantId: params.tenantId,
            nowIso,
            limit: params.limit ?? 200,
        });
        const expiredTokens: string[] = [];
        for (const row of rows) {
            const declined = await this.sessionManager.declineConversationTopicInvite({
                tenantId: row.tenantId,
                token: row.token,
                declinedAt: nowIso,
                reason: 'expired',
            });
            if (!declined) {
                continue;
            }
            expiredTokens.push(row.token);
            const observation = {
                source: 'conversation',
                payload: {
                    kind: 'topic.invite.expired' as const,
                    topic: TopicRefSchema.parse({ kind: 'topic', id: row.conversationId }),
                    token: InviteTokenSchema.parse(row.token),
                    inviteeAgentId: row.inviteeAgentId,
                    inviteeMemberId: MemberIdSchema.parse(row.inviteeMemberId),
                    expiresAt: row.expiresAt,
                    ts: nowIso,
                    correlationId: undefined,
                },
            } as Observation;
            await this.router.routeObservation({
                tenantId: row.tenantId,
                sessionId: declined.inviterSessionId,
                agentId: declined.inviterAgentId,
                observation,
            });
        }
        return expiredTokens;
    }

    async runStartupRecoverySweep(params: {
        tenantId: string;
        publish: (channel: string, event: unknown) => Promise<void>;
        nowIso?: string;
        limit?: number;
    }): Promise<string[]> {
        const nowIso = params.nowIso ?? this.clock.now().toISOString();
        const rows = await this.sessionManager.listUndeliveredConversationTopicInvites({
            tenantId: params.tenantId,
            nowIso,
            limit: params.limit ?? 1000,
        });
        const republished: string[] = [];
        for (const row of rows) {
            republished.push(row.token);
            const issuedPayload = {
                kind: 'topic.invite.issued' as const,
                topic: TopicRefSchema.parse({ kind: 'topic', id: row.conversationId }),
                invitee: {
                    agentId: row.inviteeAgentId,
                    memberId: MemberIdSchema.parse(row.inviteeMemberId),
                    role: row.role,
                },
                token: InviteTokenSchema.parse(row.token),
                expiresAt: row.expiresAt,
                inviterAgentId: row.inviterAgentId,
                ts: row.issuedAt,
                correlationId: undefined,
            };
            await params.publish('conversation.topic.invite.issued', {
                tenantId: row.tenantId,
                payload: issuedPayload,
            });
        }
        return republished;
    }
}

