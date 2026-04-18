import type { IEventBus } from '../../public-types/eventbus/types.js';
import type { BusEvent } from '../../public-types/eventbus/schemas.js';
import { ConversationPayloadSchema } from '../../types/observation.js';
import type { SessionManager } from '../../orchestration/SessionManager.js';
import type {
    ConversationActivateParams,
    ConversationActivateResult,
} from './types.js';
import { ConversationRouter } from './ConversationRouter.js';
import type { Observation } from '../../types/observation.js';
import { wallClock, type Clock } from './Clock.js';
import { busEventData } from '../../eventbus/busEventHelpers.js';

const INVITE_ISSUED_CHANNEL = 'conversation.topic.invite.issued';

const MAX_DELIVERY_ATTEMPTS = 5;
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];

type ActivateConversationRecipient = (
    params: ConversationActivateParams
) => Promise<ConversationActivateResult>;

type InviteIssuedEventEnvelope = {
    tenantId: string;
    payload: unknown;
};

function sleep(ms: number): Promise<void> {
    const capped = Math.min(ms, 30_000);
    return new Promise((resolve) => setTimeout(resolve, capped));
}

export class InviteDeliveryCoordinator {
    private readonly router: ConversationRouter;
    private readonly boundHandler = async (event: BusEvent): Promise<void> => {
        await this.handleInviteIssued(event);
    };
    private started = false;
    private unsubscribeInvite: (() => Promise<void>) | undefined;

    constructor(
        private readonly sessionManager: SessionManager,
        private readonly eventBus: IEventBus,
        private readonly activateConversationRecipient: ActivateConversationRecipient,
        private readonly clock: Clock = wallClock
    ) {
        this.router = new ConversationRouter(this.sessionManager);
    }

    async start(): Promise<void> {
        if (this.started) {
            return;
        }
        this.started = true;
        const { unsubscribe } = await this.eventBus.subscribe(INVITE_ISSUED_CHANNEL, this.boundHandler);
        this.unsubscribeInvite = unsubscribe;
    }

    async stop(): Promise<void> {
        if (!this.started) {
            return;
        }
        this.started = false;
        if (this.unsubscribeInvite) {
            await this.unsubscribeInvite();
            this.unsubscribeInvite = undefined;
        }
    }

    private async handleInviteIssued(event: BusEvent): Promise<void> {
        const envelope = busEventData<InviteIssuedEventEnvelope>(event);
        const tenantId = envelope?.tenantId;
        const parsed = ConversationPayloadSchema.safeParse(envelope?.payload);
        if (!parsed.success || parsed.data.kind !== 'topic.invite.issued') {
            return;
        }
        if (typeof tenantId !== 'string' || tenantId.length === 0) {
            return;
        }
        const payload = parsed.data;
        const tokenStr = String(payload.token);

        for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) {
            const inviteRow = await this.sessionManager.getConversationTopicInvite({
                tenantId,
                token: tokenStr,
            });
            if (
                !inviteRow ||
                inviteRow.consumedAt !== null ||
                inviteRow.declinedAt !== null ||
                inviteRow.deliveredAt !== null
            ) {
                return;
            }

            const nowIso = this.clock.now().toISOString();
            await this.sessionManager.markConversationTopicInviteDeliveryAttempt({
                tenantId,
                token: tokenStr,
                attemptedAt: nowIso,
            });

            const sessionId = inviteRow.sessionIdOverride ?? `agent-inbox:${payload.invitee.agentId}`;
            const receivedPayload = {
                kind: 'topic.invite.received' as const,
                topic: payload.topic,
                token: payload.token,
                expiresAt: payload.expiresAt,
                role: payload.invitee.role,
                inviterAgentId: payload.inviterAgentId,
                inviteeMemberId: payload.invitee.memberId,
                ts: payload.ts,
                correlationId: payload.correlationId,
            };

            try {
                await this.router.routeObservation({
                    tenantId,
                    sessionId,
                    agentId: payload.invitee.agentId,
                    observation: {
                        source: 'conversation',
                        payload: receivedPayload,
                    } as Observation,
                });
                await this.activateConversationRecipient({
                    kind: 'invite',
                    tenantId,
                    topicId: payload.topic.id,
                    routingSessionId: sessionId,
                    recipientAgentId: payload.invitee.agentId,
                    inviterAgentId: payload.inviterAgentId,
                    token: payload.token,
                });
                await this.sessionManager.markConversationTopicInviteDelivered({
                    tenantId,
                    token: tokenStr,
                    deliveredAt: this.clock.now().toISOString(),
                });
                return;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                const reason = msg.length > 2000 ? `${msg.slice(0, 2000)}…` : msg;
                await this.sessionManager.setConversationTopicInviteDeliveryFailureReason({
                    tenantId,
                    token: tokenStr,
                    reason,
                });
                if (attempt === MAX_DELIVERY_ATTEMPTS - 1) {
                    return;
                }
                const backoff = BACKOFF_MS[attempt] ?? 8000;
                await sleep(backoff);
            }
        }
    }
}
