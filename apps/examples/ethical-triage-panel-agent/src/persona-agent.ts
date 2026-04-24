import { createAgent, memberId } from '@a2arium/callagent-core';
import type {
    EnvironmentState,
    Intent,
    MentalState,
    MemoryReader,
    MemoryWriter,
    TaskContext,
    ExecOutcome,
} from '@a2arium/callagent-core';
import type { Observation } from '@a2arium/callagent-core';
import { PERSONA_AGENT_ID, SEAT_DUTY, SEAT_FAIRNESS, SEAT_PRAGMATIST, SEAT_UTILITARIAN } from './composition.js';
import {
    fixtureCritiqueReplyRu,
    fixtureInitialBySeat,
    fixtureRevisionBySeat,
} from './test-fixtures.js';
import { TriageMessageBodySchema, jsonEnvelope } from './types.js';

type TriageWork = {
    topicId: string;
    phase: string;
    recipientSeat: string;
    inboundMessageId: string;
    body: unknown;
};

type Sensory = {
    work?: TriageWork;
};

type Obs =
    | { kind: 'idle' }
    | {
          kind: 'triage_inbound';
          work: TriageWork;
      };

type ExecPayload = { posted: boolean; preview?: string };
type ExecError = { code: string; message: string };

function unwrapInboundContent(content: unknown): unknown {
    if (content && typeof content === 'object' && content !== null && 'mimeType' in content && 'body' in content) {
        return (content as { body: unknown }).body;
    }
    return content;
}

function attention(_prev: MentalState<Sensory>, _env: unknown, _mem: MemoryReader): unknown {
    return undefined;
}

function perception(env: EnvironmentState, _alpha: unknown, _mem: MemoryReader): Obs {
    const obs = env.inbox.current.find((o: Observation) => {
        if (o.source !== 'conversation') {
            return false;
        }
        const p = o.payload as { kind?: string };
        return p?.kind === 'topic.message.received';
    }) as Observation | undefined;
    if (!obs || obs.source !== 'conversation') {
        return { kind: 'idle' };
    }
    const payload = obs.payload as {
        kind: 'topic.message.received';
        topic: { id: string };
        message: { id: string; content: unknown };
        recipient: { memberId: string };
    };
    const rawBody = unwrapInboundContent(payload.message.content);
    const work: TriageWork = {
        topicId: payload.topic.id,
        phase:
            rawBody && typeof rawBody === 'object' && rawBody !== null && 'phase' in rawBody
                ? String((rawBody as { phase: unknown }).phase)
                : '',
        recipientSeat: String(payload.recipient.memberId),
        inboundMessageId: payload.message.id,
        body: rawBody,
    };
    return { kind: 'triage_inbound', work };
}

function learning(
    prev: MentalState<Sensory>,
    _prevAction: Intent | undefined,
    obs: Obs,
    _mem: MemoryReader,
    _writer: MemoryWriter
): MentalState<Sensory> {
    if (obs.kind === 'idle') {
        return prev;
    }
    return {
        ...prev,
        memory: {
            ...prev.memory,
            sensory: {
                ...prev.memory.sensory,
                work: obs.work,
            },
        },
    };
}

function policy(m: MentalState<Sensory>, _mem: MemoryReader): Intent {
    const w = m.memory?.sensory?.work;
    if (!w) {
        return { kind: 'wait' };
    }
    return { kind: 'internal', intent: 'triage_persona_reply', data: { work: w } };
}

function shield(_m: MentalState<Sensory>, intent: Intent, _mem: MemoryReader) {
    return { action: 'pass' as const, intent };
}

function seatToFixtureKey(
    seat: string
): 'util' | 'fair' | 'duty' | 'prag' | null {
    if (seat === String(SEAT_UTILITARIAN)) {
        return 'util';
    }
    if (seat === String(SEAT_FAIRNESS)) {
        return 'fair';
    }
    if (seat === String(SEAT_DUTY)) {
        return 'duty';
    }
    if (seat === String(SEAT_PRAGMATIST)) {
        return 'prag';
    }
    return null;
}

async function execution(
    intent: Intent,
    ctx: TaskContext,
    _mem: MemoryReader,
    _m: MentalState<Sensory>
): Promise<ExecOutcome<ExecPayload, ExecError>> {
    if (intent.kind === 'wait') {
        return {
            action: { kind: 'internal', done: true },
            result: { status: 'ok', data: { posted: false } },
        };
    }
    if (intent.kind !== 'internal' || intent.intent !== 'triage_persona_reply') {
        return {
            action: { kind: 'internal', done: true },
            result: { status: 'error', error: { code: 'bad_intent', message: 'expected triage_persona_reply' } },
        };
    }
    if (ctx.agentId !== PERSONA_AGENT_ID) {
        return {
            action: { kind: 'internal', done: true },
            result: { status: 'error', error: { code: 'wrong_agent', message: 'persona agent id mismatch' } },
        };
    }
    if (!ctx.conversation) {
        return {
            action: { kind: 'internal', done: true },
            result: { status: 'error', error: { code: 'no_conversation', message: 'TaskContext.conversation is not bound' } },
        };
    }
    const work = (intent.data as { work: TriageWork }).work;
    const topic = { kind: 'topic' as const, id: work.topicId };
    const seat = memberId(work.recipientSeat);
    const key = seatToFixtureKey(String(seat));
    if (!key) {
        return {
            action: { kind: 'internal', done: true },
            result: { status: 'ok', data: { posted: false } },
        };
    }
    const parsed = TriageMessageBodySchema.safeParse(work.body);
    const phase = parsed.success ? parsed.data.phase : work.phase;

    if (phase === 'triage_initial_prompt') {
        const fixtures = fixtureInitialBySeat();
        const position = fixtures[key];
        const receipt = await ctx.conversation.post(
            topic,
            {
                senderAgentId: PERSONA_AGENT_ID,
                senderMemberId: seat,
                speechAct: 'answer',
                content: jsonEnvelope({ phase: 'triage_initial_position', position }),
            },
            { selector: { kind: 'broadcast' }, idempotencyKey: `triage-persona:${work.inboundMessageId}:${seat}:initial` }
        );
        if (receipt.status !== 'accepted') {
            return {
                action: { kind: 'internal', done: true },
                result: {
                    status: 'error',
                    error: { code: 'post_rejected', message: receipt.status === 'rejected' ? receipt.error.message : 'post failed' },
                },
            };
        }
        return {
            action: { kind: 'internal', done: true },
            result: { status: 'ok', data: { posted: true, preview: position.patientId } },
        };
    }

    if (phase === 'triage_critique') {
        let text = 'Краткий ответ на критику по роли.';
        if (key === 'fair') {
            text = fixtureCritiqueReplyRu.fairAfterDuty;
        } else if (key === 'util') {
            const o0 =
                parsed.success && parsed.data.phase === 'triage_critique'
                    ? parsed.data.critique.objections[0] ?? ''
                    : '';
            text = o0.includes('Публичная')
                ? fixtureCritiqueReplyRu.utilAfterPrag
                : fixtureCritiqueReplyRu.utilAfterFair;
        }
        const receipt = await ctx.conversation.post(
            topic,
            {
                senderAgentId: PERSONA_AGENT_ID,
                senderMemberId: seat,
                speechAct: 'answer',
                content: jsonEnvelope({
                    phase: 'triage_critique_reply',
                    replyRu: text,
                    referencesMessageIds: [work.inboundMessageId],
                }),
            },
            { selector: { kind: 'broadcast' }, idempotencyKey: `triage-persona:${work.inboundMessageId}:${seat}:crit-reply` }
        );
        if (receipt.status !== 'accepted') {
            return {
                action: { kind: 'internal', done: true },
                result: {
                    status: 'error',
                    error: { code: 'post_rejected', message: receipt.status === 'rejected' ? receipt.error.message : 'post failed' },
                },
            };
        }
        return {
            action: { kind: 'internal', done: true },
            result: { status: 'ok', data: { posted: true, preview: text.slice(0, 80) } },
        };
    }

    if (phase === 'triage_final_prompt') {
        const rev = fixtureRevisionBySeat({
            util: [work.inboundMessageId],
            fair: [work.inboundMessageId],
            duty: [work.inboundMessageId],
            prag: [work.inboundMessageId],
        });
        const revision = rev[key];
        const receipt = await ctx.conversation.post(
            topic,
            {
                senderAgentId: PERSONA_AGENT_ID,
                senderMemberId: seat,
                speechAct: 'inform',
                content: jsonEnvelope({ phase: 'triage_revision', revision }),
            },
            { selector: { kind: 'broadcast' }, idempotencyKey: `triage-persona:${work.inboundMessageId}:${seat}:revision` }
        );
        if (receipt.status !== 'accepted') {
            return {
                action: { kind: 'internal', done: true },
                result: {
                    status: 'error',
                    error: { code: 'post_rejected', message: receipt.status === 'rejected' ? receipt.error.message : 'post failed' },
                },
            };
        }
        return {
            action: { kind: 'internal', done: true },
            result: { status: 'ok', data: { posted: true, preview: revision.patientId } },
        };
    }

    return {
        action: { kind: 'internal', done: true },
        result: { status: 'ok', data: { posted: false } },
    };
}

function transition(): { kind: 'complete' } {
    return { kind: 'complete' };
}

export default createAgent<Sensory, Obs, unknown, ExecPayload, ExecError>(
    {
        attention,
        perception,
        learning,
        policy,
        shield,
        execution,
        transition,
        llmConfig: {
            provider: 'openai',
            modelAliasOrName: 'fast',
            systemPrompt: 'Persona seat for ICU triage panel; Russian JSON bodies only.',
            historyMode: 'stateless',
        },
    },
    import.meta.url
);
