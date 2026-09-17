import type { TopicSelectorPolicy, TopicSelectorPolicyContext } from '../public-types/conversation/selectorPolicy.js';
import type { StopPolicyDefinition, StopPolicyRegistry } from '../public-types/conversation/stopPolicy.js';
import type { TopicSelectorPolicyRegistry } from '../internal/conversation/TopicSelectorPolicyRegistry.js';

function runWithPolicyPurityEnforcement<T>(label: string, fn: () => T): T {
    const forbid = (): never => {
        throw new Error(
            `${label}: selector/stop policies must use framework time from context (e.g. nowIso); direct Date.now / Math.random / Date#getTime are forbidden in harness strict mode.`
        );
    };
    const origNow = Date.now;
    const origRandom = Math.random;
    const origGetTime = Date.prototype.getTime;
    Date.now = forbid as () => number;
    Math.random = forbid as () => number;
    Date.prototype.getTime = forbid as () => number;
    try {
        return fn();
    } finally {
        Date.now = origNow;
        Math.random = origRandom;
        Date.prototype.getTime = origGetTime;
    }
}

/** Wraps registry `register` so `select` runs under purity checks (TestHarness default). */
export function wrapTopicSelectorPolicyRegistry(
    inner: TopicSelectorPolicyRegistry,
    strict: boolean
): TopicSelectorPolicyRegistry {
    if (!strict) {
        return inner;
    }
    return {
        register(policy: TopicSelectorPolicy): void {
            const wrapped: TopicSelectorPolicy = {
                policyId: policy.policyId,
                ...(policy.paramsSchema !== undefined ? { paramsSchema: policy.paramsSchema } : {}),
                select: (context: TopicSelectorPolicyContext) =>
                    runWithPolicyPurityEnforcement(`TopicSelectorPolicy(${policy.policyId})`, () =>
                        policy.select(context)
                    ),
            };
            inner.register(wrapped);
        },
        resolve: (policyId) => inner.resolve(policyId),
        list: () => inner.list(),
    };
}

/** Wraps registry `register` so `evaluate` runs under purity checks (TestHarness default). */
export function wrapStopPolicyRegistry(inner: StopPolicyRegistry, strict: boolean): StopPolicyRegistry {
    if (!strict) {
        return inner;
    }
    return {
        register(policy: StopPolicyDefinition): void {
            const wrapped: StopPolicyDefinition = {
                policyId: policy.policyId,
                ...(policy.paramsSchema !== undefined ? { paramsSchema: policy.paramsSchema } : {}),
                evaluate: (ctx) =>
                    runWithPolicyPurityEnforcement(`StopPolicy(${policy.policyId})`, () => policy.evaluate(ctx)),
            };
            inner.register(wrapped);
        },
        resolve: (policyId) => inner.resolve(policyId),
        list: () => inner.list(),
    };
}
