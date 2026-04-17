import type { TaskContext, MentalState, MemoryReader, Intent, ExecOutcome } from '@a2arium/callagent-core';
import { memberId } from '@a2arium/callagent-core';
import { logger } from '@a2arium/callagent-utils';
import type { ExecPayload, ExecError, Sensory } from './types.js';
import type { PanelLens } from './constants.js';
import { PANEL_SEAT_AGENT_ID } from './constants.js';

const log = logger.createLogger({ prefix: 'conversation-panel-persona-agent' });

function lensInstructions(lens: PanelLens): string {
    if (lens === 'critic') {
        return 'You are the CRITIC seat: name concrete risks, failure modes, and what could go wrong. Be sharp but constructive.';
    }
    if (lens === 'dreamer') {
        return 'You are the DREAMER seat: stretch the vision, name bold possibilities, and what could be amazing if constraints relaxed.';
    }
    return 'You are the REALIST seat: name tradeoffs, scope cuts, and what a shippable first version actually requires.';
}

async function synthesizeVoice(lens: PanelLens, round: number, promptText: string, ctx: TaskContext): Promise<string> {
    const body = `${lensInstructions(lens)}

Moderator prompt (round ${round}):
${promptText}

Reply in exactly two short sentences. Plain prose only, no bullet list.`;
    try {
        const responses = await ctx.llm.call(body);
        const text = responses[0]?.content?.trim();
        if (text && text.length > 0) {
            return text;
        }
    } catch (e) {
        log.warn('panel.llm_failed', { lens, message: e instanceof Error ? e.message : String(e) });
    }
    return `${lens} seat (offline): weigh ambition against delivery risk for round ${round}.`;
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
            result: { status: 'ok', data: { voiced: false } },
        };
    }
    if (intent.kind !== 'internal' || intent.intent !== 'panel_persona_voice') {
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
    const data = intent.data as {
        topicId?: string;
        lens?: PanelLens;
        promptText?: string;
        inboundMessageId?: string;
        inboundSequence?: number;
        round?: number;
        seatMemberId?: string;
    };
    const topicId = data.topicId;
    const lens = data.lens;
    const inboundMessageId = data.inboundMessageId;
    const seatMemberIdRaw = data.seatMemberId;
    if (!topicId || !lens || !inboundMessageId || !seatMemberIdRaw) {
        return {
            action: { kind: 'internal', done: true },
            result: {
                status: 'error',
                error: {
                    code: 'bad_data',
                    message: 'missing topicId, lens, inboundMessageId, or seatMemberId',
                },
            },
        };
    }
    const senderMemberId = memberId(seatMemberIdRaw);
    const promptText = data.promptText ?? '';
    const round = typeof data.round === 'number' ? data.round : 0;
    const voice = await synthesizeVoice(lens, round, promptText, ctx);
    const topic = { kind: 'topic' as const, id: topicId };
    const idempotencyKey = `panel-voice:${inboundMessageId}:${data.seatMemberId ?? ctx.agentId}`;
    const receipt = await ctx.conversation.post(
        topic,
        {
            senderAgentId: PANEL_SEAT_AGENT_ID,
            senderMemberId,
            speechAct: 'inform',
            content: {
                phase: 'panel_voice',
                lens,
                round,
                voice,
            },
        },
        { selector: { kind: 'broadcast' }, idempotencyKey }
    );
    if (receipt.status !== 'accepted') {
        return {
            action: { kind: 'internal', done: true },
            result: {
                status: 'error',
                error: {
                    code: 'post_rejected',
                    message: receipt.status === 'rejected' ? receipt.error.message : 'topic post not accepted',
                },
            },
        };
    }
    log.info('panel.persona_voice_sent', { lens, round, topicId });
    return {
        action: { kind: 'internal', done: true },
        result: {
            status: 'ok',
            data: {
                voiced: true,
                topicId,
                outboundPreview: voice.slice(0, 120),
            },
        },
    };
}
