import { z } from 'zod';

/**
 * Closed vocabulary of system-level signal kinds (Phase 4).
 * Core enum is additive-only; integrators use the `x-` extension namespace.
 */
export const SignalKindSchema = z.union([
    z.enum([
        'topic.backpressure.changed',
        'topic.policy.unsupported',
        'topic.archive.scheduled',
        'delivery.capability.rejected',
    ]),
    z.string().regex(/^x-[a-z0-9][a-z0-9._-]{0,118}$/),
]);

export type SignalKind = z.infer<typeof SignalKindSchema>;
