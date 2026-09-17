import { describe, it, expect } from '@jest/globals';
import { createTestHarness } from '@a2arium/callagent-core';
import {
    ConversationService,
    InMemorySessionManager,
    SessionManager,
    createDbMessageLog,
} from '@a2arium/callagent-core/unstable';
import {
    registerEthicalTriageTopicProjection,
    MODERATOR_AGENT_ID,
    PERSONA_AGENT_ID,
    ethicalTriageTopicMembers,
    PARTICIPANT_ROUND_ROBIN_ORDER,
} from '../src/composition.js';
import { runEthicalTriageDeliberation } from '../src/deliberation-driver.js';
import { ethicalModeratorModules } from '../src/moderator-modules.js';

describe('@a2arium/ethical-triage-panel-agent', () => {
    const tenantId = 't-eth-triage';
    const sessionId = 'sess-eth';

    const createService = () => {
        const store = new InMemorySessionManager();
        const sessionManager = new SessionManager(store);
        const service = new ConversationService(sessionManager, {
            routeTargetForThread: ({ threadId, recipientAgentId: recipient }) => ({
                tenantId,
                sessionId: `${threadId}:${recipient}`,
                agentId: recipient,
            }),
            activateConversationRecipient: async () => ({ ok: true }),
            messageLog: createDbMessageLog(sessionManager),
            resolveThreadTtlMs: () => null,
        });
        return { service, sessionManager };
    };

    it('runs full deliberation: routing, projection, signal closure, post-close rejection', async () => {
        registerEthicalTriageTopicProjection();
        const { service, sessionManager } = createService();
        const topicId = 'topic-ethical-triage-test-1';
        const result = await runEthicalTriageDeliberation({
            service,
            tenantId,
            sessionId,
            topicId,
        });

        expect(result.projection.initialChoiceByMember['triage#utilitarian']).toBe('A');
        expect(result.projection.finalChoiceByMember['triage#duty']).toBe('D');
        expect(result.projection.changedMindCount).toBe(1);
        expect(result.projection.consensusCandidate).toBe('D');
        expect(result.projection.finalDecisionMessageId).toBeDefined();
        expect(result.projection.critiqueEdges.length).toBeGreaterThanOrEqual(3);
        expect(result.lastPostSummary).toBe('ConversationClosed');

        const topicRow = await sessionManager.getConversationTopic({
            tenantId,
            conversationId: topicId,
        });
        expect(topicRow?.status).toBe('closed');

        const created = await service.createTopic(tenantId, sessionId, MODERATOR_AGENT_ID, {
            topicId: 'topic-route-order',
            members: ethicalTriageTopicMembers,
            defaultSelector: { kind: 'round_robin' },
            stopPolicies: [{ kind: 'timeout', afterMs: 86_400_000 }],
        });
        expect(created.status).toBe('ok');
        if (created.status !== 'ok') {
            return;
        }
        const t2 = created.topic;
        const minimalBrief = {
            caseId: 'route-test',
            locale: 'ru' as const,
            hospitalContext: 'ctx',
            scarceResource: 'icu_bed' as const,
            patients: [{ id: 'A', age: 1, survivalProbability: 0.5, notes: ['n'] }],
            task: 't',
        };
        const br = await service.post(
            tenantId,
            sessionId,
            MODERATOR_AGENT_ID,
            t2,
            {
                senderAgentId: MODERATOR_AGENT_ID,
                senderMemberId: 'triage#moderator',
                speechAct: 'inform',
                content: { mimeType: 'application/json' as const, body: { phase: 'triage_case_brief', brief: minimalBrief } },
            },
            { selector: { kind: 'broadcast' } }
        );
        expect(br.status).toBe('accepted');
        if (br.status === 'accepted') {
            const got = new Set(br.deliveries.map((d) => String(d.memberId)));
            for (const seat of PARTICIPANT_ROUND_ROBIN_ORDER) {
                expect(got.has(String(seat))).toBe(true);
            }
            expect(got.has('triage#moderator')).toBe(false);
        }

        const rrHits: string[] = [];
        for (let i = 0; i < 4; i++) {
            const rr = await service.post(
                tenantId,
                sessionId,
                MODERATOR_AGENT_ID,
                t2,
                {
                    senderAgentId: MODERATOR_AGENT_ID,
                    senderMemberId: 'triage#moderator',
                    speechAct: 'inform',
                    content: { n: i },
                },
                { selector: { kind: 'round_robin' } }
            );
            expect(rr.status).toBe('accepted');
            if (rr.status === 'accepted') {
                rrHits.push(String(rr.deliveries[0]!.memberId));
            }
        }
        expect(rrHits).toEqual([
            String(PARTICIPANT_ROUND_ROBIN_ORDER[0]),
            String(PARTICIPANT_ROUND_ROBIN_ORDER[1]),
            String(PARTICIPANT_ROUND_ROBIN_ORDER[2]),
            String(PARTICIPANT_ROUND_ROBIN_ORDER[3]),
        ]);

        const ex = await service.post(
            tenantId,
            sessionId,
            PERSONA_AGENT_ID,
            t2,
            {
                senderAgentId: PERSONA_AGENT_ID,
                senderMemberId: 'triage#fairness',
                speechAct: 'inform',
                content: { direct: true },
            },
            {
                selector: { kind: 'explicit_recipient', recipient: { by: 'memberId', memberId: 'triage#utilitarian' } },
            }
        );
        expect(ex.status).toBe('accepted');
        if (ex.status === 'accepted') {
            expect(ex.deliveries.map((d) => String(d.memberId))).toEqual(['triage#utilitarian']);
        }

        const bad = await service.post(
            tenantId,
            sessionId,
            PERSONA_AGENT_ID,
            t2,
            {
                senderAgentId: PERSONA_AGENT_ID,
                senderMemberId: 'triage#fairness',
                speechAct: 'inform',
                content: {},
            },
            { selector: { kind: 'explicit_recipient', recipient: { by: 'agentId', agentId: PERSONA_AGENT_ID } } }
        );
        expect(bad.status).toBe('rejected');
        if (bad.status === 'rejected') {
            expect(bad.error.type).toBe('RecipientAmbiguous');
        }
    });

    it('moderator harness completes bundled deliberation (uses in-memory ConversationService, not ctx.conversation)', async () => {
        registerEthicalTriageTopicProjection();
        const harness = createTestHarness(ethicalModeratorModules, { maxTurns: 5 });
        harness.injectUserInput({ runTriage: true });
        await harness.runTurn();
        harness.expectComplete();
        const last = harness.lastTrace();
        expect(last.execResult?.status).toBe('ok');
        const data = last.execResult?.data as { transcriptPath?: string } | undefined;
        expect(typeof data?.transcriptPath).toBe('string');
        expect(data?.transcriptPath?.length).toBeGreaterThan(0);
    });
});
