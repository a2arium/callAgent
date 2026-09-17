import type { StopPolicyDefinition, StopPolicyRegistry } from '../../public-types/conversation/stopPolicy.js';

export function createStopPolicyRegistry(): StopPolicyRegistry {
    const byId = new Map<string, StopPolicyDefinition>();
    return {
        register(policy: StopPolicyDefinition): void {
            byId.set(policy.policyId, policy);
        },
        resolve(policyId: string): StopPolicyDefinition | undefined {
            return byId.get(policyId);
        },
        list(): ReadonlyArray<string> {
            return [...byId.keys()].sort();
        },
    };
}
