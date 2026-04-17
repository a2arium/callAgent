/**
 * Narrow time source for conversation invite TTL/expiry and sweeper determinism.
 * Production uses wall clock; tests override via {@link wallClock} replacement or harness.
 */
export type Clock = {
    now: () => Date;
};

export const wallClock: Clock = {
    now: () => new Date(),
};
