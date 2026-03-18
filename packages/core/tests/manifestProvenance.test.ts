import { describe, it, expect } from '@jest/globals';
import {
    computeStableHash,
    validateManifestIdentity,
    resolveManifestProvenance,
    type ManifestResolutionInput,
} from '../src/telemetry/manifestProvenance.js';

describe('manifestProvenance', () => {
    describe('computeStableHash', () => {
        it('produces same hash for same JSON with different whitespace', () => {
            const a = { name: 'x', version: '1' };
            const b = { name: 'x', version: '1' };
            expect(computeStableHash(a)).toBe(computeStableHash(b));
            const withSpaces = JSON.parse('  { "name": "x", "version": "1" }  ');
            expect(computeStableHash(withSpaces)).toBe(computeStableHash(a));
        });

        it('produces same hash for same JSON with different key order', () => {
            const a = { version: '1', name: 'x' };
            const b = { name: 'x', version: '1' };
            expect(computeStableHash(a)).toBe(computeStableHash(b));
        });

        it('produces different hashes for different JSON', () => {
            const a = { name: 'x', version: '1' };
            const b = { name: 'y', version: '1' };
            const c = { name: 'x', version: '2' };
            expect(computeStableHash(a)).not.toBe(computeStableHash(b));
            expect(computeStableHash(a)).not.toBe(computeStableHash(c));
        });

        it('returns valid SHA-256 hex string (64 chars)', () => {
            const hash = computeStableHash({ name: 'test', version: '1.0' });
            expect(hash).toMatch(/^[a-f0-9]{64}$/);
        });
    });

    describe('validateManifestIdentity', () => {
        it('passes when name and version match', () => {
            expect(() =>
                validateManifestIdentity(
                    { name: 'agent', version: '1.0' },
                    { name: 'agent', version: '1.0' }
                )
            ).not.toThrow();
        });

        it('throws when name mismatches', () => {
            expect(() =>
                validateManifestIdentity(
                    { name: 'agent-a', version: '1.0' },
                    { name: 'agent-b', version: '1.0' }
                )
            ).toThrow(/agentCard\.name.*runtimeManifest\.name/);
        });

        it('throws when version mismatches', () => {
            expect(() =>
                validateManifestIdentity(
                    { name: 'agent', version: '1.0' },
                    { name: 'agent', version: '2.0' }
                )
            ).toThrow(/agentCard\.version.*runtimeManifest\.version/);
        });
    });

    describe('resolveManifestProvenance', () => {
        it('records source inline when provided inline', () => {
            const content = { name: 'a', version: '1' };
            const p = resolveManifestProvenance({
                agentCard: { source: 'inline', content: content as unknown as ManifestResolutionInput['agentCard'] extends undefined ? never : NonNullable<ManifestResolutionInput['agentCard']>['content'] },
                runtimeManifest: { source: 'inline', content: content as unknown as ManifestResolutionInput['runtimeManifest'] extends undefined ? never : NonNullable<ManifestResolutionInput['runtimeManifest']>['content'] },
            });
            expect(p.agentCardSource).toBe('inline');
            expect(p.runtimeManifestSource).toBe('inline');
            expect(p.agentCardHash).toMatch(/^[a-f0-9]{64}$/);
            expect(p.runtimeManifestHash).toMatch(/^[a-f0-9]{64}$/);
        });

        it('records source defaultPath when provided', () => {
            const p = resolveManifestProvenance({
                agentCard: { source: 'defaultPath', content: { name: 'b', version: '2' } as Record<string, unknown> },
                runtimeManifest: { source: 'defaultPath', content: { name: 'b', version: '2' } as Record<string, unknown> },
            });
            expect(p.agentCardSource).toBe('defaultPath');
            expect(p.runtimeManifestSource).toBe('defaultPath');
        });

        it('records source pathOverride when provided', () => {
            const p = resolveManifestProvenance({
                agentCard: { source: 'pathOverride', content: { name: 'c', version: '3' } as Record<string, unknown> },
                runtimeManifest: { source: 'pathOverride', content: { name: 'c', version: '3' } as Record<string, unknown> },
            });
            expect(p.agentCardSource).toBe('pathOverride');
            expect(p.runtimeManifestSource).toBe('pathOverride');
        });

        it('throws when identity mismatch', () => {
            expect(() =>
                resolveManifestProvenance({
                    agentCard: { source: 'inline', content: { name: 'x', version: '1' } as Record<string, unknown> },
                    runtimeManifest: { source: 'inline', content: { name: 'y', version: '1' } as Record<string, unknown> },
                })
            ).toThrow(/identity mismatch/);
        });

        it('returns empty hashes when content missing', () => {
            const p = resolveManifestProvenance({});
            expect(p.agentCardSource).toBe('inline');
            expect(p.runtimeManifestSource).toBe('inline');
            expect(p.agentCardHash).toBe('');
            expect(p.runtimeManifestHash).toBe('');
        });
    });
});
