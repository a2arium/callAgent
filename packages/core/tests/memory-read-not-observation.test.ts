import { describe, expect, it } from '@jest/globals';
import { createTestHarness } from '../src/testing/TestHarness.js';
import type { Intent } from '../src/types/intent.js';
import type { MentalState } from '../src/loop/types.js';

const SECRET = 'retrieved-secret-payload-xyz';

const stringifyInbox = (inbox: ReadonlyArray<{ payload?: unknown; kind?: string; source?: string }>): string =>
    JSON.stringify(inbox);

describe('durable memory reads are not observations', () => {
    it('Learning semantic.read does not inject retrieved data into inbox.current', async () => {
        let readCount = 0;
        const h = createTestHarness({
            learning: async (prev: MentalState, _a, _o, mem) => {
                const rows = await mem.semantic.read({ id: 'concept-1' });
                readCount += 1;
                const local = prev.memory?.longTerm?.semantic?.concepts ?? [];
                const retrieved = rows.length > 0 ? rows : local.filter((c) => c.id === 'concept-1');
                expect(retrieved.length).toBeGreaterThanOrEqual(1);
                expect(JSON.stringify(retrieved)).toContain(SECRET);
                return prev;
            },
            policy: () => ({ kind: 'wait' } as Intent),
        });
        h.seedMentalState({
            memory: {
                longTerm: {
                    semantic: {
                        concepts: [{ id: 'concept-1', data: SECRET }],
                    },
                },
            },
        });
        await h.runTurn();
        expect(readCount).toBe(1);
        const inbox = h.lastTrace().inboxCurrent;
        expect(stringifyInbox(inbox)).not.toContain(SECRET);
        expect(inbox.some((o) => o.source === 'internal' && JSON.stringify(o.payload ?? {}).includes(SECRET))).toBe(
            false
        );
        expect(h.lastTrace()).not.toHaveProperty('memoryReads');
        expect(JSON.stringify(h.lastTrace())).not.toContain(SECRET);
    });
});
