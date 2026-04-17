import { createTestHarness } from '@a2arium/callagent-core';
import { attention } from '../attention.js';
import { perception } from '../perception.js';
import { learning } from '../learning.js';
import { policy } from '../policy.js';
import { shield } from '../shield.js';
import { execution } from '../execution.js';
import { transition } from '../transition.js';
describe('@a2arium/conversation-reference-agent — Phase 3 thread close + archive', () => {
    it('opens a thread then closes with archiveAfter (execution witness)', async () => {
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

        harness.injectUserInput({ text: 'phase3-archive' });
        await harness.runTurn();

        const t1 = harness.lastTrace();
        expect(t1.transition?.kind).toBe('complete');
        expect((t1.transition?.result as { phase3ArchiveComplete?: boolean })?.phase3ArchiveComplete).toBe(true);
    });
});
