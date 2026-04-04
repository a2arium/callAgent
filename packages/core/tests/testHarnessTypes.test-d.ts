import { expectType, expectError } from 'tsd';
import type { TestHarness } from '../src/testing/TestHarness.js';
import type { TurnAssertionContext } from '../src/testing/harnessTypes.js';

declare const h: TestHarness;

h.expectTurn(t => {
    // Valid unions - should compile seamlessly
    expectType<TurnAssertionContext>(t.expectShield('pass'));
    expectType<TurnAssertionContext>(t.expectShield('veto'));
    expectType<TurnAssertionContext>(t.expectTransition('continue'));
    expectType<TurnAssertionContext>(t.expectTransition('await_tool'));
    expectType<TurnAssertionContext>(t.expectTransition('complete'));
    expectType<TurnAssertionContext>(t.expectTransition('fail'));

    // Should allow string matching for intent definitions
    expectType<TurnAssertionContext>(t.expectIntent('prompt_user'));
});

// @ts-expect-error — invalid shield action
h.expectTurn(t => t.expectShield('unknown_shield_action'));

// @ts-expect-error — invalid transition kind
h.expectTurn(t => t.expectTransition('invalid_transition'));

// Chaining
expectType<TestHarness>(h.seedMentalState({}));
expectType<TestHarness>(h.injectUserInput('hello'));
expectType<Promise<TestHarness>>(h.runTurn());
