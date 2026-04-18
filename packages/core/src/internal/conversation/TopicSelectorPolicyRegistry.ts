import type { TopicSelectorPolicy } from '../../public-types/conversation/selectorPolicy.js';

export type TopicSelectorPolicyRegistry = {
    register(policy: TopicSelectorPolicy): void;
    resolve(policyId: string): TopicSelectorPolicy | undefined;
    list(): ReadonlyArray<string>;
};

export function createTopicSelectorPolicyRegistry(): TopicSelectorPolicyRegistry {
    const byId = new Map<string, TopicSelectorPolicy>();
    return {
        register(policy: TopicSelectorPolicy): void {
            byId.set(policy.policyId, policy);
        },
        resolve(policyId: string): TopicSelectorPolicy | undefined {
            return byId.get(policyId);
        },
        list(): ReadonlyArray<string> {
            return [...byId.keys()].sort();
        },
    };
}
