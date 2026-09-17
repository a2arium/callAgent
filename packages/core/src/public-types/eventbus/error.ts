import { z } from 'zod';

export const AdapterErrorSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('AdapterNotInstalled'),
        adapterId: z.string(),
        packageName: z.string(),
    }),
    z.object({
        kind: z.literal('AdapterUnknown'),
        adapterId: z.string(),
    }),
    z.object({
        kind: z.literal('AdapterConfigInvalid'),
        adapterId: z.string(),
        issues: z.array(z.string()).min(1),
    }),
    z.object({
        kind: z.literal('AdapterConnectFailed'),
        adapterId: z.string(),
        cause: z.string(),
    }),
    z.object({
        kind: z.literal('AdapterVersionIncompatible'),
        adapterId: z.string(),
        adapterVersion: z.string(),
        minCoreVersion: z.string(),
    }),
]);

export type AdapterError = z.infer<typeof AdapterErrorSchema>;

const adapterErrorTag = Symbol('AdapterErrorThrowable');

export class AdapterErrorThrowable extends Error {
    readonly body: AdapterError;
    readonly [adapterErrorTag] = true;

    constructor(body: AdapterError) {
        super(`AdapterError:${body.kind}:${'adapterId' in body ? body.adapterId : ''}`);
        this.name = 'AdapterErrorThrowable';
        this.body = body;
    }
}

export function isAdapterErrorThrowable(e: unknown): e is AdapterErrorThrowable {
    return e instanceof AdapterErrorThrowable;
}
