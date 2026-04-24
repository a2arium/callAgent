import type { FanoutSendReceipt, DeliverySummary } from '@a2arium/callagent-core';
import type { ConversationService } from '@a2arium/callagent-core/unstable';
import {
    MODERATOR_AGENT_ID,
    MODERATOR_SEAT,
    PERSONA_AGENT_ID,
    SEAT_DUTY,
    SEAT_FAIRNESS,
    SEAT_PRAGMATIST,
    SEAT_UTILITARIAN,
    ethicalTriageStopPolicies,
    ethicalTriageTopicMembers,
} from './composition.js';
import { triagePanelProjectionToken, type TriagePanelState } from './projection.js';
import {
    defaultTriageCaseBrief,
    finalPromptRu,
    fixtureCritiqueDutyToFair,
    fixtureCritiqueFairToUtil,
    fixtureCritiquePragToUtil,
    fixtureCritiqueReplyRu,
    fixtureFinalDecision,
    fixtureInitialBySeat,
    fixtureRevisionBySeat,
    initialPromptRu,
    moderatorFinalSummaryRu,
    synthesisPreambleRu,
} from './test-fixtures.js';
import { formatTranscriptProse, formatTriageMessageBodyLines } from './transcript-content.js';
import { jsonEnvelope, type TriageMessageBody } from './types.js';

const TRANSCRIPT_PAYLOAD_MARKER = '── In-topic message (payload) ──';

export type TranscriptSink = {
    /** Append a titled block; each string is one line (already formatted). */
    appendBlock(title: string, lines: string[]): void;
};

function mustMessageId(receipt: FanoutSendReceipt): string {
    if (receipt.status !== 'accepted' || receipt.deliveries.length === 0) {
        throw new Error('expected accepted topic post with deliveries');
    }
    return receipt.deliveries[0]!.messageId;
}

function summarizeReceipt(receipt: FanoutSendReceipt): string {
    if (receipt.status === 'rejected') {
        return `rejected: ${receipt.error.type}`;
    }
    if (receipt.status === 'queued') {
        return `queued: position ${receipt.queuePosition}`;
    }
    const n = receipt.status === 'accepted' ? receipt.deliveries.length : receipt.accepted.length;
    const sp = receipt.stopPolicyTrace
        ? ` stopPolicy=${receipt.stopPolicyTrace.result}`
        : '';
    return `accepted deliveries=${n}${sp}`;
}

export type DeliberationRunResult = {
    topicId: string;
    topic: { kind: 'topic'; id: string };
    projection: TriagePanelState;
    lastPostSummary: string;
    signalReceiptSummary: string;
};

export async function runEthicalTriageDeliberation(input: {
    service: ConversationService;
    tenantId: string;
    sessionId: string;
    topicId: string;
    transcript?: TranscriptSink;
}): Promise<DeliberationRunResult> {
    const { service, tenantId, sessionId, topicId } = input;
    const tr = input.transcript;
    const topic = { kind: 'topic' as const, id: topicId };

    const log = (title: string, lines: string[]) => {
        tr?.appendBlock(title, lines);
    };

    const created = await service.createTopic(tenantId, sessionId, MODERATOR_AGENT_ID, {
        topicId,
        members: ethicalTriageTopicMembers,
        defaultSelector: { kind: 'round_robin' },
        stopPolicies: ethicalTriageStopPolicies,
    });
    if (created.status !== 'ok') {
        throw new Error(`createTopic failed: ${created.status === 'rejected' ? created.error.message : 'unknown'}`);
    }
    log('Phase 1 — Topic created', [
        `topicId=${topicId}`,
        `members=${ethicalTriageTopicMembers.map((m) => `${m.memberId}→${m.agentId}`).join('; ')}`,
        `defaultSelector=round_robin`,
    ]);

    const caseBriefBody: TriageMessageBody = {
        phase: 'triage_case_brief',
        brief: defaultTriageCaseBrief,
    };
    const briefReceipt = await service.post(
        tenantId,
        sessionId,
        MODERATOR_AGENT_ID,
        topic,
        {
            senderAgentId: MODERATOR_AGENT_ID,
            senderMemberId: MODERATOR_SEAT,
            speechAct: 'inform',
            content: jsonEnvelope(caseBriefBody),
        },
        { selector: { kind: 'broadcast' }, idempotencyKey: `triage:${topicId}:case-brief` }
    );
    if (briefReceipt.status !== 'accepted') {
        throw new Error(`case brief failed: ${briefReceipt.status}`);
    }
    log('Phase 2 — Case brief (broadcast)', [
        `selector=broadcast`,
        `deliveries=${briefReceipt.deliveries.map((d: DeliverySummary) => d.recipientAgentId).join(', ')}`,
        `brief.caseId=${defaultTriageCaseBrief.caseId}`,
        summarizeReceipt(briefReceipt),
        '',
        TRANSCRIPT_PAYLOAD_MARKER,
        ...formatTriageMessageBodyLines(caseBriefBody),
    ]);

    const initialPromptBody: TriageMessageBody = {
        phase: 'triage_initial_prompt',
        promptRu: initialPromptRu,
    };
    for (let i = 0; i < 4; i++) {
        const rr = await service.post(
            tenantId,
            sessionId,
            MODERATOR_AGENT_ID,
            topic,
            {
                senderAgentId: MODERATOR_AGENT_ID,
                senderMemberId: MODERATOR_SEAT,
                speechAct: 'question',
                content: jsonEnvelope(initialPromptBody),
            },
            { selector: { kind: 'round_robin' }, idempotencyKey: `triage:${topicId}:initial-prompt:${i}` }
        );
        if (rr.status !== 'accepted') {
            throw new Error(`initial round_robin prompt ${i} failed`);
        }
        log(`Phase 3 — Initial prompt (round_robin #${i + 1})`, [
            `to=${rr.deliveries.map((d: DeliverySummary) => String(d.memberId)).join(',')}`,
            summarizeReceipt(rr),
            '',
            TRANSCRIPT_PAYLOAD_MARKER,
            ...formatTriageMessageBodyLines(initialPromptBody),
        ]);
    }

    const fixtures = fixtureInitialBySeat();

    type SeatKey = typeof SEAT_UTILITARIAN | typeof SEAT_FAIRNESS | typeof SEAT_DUTY | typeof SEAT_PRAGMATIST;
    const postInitial = async (seat: SeatKey, position: (typeof fixtures)['util']) => {
        const positionBody: TriageMessageBody = { phase: 'triage_initial_position', position };
        const r = await service.post(
            tenantId,
            sessionId,
            PERSONA_AGENT_ID,
            topic,
            {
                senderAgentId: PERSONA_AGENT_ID,
                senderMemberId: seat,
                speechAct: 'answer',
                content: jsonEnvelope(positionBody),
            },
            { selector: { kind: 'broadcast' }, idempotencyKey: `triage:${topicId}:initial:${seat}` }
        );
        const mid = mustMessageId(r);
        log(`Phase 3 — Initial position (${seat})`, [
            `messageId=${mid}`,
            `patientId=${position.patientId}`,
            '',
            TRANSCRIPT_PAYLOAD_MARKER,
            ...formatTriageMessageBodyLines(positionBody),
        ]);
        return mid;
    };

    const idUtil = await postInitial(SEAT_UTILITARIAN, fixtures.util);
    const idFair = await postInitial(SEAT_FAIRNESS, fixtures.fair);
    const idDuty = await postInitial(SEAT_DUTY, fixtures.duty);
    const idPrag = await postInitial(SEAT_PRAGMATIST, fixtures.prag);

    const projMid = await service.readProjection(tenantId, sessionId, MODERATOR_AGENT_ID, topic, triagePanelProjectionToken);
    if (projMid.status !== 'ok') {
        throw new Error('readProjection failed mid-deliberation');
    }
    const midState = projMid.state as TriagePanelState;
    log('Projection (after initial positions)', [
        `initialChoiceByMember=${JSON.stringify(midState.initialChoiceByMember)}`,
        `consensusCandidate=${midState.consensusCandidate ?? 'n/a'}`,
    ]);

    const critFU = fixtureCritiqueFairToUtil(idUtil);
    const critFuBody: TriageMessageBody = { phase: 'triage_critique', critique: critFU };
    const rFairCrit = await service.post(
        tenantId,
        sessionId,
        PERSONA_AGENT_ID,
        topic,
        {
            senderAgentId: PERSONA_AGENT_ID,
            senderMemberId: SEAT_FAIRNESS,
            speechAct: 'followup',
            content: jsonEnvelope(critFuBody),
        },
        {
            selector: { kind: 'explicit_recipient', recipient: { by: 'memberId', memberId: SEAT_UTILITARIAN } },
            idempotencyKey: `triage:${topicId}:crit:fair→util`,
        }
    );
    mustMessageId(rFairCrit);
    log('Phase 4 — Critique fairness → utilitarian (explicit_recipient)', [
        `to=triage#utilitarian`,
        summarizeReceipt(rFairCrit),
        '',
        TRANSCRIPT_PAYLOAD_MARKER,
        ...formatTriageMessageBodyLines(critFuBody),
    ]);

    const utilReplyFairBody: TriageMessageBody = {
        phase: 'triage_critique_reply',
        replyRu: fixtureCritiqueReplyRu.utilAfterFair,
        referencesMessageIds: [mustMessageId(rFairCrit)],
    };
    const rUtilReply1 = await service.post(
        tenantId,
        sessionId,
        PERSONA_AGENT_ID,
        topic,
        {
            senderAgentId: PERSONA_AGENT_ID,
            senderMemberId: SEAT_UTILITARIAN,
            speechAct: 'answer',
            content: jsonEnvelope(utilReplyFairBody),
        },
        { selector: { kind: 'broadcast' }, idempotencyKey: `triage:${topicId}:reply:util:1` }
    );
    mustMessageId(rUtilReply1);
    log('Phase 4 — Reply utilitarian → fairness critique (broadcast)', [
        `references=${utilReplyFairBody.referencesMessageIds.join(', ')}`,
        '',
        TRANSCRIPT_PAYLOAD_MARKER,
        ...formatTriageMessageBodyLines(utilReplyFairBody),
    ]);

    const critDF = fixtureCritiqueDutyToFair(idFair);
    const critDfBody: TriageMessageBody = { phase: 'triage_critique', critique: critDF };
    const rDutyCrit = await service.post(
        tenantId,
        sessionId,
        PERSONA_AGENT_ID,
        topic,
        {
            senderAgentId: PERSONA_AGENT_ID,
            senderMemberId: SEAT_DUTY,
            speechAct: 'followup',
            content: jsonEnvelope(critDfBody),
        },
        {
            selector: { kind: 'explicit_recipient', recipient: { by: 'memberId', memberId: SEAT_FAIRNESS } },
            idempotencyKey: `triage:${topicId}:crit:duty→fair`,
        }
    );
    mustMessageId(rDutyCrit);
    log('Phase 4 — Critique duty → fairness (explicit_recipient)', [
        summarizeReceipt(rDutyCrit),
        '',
        TRANSCRIPT_PAYLOAD_MARKER,
        ...formatTriageMessageBodyLines(critDfBody),
    ]);

    const fairReplyBody: TriageMessageBody = {
        phase: 'triage_critique_reply',
        replyRu: fixtureCritiqueReplyRu.fairAfterDuty,
        referencesMessageIds: [mustMessageId(rDutyCrit)],
    };
    const rFairReply = await service.post(
        tenantId,
        sessionId,
        PERSONA_AGENT_ID,
        topic,
        {
            senderAgentId: PERSONA_AGENT_ID,
            senderMemberId: SEAT_FAIRNESS,
            speechAct: 'answer',
            content: jsonEnvelope(fairReplyBody),
        },
        { selector: { kind: 'broadcast' }, idempotencyKey: `triage:${topicId}:reply:fair` }
    );
    mustMessageId(rFairReply);
    log('Phase 4 — Reply fairness → duty critique (broadcast)', [
        `references=${fairReplyBody.referencesMessageIds.join(', ')}`,
        '',
        TRANSCRIPT_PAYLOAD_MARKER,
        ...formatTriageMessageBodyLines(fairReplyBody),
    ]);

    const critPU = fixtureCritiquePragToUtil(idUtil);
    const critPuBody: TriageMessageBody = { phase: 'triage_critique', critique: critPU };
    const rPragCrit = await service.post(
        tenantId,
        sessionId,
        PERSONA_AGENT_ID,
        topic,
        {
            senderAgentId: PERSONA_AGENT_ID,
            senderMemberId: SEAT_PRAGMATIST,
            speechAct: 'followup',
            content: jsonEnvelope(critPuBody),
        },
        {
            selector: { kind: 'explicit_recipient', recipient: { by: 'memberId', memberId: SEAT_UTILITARIAN } },
            idempotencyKey: `triage:${topicId}:crit:prag→util`,
        }
    );
    mustMessageId(rPragCrit);
    log('Phase 4 — Critique pragmatist → utilitarian (explicit_recipient)', [
        summarizeReceipt(rPragCrit),
        '',
        TRANSCRIPT_PAYLOAD_MARKER,
        ...formatTriageMessageBodyLines(critPuBody),
    ]);

    const utilReplyPragBody: TriageMessageBody = {
        phase: 'triage_critique_reply',
        replyRu: fixtureCritiqueReplyRu.utilAfterPrag,
        referencesMessageIds: [mustMessageId(rPragCrit)],
    };
    const rUtilReply2 = await service.post(
        tenantId,
        sessionId,
        PERSONA_AGENT_ID,
        topic,
        {
            senderAgentId: PERSONA_AGENT_ID,
            senderMemberId: SEAT_UTILITARIAN,
            speechAct: 'answer',
            content: jsonEnvelope(utilReplyPragBody),
        },
        { selector: { kind: 'broadcast' }, idempotencyKey: `triage:${topicId}:reply:util:2` }
    );
    mustMessageId(rUtilReply2);
    log('Phase 4 — Reply utilitarian → pragmatist critique (broadcast)', [
        `references=${utilReplyPragBody.referencesMessageIds.join(', ')}`,
        '',
        TRANSCRIPT_PAYLOAD_MARKER,
        ...formatTriageMessageBodyLines(utilReplyPragBody),
    ]);

    const preSynth = await service.readProjection(tenantId, sessionId, MODERATOR_AGENT_ID, topic, triagePanelProjectionToken);
    if (preSynth.status !== 'ok') {
        throw new Error('readProjection failed before synthesis');
    }
    const preState = preSynth.state as TriagePanelState;
    const synthText = synthesisPreambleRu({
        initial: preState.initialChoiceByMember,
        finalSoFar: preState.finalChoiceByMember,
        consensus: preState.consensusCandidate,
    });

    const synthesisBody: TriageMessageBody = {
        phase: 'triage_synthesis',
        summaryRu: synthText,
        asksFinalRevision: true,
    };
    const synReceipt = await service.post(
        tenantId,
        sessionId,
        MODERATOR_AGENT_ID,
        topic,
        {
            senderAgentId: MODERATOR_AGENT_ID,
            senderMemberId: MODERATOR_SEAT,
            speechAct: 'inform',
            content: jsonEnvelope(synthesisBody),
        },
        { selector: { kind: 'broadcast' }, idempotencyKey: `triage:${topicId}:synthesis` }
    );
    mustMessageId(synReceipt);
    log('Phase 5 — Synthesis (broadcast)', [
        summarizeReceipt(synReceipt),
        '',
        TRANSCRIPT_PAYLOAD_MARKER,
        ...formatTriageMessageBodyLines(synthesisBody),
    ]);

    const finalPromptBody: TriageMessageBody = {
        phase: 'triage_final_prompt',
        promptRu: finalPromptRu,
    };
    for (let i = 0; i < 4; i++) {
        const fr = await service.post(
            tenantId,
            sessionId,
            MODERATOR_AGENT_ID,
            topic,
            {
                senderAgentId: MODERATOR_AGENT_ID,
                senderMemberId: MODERATOR_SEAT,
                speechAct: 'question',
                content: jsonEnvelope(finalPromptBody),
            },
            { selector: { kind: 'round_robin' }, idempotencyKey: `triage:${topicId}:final-prompt:${i}` }
        );
        mustMessageId(fr);
        log(`Phase 5 — Final prompt (round_robin #${i + 1})`, [
            summarizeReceipt(fr),
            '',
            TRANSCRIPT_PAYLOAD_MARKER,
            ...formatTriageMessageBodyLines(finalPromptBody),
        ]);
    }

    const rev = fixtureRevisionBySeat({
        util: [idUtil, mustMessageId(rFairCrit)],
        fair: [idFair, mustMessageId(rDutyCrit)],
        duty: [idDuty, mustMessageId(synReceipt)],
        prag: [idPrag, mustMessageId(rPragCrit)],
    });

    const postRev = async (seat: SeatKey, revision: (typeof rev)['util']) => {
        const revisionBody: TriageMessageBody = { phase: 'triage_revision', revision };
        const r = await service.post(
            tenantId,
            sessionId,
            PERSONA_AGENT_ID,
            topic,
            {
                senderAgentId: PERSONA_AGENT_ID,
                senderMemberId: seat,
                speechAct: 'inform',
                content: jsonEnvelope(revisionBody),
            },
            { selector: { kind: 'broadcast' }, idempotencyKey: `triage:${topicId}:revision:${seat}` }
        );
        mustMessageId(r);
        log(`Phase 5 — Revision (${seat})`, [
            `changedMind=${revision.changedMind}`,
            `patientId=${revision.patientId}`,
            '',
            TRANSCRIPT_PAYLOAD_MARKER,
            ...formatTriageMessageBodyLines(revisionBody),
        ]);
    };

    await postRev(SEAT_UTILITARIAN, rev.util);
    await postRev(SEAT_FAIRNESS, rev.fair);
    await postRev(SEAT_DUTY, rev.duty);
    await postRev(SEAT_PRAGMATIST, rev.prag);

    const finalDecisionBody: TriageMessageBody = {
        phase: 'triage_final_decision',
        decision: fixtureFinalDecision,
    };
    const decReceipt = await service.post(
        tenantId,
        sessionId,
        MODERATOR_AGENT_ID,
        topic,
        {
            senderAgentId: MODERATOR_AGENT_ID,
            senderMemberId: MODERATOR_SEAT,
            speechAct: 'inform',
            content: jsonEnvelope(finalDecisionBody),
        },
        { selector: { kind: 'broadcast' }, idempotencyKey: `triage:${topicId}:final-decision` }
    );
    const decisionId = mustMessageId(decReceipt);
    log('Phase 6 — Final decision (broadcast)', [
        `decisionMessageId=${decisionId}`,
        summarizeReceipt(decReceipt),
        '',
        TRANSCRIPT_PAYLOAD_MARKER,
        ...formatTriageMessageBodyLines(finalDecisionBody),
        '',
        '── Moderator closing narration (Russian, log line only) ──',
        ...formatTranscriptProse(moderatorFinalSummaryRu),
    ]);

    const projFinal = await service.readProjection(tenantId, sessionId, MODERATOR_AGENT_ID, topic, triagePanelProjectionToken);
    if (projFinal.status !== 'ok') {
        throw new Error(
            `readProjection failed before closure signal: ${projFinal.status === 'rejected' ? projFinal.error.type : 'unknown'}`
        );
    }

    const sig = await service.appendSignal(
        tenantId,
        sessionId,
        MODERATOR_AGENT_ID,
        topic,
        {
            signalType: 'x-triage.decision-finalized',
            payload: { caseId: defaultTriageCaseBrief.caseId },
            senderMemberId: MODERATOR_SEAT,
        },
        { selector: { kind: 'broadcast' }, idempotencyKey: `triage:${topicId}:finalize-signal` }
    );
    const sigSummary = summarizeReceipt(sig);

    const afterCloseBody: TriageMessageBody = {
        phase: 'triage_final_prompt',
        promptRu: 'не должно доставиться',
    };
    const closedPost = await service.post(
        tenantId,
        sessionId,
        MODERATOR_AGENT_ID,
        topic,
        {
            senderAgentId: MODERATOR_AGENT_ID,
            senderMemberId: MODERATOR_SEAT,
            speechAct: 'inform',
            content: jsonEnvelope(afterCloseBody),
        },
        { selector: { kind: 'broadcast' }, idempotencyKey: `triage:${topicId}:after-close` }
    );

    log('Phase 6 — Closure', [
        `appendSignal=${sigSummary}`,
        `postAfterClose=${closedPost.status === 'rejected' ? closedPost.error.type : 'unexpected-accept'}`,
        '',
        '── Post-after-close (payload text; normally rejected once topic is closed) ──',
        ...formatTriageMessageBodyLines(afterCloseBody),
    ]);

    return {
        topicId,
        topic,
        projection: projFinal.state as TriagePanelState,
        lastPostSummary: closedPost.status === 'rejected' ? closedPost.error.type : 'accepted',
        signalReceiptSummary: sigSummary,
    };
}
