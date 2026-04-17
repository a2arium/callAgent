import { createTestHarness } from '@a2arium/callagent-core';
import { attention } from '../attention.js';
import { perception } from '../perception.js';
import { learning } from '../learning.js';
import { policy } from '../policy.js';
import { shield } from '../shield.js';
import { execution } from '../execution.js';
import { transition } from '../transition.js';
import { DEMO_TOPIC_PHASE2_ID } from '../types.js';

describe('@a2arium/conversation-reference-agent — Phase 2 demo', () => {
    it('runs phase2 (topic selectors + invite token) then phase2-close using policy projection', async () => {
        const harness = createTestHarness({
            attention,
            perception,
            learning,
            policy,
            shield,
            execution,
            transition,
        });

        harness.injectUserInput({ text: 'phase2' });
        await harness.runTurn();

        const t1 = harness.lastTrace();
        expect(t1.transition?.kind).toBe('complete');
        const r1 = t1.transition?.result as {
            phase2DemoComplete?: boolean;
            inviteToken?: string;
            topicId?: string;
            ownerSeatMemberIds?: string[];
            senderMemberIdUsed?: string;
        };
        expect(r1?.phase2DemoComplete).toBe(true);
        expect(r1?.topicId).toBe(DEMO_TOPIC_PHASE2_ID);
        expect(typeof r1?.inviteToken).toBe('string');
        expect((r1?.inviteToken ?? '').length).toBeGreaterThan(4);
        expect(r1?.ownerSeatMemberIds).toEqual([
            'conversation-reference-agent#owner',
            'conversation-reference-agent#participant',
        ]);
        expect(r1?.senderMemberIdUsed).toBe('conversation-reference-agent#owner');

        harness.injectUserInput({ text: 'phase2-close' });
        await harness.runTurn();

        const t2 = harness.lastTrace();
        expect(t2.transition?.kind).toBe('complete');
        const r2 = t2.transition?.result as { phase2CloseComplete?: boolean; topicId?: string };
        expect(r2?.phase2CloseComplete).toBe(true);
        expect(r2?.topicId).toBe(DEMO_TOPIC_PHASE2_ID);
    });
});
