import { z } from 'zod';
import type { MessageLogRecord } from '@a2arium/callagent-core';
import { defineTopicProjection } from '@a2arium/callagent-core';
import {
    TriageMessageBodySchema,
    type TriageMessageBody,
} from './types.js';

export const TriagePanelStateSchema = z
    .object({
        initialChoiceByMember: z.record(z.string(), z.string()),
        finalChoiceByMember: z.record(z.string(), z.string()),
        latestConfidenceByMember: z.record(z.string(), z.number()),
        changedMindCount: z.number().int().nonnegative(),
        critiqueEdges: z.array(
            z
                .object({
                    fromMemberId: z.string(),
                    toMemberId: z.string(),
                    targetMessageId: z.string(),
                })
                .strict()
        ),
        consensusCandidate: z.string().optional(),
        finalDecisionMessageId: z.string().optional(),
    })
    .strict();

export type TriagePanelState = z.infer<typeof TriagePanelStateSchema>;

export const triagePanelProjectionName = 'x-triage.panel-state' as const;

function unwrapTopicContent(record: MessageLogRecord): unknown {
    const p = record.payload;
    if (!p || typeof p !== 'object' || !('content' in p)) {
        return undefined;
    }
    const c = (p as { content: unknown }).content;
    if (c && typeof c === 'object' && c !== null && 'mimeType' in c && 'body' in c) {
        return (c as { body: unknown }).body;
    }
    return c;
}

function parseBody(raw: unknown): TriageMessageBody | undefined {
    const parsed = TriageMessageBodySchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
}

function majorityCandidate(choices: Record<string, string>): string | undefined {
    const vals = Object.values(choices);
    if (vals.length === 0) {
        return undefined;
    }
    const counts = new Map<string, number>();
    for (const v of vals) {
        counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const half = vals.length / 2;
    let best: string | undefined;
    let bestN = 0;
    for (const [k, n] of counts) {
        if (n > bestN) {
            bestN = n;
            best = k;
        }
    }
    return bestN > half ? best : undefined;
}

function recomputeConsensus(state: TriagePanelState): TriagePanelState {
    const fromFinal = state.finalChoiceByMember;
    const keys = Object.keys(fromFinal);
    const candidate = keys.length >= 2 ? majorityCandidate(fromFinal) : undefined;
    return { ...state, consensusCandidate: candidate };
}

function recomputeMindChanges(state: TriagePanelState): TriagePanelState {
    let n = 0;
    for (const [member, initial] of Object.entries(state.initialChoiceByMember)) {
        const fin = state.finalChoiceByMember[member];
        if (fin !== undefined && fin !== initial) {
            n += 1;
        }
    }
    return { ...state, changedMindCount: n };
}

const initialTriagePanelState = (): TriagePanelState => ({
    initialChoiceByMember: {},
    finalChoiceByMember: {},
    latestConfidenceByMember: {},
    changedMindCount: 0,
    critiqueEdges: [],
    consensusCandidate: undefined,
    finalDecisionMessageId: undefined,
});

export const triagePanelProjection = defineTopicProjection({
    projectionName: triagePanelProjectionName,
    stateSchema: TriagePanelStateSchema,
    initial: initialTriagePanelState,
    reduce: (state: TriagePanelState, record: MessageLogRecord) => {
        if (record.speechAct === 'signal') {
            return state;
        }
        const raw = unwrapTopicContent(record);
        const body = parseBody(raw);
        if (!body) {
            return state;
        }
        const sender = String(record.senderMemberId);
        let next = { ...state, critiqueEdges: [...state.critiqueEdges] };
        if (body.phase === 'triage_initial_position') {
            const p = body.position;
            next.initialChoiceByMember = { ...next.initialChoiceByMember, [sender]: p.patientId };
            next.latestConfidenceByMember = { ...next.latestConfidenceByMember, [sender]: p.confidence };
            next = recomputeConsensus(next);
        }
        if (body.phase === 'triage_critique') {
            const c = body.critique;
            next.critiqueEdges.push({
                fromMemberId: sender,
                toMemberId: c.targetMemberId,
                targetMessageId: c.targetPositionMessageId,
            });
        }
        if (body.phase === 'triage_revision') {
            const r = body.revision;
            next.finalChoiceByMember = { ...next.finalChoiceByMember, [sender]: r.patientId };
            next.latestConfidenceByMember = { ...next.latestConfidenceByMember, [sender]: r.confidence };
            next = recomputeMindChanges(next);
            next = recomputeConsensus(next);
        }
        if (body.phase === 'triage_final_decision') {
            next = { ...next, finalDecisionMessageId: record.messageId };
        }
        return next;
    },
});

export const triagePanelProjectionToken = triagePanelProjection.token;
