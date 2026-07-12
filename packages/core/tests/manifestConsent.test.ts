import { describe, expect, it } from '@jest/globals';
import {
    canonicalIntentIdentifier,
    digestIntent,
    isConsentDecision,
    manifestConsentTarget,
} from '../src/loop/manifestConsent.js';
import { applyInputProvided } from '../src/orchestration/DurableHandlerRegistry.js';

describe('manifest consent primitives', () => {
    it('resolves only canonical domain identifiers and explicit tools', () => {
        expect(canonicalIntentIdentifier({ kind: 'internal', intent: 'activate_bundle', data: {} })).toBe('activate_bundle');
        expect(canonicalIntentIdentifier({ kind: 'prompt_user', prompt: 'x' })).toBeUndefined();
        expect(manifestConsentTarget(
            { kind: 'call_tool', toolName: 'publish' },
            { requireConsentFor: { tools: ['publish'] } },
        )).toEqual({ intentId: 'publish', kind: 'tool' });
    });

    it('binds the digest to exact canonical content', () => {
        expect(digestIntent({ kind: 'internal', intent: 'x', data: { a: 1, b: 2 } }))
            .toBe(digestIntent({ kind: 'internal', intent: 'x', data: { b: 2, a: 1 } }));
        expect(digestIntent({ kind: 'internal', intent: 'x', data: { secret: 'a' } }))
            .not.toBe(digestIntent({ kind: 'internal', intent: 'x', data: { secret: 'b' } }));
    });

    it('rejects non-JSON intent content that cannot be bound exactly', () => {
        expect(() => digestIntent({ kind: 'internal', intent: 'x', data: new Date() }))
            .toThrow('MANIFEST_CONSENT_INTENT_NOT_JSON');
    });

    it('accepts only the closed structured decision', () => {
        expect(isConsentDecision({ decision: 'approve' })).toBe(true);
        expect(isConsentDecision({ decision: 'approve', extra: true })).toBe(false);
        expect(isConsentDecision('yes')).toBe(false);
    });

    it('updates a matching durable receipt without exposing the raw decision', () => {
        const snapshot = {
            meta: { turn: 2, agentId: 'agent-a' },
            pending: {
                inputs: { tok: { expiresAt: '2099-01-01T00:00:00.000Z' } },
                manifestConsents: {
                    tok: {
                        token: 'tok', taskId: 'task-a', agentId: 'agent-a', tenantId: 'tenant-a',
                        intentId: 'activate_bundle', intentDigest: 'digest', requestedAt: '2026-01-01T00:00:00.000Z',
                        expiresAt: '2099-01-01T00:00:00.000Z', effectIdempotencyKey: 'effect', status: 'pending' as const,
                    },
                },
            },
        };
        const { next } = applyInputProvided(snapshot, 'tok', { decision: 'approve' }, {
            tenantId: 'tenant-a', taskId: 'task-a', agentId: 'agent-a',
        });
        expect((next as any).pending.manifestConsents.tok.status).toBe('approved');
        expect((next as any).pending.inputs.tok).toBeUndefined();
        expect((next as any).inbox.current[0]).toMatchObject({
            source: 'internal', kind: 'state.noted', payload: { intentId: 'activate_bundle', status: 'approved' },
        });
        expect((next as any).inbox.current[0].payload).not.toHaveProperty('decision');
    });

    it('rejects malformed and mismatched consent input before consuming the token', () => {
        const snapshot = {
            pending: {
                inputs: { tok: {} },
                manifestConsents: {
                    tok: {
                        token: 'tok', taskId: 'task-a', agentId: 'agent-a', tenantId: 'tenant-a',
                        intentId: 'x', intentDigest: 'd', requestedAt: '2026-01-01T00:00:00.000Z',
                        expiresAt: '2099-01-01T00:00:00.000Z', effectIdempotencyKey: 'e', status: 'pending' as const,
                    },
                },
            },
        };
        expect(() => applyInputProvided(snapshot, 'tok', 'yes')).toThrow('MANIFEST_CONSENT_DECISION_INVALID');
        expect(() => applyInputProvided(snapshot, 'tok', { decision: 'approve' }, { tenantId: 'other' }))
            .toThrow('MANIFEST_CONSENT_TENANT_MISMATCH');
        expect((snapshot as any).pending.inputs.tok).toBeDefined();
    });
});
