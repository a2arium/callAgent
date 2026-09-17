import { createTestHarness } from '@a2arium/callagent-core';
import { attention } from '../attention.js';
import { perception } from '../perception.js';
import { learning } from '../learning.js';
import { policy } from '../policy.js';
import { shield } from '../shield.js';
import { execution } from '../execution.js';
import { transition } from '../transition.js';

describe('@a2arium/conversation-reference-agent — golden', () => {
    it('opens a thread, hydrates delivery, follow-up send dedupes deterministically', async () => {
        const harness = createTestHarness({
            attention,
            perception,
            learning,
            policy,
            shield,
            execution,
            transition,
        });

        harness.injectUserInput({ text: 'go' });
        await harness.runTurn();

        const t1 = harness.lastTrace();
        expect(t1.transition?.kind).toBe('continue');
        expect(t1.conversation?.id).toBe('thread-conv-ref-1');
        expect(t1.conversation?.kind).toBe('thread');
        expect(t1.outgoingMessages?.length).toBeGreaterThanOrEqual(1);
        expect(t1.dedupeHit).not.toBe(true);

        await harness.runTurn();

        const t2 = harness.lastTrace();
        expect(t2.transition?.kind).toBe('complete');
        expect(t2.conversation?.id).toBe('thread-conv-ref-1');
        expect(t2.outgoingMessages?.length).toBeGreaterThanOrEqual(2);
        expect(t2.dedupeHit).toBe(true);
        expect(t2.transition?.result).toEqual(
            expect.objectContaining({
                lastDedupeHit: true,
                threadId: 'thread-conv-ref-1',
                followUpFirstMessageId: expect.any(String),
                followUpReplayMessageId: expect.any(String),
            })
        );
        expect((t2.transition?.result as { exchangeWitness?: { dedupeReplayHit?: boolean } })?.exchangeWitness).toEqual(
            expect.objectContaining({ dedupeReplayHit: true })
        );
    });
});
