import { createTestHarness } from '@a2arium/callagent-core';
import { attention } from '../attention.js';
import { perception } from '../perception.js';
import { learning } from '../learning.js';
import { policy } from '../policy.js';
import { shield } from '../shield.js';
import { execution } from '../execution.js';
import { transition } from '../transition.js';

describe('@a2arium/flow-reference-agent — resume', () => {
    it('awaits input on empty turn and resumes to complete', async () => {
        const harness = createTestHarness({
            attention,
            perception,
            learning,
            policy,
            shield,
            execution,
            transition,
        });
        await harness.runTurn();
        const t1 = harness.lastTrace();
        expect(t1.transition?.kind).toBe('await_input');
        expect(t1.conversation).toBeUndefined();

        harness.injectUserInput({ text: 'resume me' });
        await harness.runTurn();
        const t2 = harness.lastTrace();
        expect(t2.transition?.kind).toBe('complete');
        expect(t2.conversation).toBeUndefined();
    });
});
