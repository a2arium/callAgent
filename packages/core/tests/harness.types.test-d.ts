import { expectType, expectError } from 'tsd';
import { createTestHarness, type HarnessSnapshot, type TestHarness } from '../src/testing/TestHarness.js';
import type { Snapshot } from '../src/loop/types.js';

declare const harness: TestHarness;
expectType<HarnessSnapshot>(harness.snapshot());
expectType<TestHarness>(harness.fork(harness.snapshot()));

declare const snap: HarnessSnapshot;
declare function takeProductionSnapshot(s: Snapshot): void;
expectError(takeProductionSnapshot(snap));

void createTestHarness;
