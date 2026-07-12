import { createHash } from 'node:crypto';
import type { Intent } from '../types/intent.js';
import { canonicalize } from '../telemetry/manifestProvenance.js';
import type { IntentConsentReceipt } from './types.js';

export const DEFAULT_MANIFEST_CONSENT_TTL_MS = 86_400_000;

export type ManifestHitlConfig = {
    level?: 'advise' | 'consent' | 'guardrails';
    consentTtlMs?: number;
    requireConsentFor?: { intents?: string[]; tools?: string[] };
};

const GENERIC_WRAPPERS = new Set(['prompt_user', 'answer_with_llm', 'call_tool', 'delegate_to_child']);

export function canonicalIntentIdentifier(intent: Intent): string | undefined {
    if (intent.kind === 'internal') return intent.intent.trim() || undefined;
    if (GENERIC_WRAPPERS.has(intent.kind)) return undefined;
    return intent.kind;
}

export function manifestConsentTarget(
    intent: Intent,
    hitl?: ManifestHitlConfig
): { intentId: string; kind: 'intent' | 'tool' } | undefined {
    if (!hitl?.requireConsentFor) return undefined;
    if (intent.kind === 'call_tool') {
        return hitl.requireConsentFor.tools?.includes(intent.toolName)
            ? { intentId: intent.toolName, kind: 'tool' }
            : undefined;
    }
    const intentId = canonicalIntentIdentifier(intent);
    return intentId && hitl.requireConsentFor.intents?.includes(intentId)
        ? { intentId, kind: 'intent' }
        : undefined;
}

export function digestIntent(intent: Intent): string {
    assertCanonicalJson(intent);
    return createHash('sha256').update(canonicalize(intent), 'utf8').digest('hex');
}

function assertCanonicalJson(value: unknown, seen = new WeakSet<object>()): void {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object') throw new Error('MANIFEST_CONSENT_INTENT_NOT_JSON');
    if (seen.has(value)) throw new Error('MANIFEST_CONSENT_INTENT_NOT_JSON');
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            value.forEach((item) => assertCanonicalJson(item, seen));
            return;
        }
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) throw new Error('MANIFEST_CONSENT_INTENT_NOT_JSON');
        Object.values(value as Record<string, unknown>).forEach((item) => assertCanonicalJson(item, seen));
    } finally {
        seen.delete(value);
    }
}

export function deriveConsentEffectKey(receipt: Pick<IntentConsentReceipt, 'tenantId' | 'taskId' | 'agentId' | 'token' | 'intentDigest'>): string {
    return createHash('sha256')
        .update(canonicalize({ tenantId: receipt.tenantId, taskId: receipt.taskId, agentId: receipt.agentId, token: receipt.token, intentDigest: receipt.intentDigest }), 'utf8')
        .digest('hex');
}

export function sanitizedConsentPrompt(intentId: string, kind: 'intent' | 'tool'): string {
    return `Approval required for ${kind} \`${intentId}\`.`;
}

export const MANIFEST_CONSENT_INPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['decision'],
    properties: { decision: { enum: ['approve', 'reject'] } },
} as const;

export function isConsentDecision(value: unknown): value is { decision: 'approve' | 'reject' } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return Object.keys(record).length === 1 && (record.decision === 'approve' || record.decision === 'reject');
}
