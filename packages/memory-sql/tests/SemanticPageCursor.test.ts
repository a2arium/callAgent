import { describe, expect, it } from '@jest/globals';
import {
    parseSemanticCursorKey,
    SemanticPageCursorCodec,
    semanticPageQueryDigest,
} from '../src/SemanticPageCursor.js';

const key = Buffer.alloc(32, 7);
const timestamp = '2026-07-31 12:30:45.123';

describe('SemanticPageCursorCodec', () => {
    it('round-trips an authenticated opaque payload', () => {
        const codec = new SemanticPageCursorCodec(key);
        const digest = semanticPageQueryDigest({
            tenantId: 'tenant-secret',
            tags: ['private-tag'],
            filters: [{ path: 'secret', operator: '=', value: 'hidden-value' }],
        });
        const token = codec.encode(digest, {
            asOf: timestamp,
            after: { orderValue: timestamp, key: 'private-key' },
        });

        expect(token).toMatch(/^v1\./);
        expect(token).not.toContain('tenant-secret');
        expect(token).not.toContain('private-tag');
        expect(token).not.toContain('hidden-value');
        expect(token).not.toContain('private-key');
        expect(codec.decode(token, digest)).toEqual({
            asOf: timestamp,
            after: { orderValue: timestamp, key: 'private-key' },
        });
    });

    it('rejects tampering, another key, another query, and oversized input', () => {
        const codec = new SemanticPageCursorCodec(key);
        const digest = semanticPageQueryDigest({ tenantId: 'a' });
        const token = codec.encode(digest, {
            asOf: timestamp,
            after: { orderValue: timestamp, key: 'key' },
        });
        const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;

        expect(() => codec.decode(tampered, digest)).toThrow(expect.objectContaining({ code: 'SEMANTIC_CURSOR_INVALID' }));
        expect(() => new SemanticPageCursorCodec(Buffer.alloc(32, 8)).decode(token, digest))
            .toThrow(expect.objectContaining({ code: 'SEMANTIC_CURSOR_INVALID' }));
        expect(() => codec.decode(token, semanticPageQueryDigest({ tenantId: 'b' })))
            .toThrow(expect.objectContaining({ code: 'SEMANTIC_CURSOR_QUERY_MISMATCH' }));
        expect(() => codec.decode(`v1.${'a'.repeat(5000)}`, digest))
            .toThrow(expect.objectContaining({ code: 'SEMANTIC_CURSOR_INVALID' }));
    });

    it('requires a canonical unpadded base64url 32-byte key', () => {
        const encoded = key.toString('base64url');
        expect(parseSemanticCursorKey(undefined)).toBeUndefined();
        expect(parseSemanticCursorKey(encoded)).toEqual(key);
        expect(() => parseSemanticCursorKey('short')).toThrow(/32-byte key/);
        expect(() => parseSemanticCursorKey(`${encoded}=`)).toThrow(/base64url/);
    });

    it('canonicalizes object keys while rejecting non-JSON query values', () => {
        expect(semanticPageQueryDigest({ b: 2, a: { d: 4, c: 3 } }))
            .toBe(semanticPageQueryDigest({ a: { c: 3, d: 4 }, b: 2 }));
        expect(() => semanticPageQueryDigest({ invalid: new Date() }))
            .toThrow(expect.objectContaining({ code: 'SEMANTIC_QUERY_INVALID_COMBINATION' }));
        expect(() => semanticPageQueryDigest({ invalid: undefined }))
            .toThrow(expect.objectContaining({ code: 'SEMANTIC_QUERY_INVALID_COMBINATION' }));
    });
});
