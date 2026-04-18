import type { ConversationMessageRecord } from '@a2arium/callagent-memory-engine';
import type { ConversationError } from '../../public-types/conversation/types.js';
import type { TopicStopPolicyRule } from '../../public-types/conversation/schemas.js';
import { SignalKindSchema } from '../../public-types/conversation/signal.js';
import type {
    StopPolicyRegistry,
    TopicStopPolicyContext,
    TopicStopPolicyEvaluationDecision,
} from '../../public-types/conversation/stopPolicy.js';

export type TopicStopPolicyEngineResult =
    | { status: 'ok' }
    | { status: 'stop'; reason?: string }
    | { status: 'error'; error: ConversationError };

function extractSignalKind(payload: Record<string, unknown>): string | undefined {
    const c = payload.content;
    if (c && typeof c === 'object' && c !== null && 'signalKind' in c) {
        return String((c as { signalKind?: unknown }).signalKind);
    }
    return undefined;
}

type BuiltinDecision = { kind: 'continue' } | { kind: 'stop'; reason?: string };

function evaluateBuiltin(
    rule: Exclude<TopicStopPolicyRule, { kind: 'custom' }>,
    ctx: TopicStopPolicyContext,
    messages: ConversationMessageRecord[]
): BuiltinDecision {
    switch (rule.kind) {
        case 'maxTurns':
            return ctx.totalMessages >= rule.n
                ? { kind: 'stop', reason: `maxTurns reached (${rule.n})` }
                : { kind: 'continue' };
        case 'maxRounds':
            return ctx.totalRounds >= rule.n
                ? { kind: 'stop', reason: `maxRounds reached (${rule.n})` }
                : { kind: 'continue' };
        case 'timeout': {
            const elapsed = Date.parse(ctx.nowIso) - Date.parse(ctx.topicCreatedAtIso);
            return elapsed >= rule.afterMs
                ? { kind: 'stop', reason: `timeout after ${rule.afterMs}ms` }
                : { kind: 'continue' };
        }
        case 'signalBased': {
            const need = rule.requiredCount ?? 1;
            const sigs = new Set(rule.signals.map((s) => String(s)));
            let hit = 0;
            for (const m of messages) {
                if (m.speechAct !== 'signal') {
                    continue;
                }
                const sk = extractSignalKind(m.payload);
                if (sk === undefined) {
                    continue;
                }
                const parsed = SignalKindSchema.safeParse(sk);
                if (!parsed.success || !sigs.has(String(parsed.data))) {
                    continue;
                }
                hit++;
                if (hit >= need) {
                    return { kind: 'stop', reason: `signalBased threshold (${need})` };
                }
            }
            return { kind: 'continue' };
        }
        default: {
            const _x: never = rule;
            return _x;
        }
    }
}

function mapRejectedToConversationError(
    rule: Extract<TopicStopPolicyRule, { kind: 'custom' }>,
    d: Extract<TopicStopPolicyEvaluationDecision, { kind: 'rejected' }>
): ConversationError {
    if (d.error.type === 'PolicyParamsInvalid') {
        return {
            type: 'StopPolicyParamsInvalid',
            message: d.error.message,
            policyId: rule.policyId,
        };
    }
    return {
        type: 'StopPolicyInternalError',
        message: d.error.message,
        policyId: rule.policyId,
    };
}

/**
 * Evaluates configured stop rules in order; first `stop` or `error` wins.
 */
export function evaluateTopicStopPolicies(input: {
    rules: readonly TopicStopPolicyRule[];
    ctx: TopicStopPolicyContext;
    messages: ConversationMessageRecord[];
    registry: StopPolicyRegistry;
}): TopicStopPolicyEngineResult {
    const { rules, ctx, messages, registry } = input;
    for (const rule of rules) {
        if (rule.kind === 'custom') {
            const def = registry.resolve(rule.policyId);
            if (!def) {
                return {
                    status: 'error',
                    error: {
                        type: 'StopPolicyNotRegistered',
                        message: 'Stop policy is not registered.',
                        policyId: rule.policyId,
                    },
                };
            }
            if (def.paramsSchema) {
                const parsed = def.paramsSchema.safeParse(rule.params);
                if (!parsed.success) {
                    return {
                        status: 'error',
                        error: {
                            type: 'StopPolicyParamsInvalid',
                            message: parsed.error.message,
                            policyId: rule.policyId,
                        },
                    };
                }
            }
            const ctxWithParams: TopicStopPolicyContext = { ...ctx, params: rule.params };
            const d = def.evaluate(ctxWithParams);
            if (d.kind === 'continue') {
                continue;
            }
            if (d.kind === 'stop') {
                return { status: 'stop', reason: d.reason };
            }
            return { status: 'error', error: mapRejectedToConversationError(rule, d) };
        }

        const d = evaluateBuiltin(rule, ctx, messages);
        if (d.kind === 'continue') {
            continue;
        }
        return { status: 'stop', reason: d.reason };
    }
    return { status: 'ok' };
}
