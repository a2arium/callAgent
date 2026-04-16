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
        expect(harness.lastTrace().transition?.kind).toBe('await_input');

        harness.injectUserInput({ text: 'resume me' });
        await harness.runTurn();
        expect(harness.lastTrace().transition?.kind).toBe('complete');
    });
});
