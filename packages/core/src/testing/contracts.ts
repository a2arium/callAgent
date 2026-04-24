/**
 * Jest-only adapter contract runners. Import from `@a2arium/callagent-core/testing/contracts`
 * in tests — not from the main package entry (plain Node must not load `@jest/globals`).
 */
export { runEventBusContract, type EventBusContractFactory, type EventBusContractContext } from './eventBusContract.js';
export { runMessageLogContract, type MessageLogContractFactory, type MessageLogContractContext } from './messageLogContract.js';
export {
    runDurableSubscriptionContract,
    type DurableSubscriptionContractFactory,
    type DurableSubscriptionContractContext,
} from './durableSubscriptionContract.js';
