import { createTestHarness } from '@a2arium/callagent-core';
import { attention } from '../attention.js';
import { perception } from '../perception.js';
import { learning } from '../learning.js';
import { policy } from '../policy.js';
import { shield } from '../shield.js';
import { execution } from '../execution.js';
import { transition } from '../transition.js';

describe('@a2arium/hello-agent — golden path', () => {
    it('completes after user input', async () => {
        const harness = createTestHarness({
            attention,
            perception,
            learning,
            policy,
            shield,
            execution,
            transition,
        });

        harness.injectUserInput({ text: 'hello' });
        await harness.runTurn();

        const trace = harness.lastTrace();
        expect(trace.transition?.kind).toBe('complete');
        expect(trace.conversation).toBeUndefined();
    });
});
