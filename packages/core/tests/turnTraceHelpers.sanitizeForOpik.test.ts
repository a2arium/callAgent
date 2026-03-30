import { describe, it, expect, afterEach } from '@jest/globals';
import { sanitizeForOpikPayload } from '../src/telemetry/turnTraceHelpers.js';

describe('sanitizeForOpikPayload', () => {
    const prev = process.env.CALLAGENT_OPIK_MAX_STRING_CHARS;

    afterEach(() => {
        if (prev === undefined) {
            delete process.env.CALLAGENT_OPIK_MAX_STRING_CHARS;
        } else {
            process.env.CALLAGENT_OPIK_MAX_STRING_CHARS = prev;
        }
    });

    it('truncates long strings with total length hint', () => {
        const long = 'x'.repeat(100);
        const out = sanitizeForOpikPayload(long, { maxStringChars: 20 }) as string;
        expect(out.length).toBeLessThanOrEqual(20 + 40);
        expect(out).toContain('truncated 100 chars');
        expect(out.startsWith('xxxxxxxxxxxxxxxxxxxx')).toBe(true);
    });

    it('reduces artifact markers to metadata fields', () => {
        const marker = {
            kind: 'artifact',
            id: 'a1',
            mimeType: 'text/html',
            estimatedSize: 999,
            inlineBody: '<html>'.repeat(500),
        };
        const out = sanitizeForOpikPayload(marker) as Record<string, unknown>;
        expect(out).toEqual({
            kind: 'artifact',
            id: 'a1',
            mimeType: 'text/html',
            estimatedSize: 999,
        });
    });

    it('caps array length with a trailing notice', () => {
        const arr = Array.from({ length: 10 }, (_, i) => i);
        const out = sanitizeForOpikPayload(arr, {
            maxArrayLength: 3,
            maxStringChars: 1000,
            maxDepth: 10,
        }) as unknown[];
        expect(out).toHaveLength(4);
        expect(out[out.length - 1]).toContain('truncated 7 array items');
    });
});
