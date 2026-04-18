import type { TaskContext, MentalState, MemoryReader, Intent, ExecOutcome } from '@a2arium/callagent-core';
import { memberId } from '@a2arium/callagent-core';
import { logger } from '@a2arium/callagent-utils';
import { randomUUID } from 'node:crypto';
import type { ExecPayload, ExecError, Sensory } from './types.js';

/** Keep aligned with `conversation-panel-persona-agent/constants.ts` (`PANEL_TOPIC_ID_PREFIX`). */
const PANEL_ORCHESTRATOR_AGENT_ID = 'conversation-panel-orchestrator-agent' as const;
const PANEL_SEAT_AGENT_ID = 'conversation-panel-persona-agent' as const;
const SEAT_CRITIC = memberId('conversation-panel-persona-agent#critic');
const SEAT_DREAMER = memberId('conversation-panel-persona-agent#dreamer');
const SEAT_REALIST = memberId('conversation-panel-persona-agent#realist');

const log = logger.createLogger({ prefix: 'conversation-panel-orchestrator-agent' });

const OWNER_SEAT = memberId('conversation-panel-orchestrator-agent#owner');

const PANEL_DEBATE =
    'Should an agent framework optimize for minimal onboarding friction, or for maximum architectural flexibility?';

async function moderatorFraming(ctx: TaskContext): Promise<string> {
    const q = `One clear sentence framing this panel debate for three experts: ${PANEL_DEBATE}`;
    try {
        const r = await ctx.llm.call(q);
        const t = r[0]?.content?.trim();
        if (t) {
            return t;
        }
    } catch {
        /* offline */
    }
    return PANEL_DEBATE;
}

export async function execution(
    intent: Intent,
    ctx: TaskContext,
    _mem: MemoryReader,
    _m: MentalState<Sensory>
): Promise<ExecOutcome<ExecPayload, ExecError>> {
    if (intent.kind === 'wait') {
        return {
            action: { kind: 'internal', done: true },
            result: { status: 'ok', data: { panelDone: false } },
        };
    }
    if (intent.kind !== 'internal' || intent.intent !== 'panel_orchestrator_run') {
        return {
            action: { kind: 'internal', done: true },
            result: { status: 'error', error: { code: 'bad_intent', message: String(intent.kind) } },
        };
    }
    if (!ctx.conversation) {
        return {
            action: { kind: 'internal', done: true },
            result: {
                status: 'error',
                error: { code: 'no_conversation', message: 'TaskContext.conversation is not bound' },
            },
        };
    }
    if (ctx.agentId !== PANEL_ORCHESTRATOR_AGENT_ID) {
        return {
            action: { kind: 'internal', done: true },
            result: {
                status: 'error',
                error: { code: 'wrong_agent', message: 'orchestrator agent id mismatch' },
            },
        };
    }

    const topicId = `topic-panel-${randomUUID()}`;
    const topicRef = { kind: 'topic' as const, id: topicId };
    const created = await ctx.conversation.createTopic({
        topicId,
        members: [
            { agentId: ctx.agentId, memberId: OWNER_SEAT, role: 'owner' },
            { agentId: PANEL_SEAT_AGENT_ID, memberId: SEAT_CRITIC, role: 'participant' },
            { agentId: PANEL_SEAT_AGENT_ID, memberId: SEAT_DREAMER, role: 'participant' },
            { agentId: PANEL_SEAT_AGENT_ID, memberId: SEAT_REALIST, role: 'participant' },
        ],
        defaultSelector: { kind: 'broadcast' },
        stopPolicies: [{ kind: 'timeout', afterMs: 86_400_000 }],
    });
    if (created.status !== 'ok') {
        return {
            action: { kind: 'internal', done: true },
            result: {
                status: 'error',
                error: {
                    code: 'create_topic_failed',
                    message: created.status === 'rejected' ? created.error.message : 'createTopic failed',
                },
            },
        };
    }

    const framing = await moderatorFraming(ctx);

    type TurnSpec = { lens: 'critic' | 'dreamer' | 'realist'; seat: typeof SEAT_CRITIC; round: number };
    const turns: TurnSpec[] = [
        { lens: 'critic', seat: SEAT_CRITIC, round: 1 },
        { lens: 'dreamer', seat: SEAT_DREAMER, round: 1 },
        { lens: 'realist', seat: SEAT_REALIST, round: 1 },
        { lens: 'critic', seat: SEAT_CRITIC, round: 2 },
        { lens: 'dreamer', seat: SEAT_DREAMER, round: 2 },
        { lens: 'realist', seat: SEAT_REALIST, round: 2 },
    ];

    let n = 0;
    for (const t of turns) {
        n += 1;
        const prompt = `Round ${t.round} — ${t.lens} seat.\nContext: ${framing}\nSpeak from this seat only; two sentences when you reply.`;
        const receipt = await ctx.conversation.post(
            topicRef,
            {
                senderAgentId: ctx.agentId,
                senderMemberId: OWNER_SEAT,
                speechAct: 'inform',
                content: {
                    phase: 'panel_turn',
                    lens: t.lens,
                    round: t.round,
                    prompt,
                },
            },
            {
                selector: { kind: 'explicit_recipient', recipient: { by: 'memberId', memberId: t.seat } },
                idempotencyKey: `panel-orchestrator:${topicId}:${t.lens}:r${t.round}`,
            }
        );
        if (receipt.status !== 'accepted') {
            return {
                action: { kind: 'internal', done: true },
                result: {
                    status: 'error',
                    error: {
                        code: 'post_failed',
                        message: receipt.status === 'rejected' ? receipt.error.message : 'post not accepted',
                    },
                },
            };
        }
    }

    const closed = await ctx.conversation.close(topicRef, {});
    if (closed.status !== 'ok' || !closed.closed) {
        return {
            action: { kind: 'internal', done: true },
            result: { status: 'error', error: { code: 'close_failed', message: 'topic close failed' } },
        };
    }

    log.info('panel.orchestrator_done', { topicId, moderatorPosts: n });
    return {
        action: { kind: 'internal', done: true },
        result: {
            status: 'ok',
            data: {
                panelDone: true,
                topicId,
                turnsCompleted: n,
                summary: `Closed topic ${topicId} after ${n} moderator prompts (2 rounds × 3 seats, one agent).`,
            },
        },
    };
}
