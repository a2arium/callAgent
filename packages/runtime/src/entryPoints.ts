import { fileURLToPath } from 'node:url';

export type RuntimeEntryPoints = { host: string; worker: string };

/** Locates the version-matched runtime process entry points installed with this package. */
export function runtimeEntryPoints(): RuntimeEntryPoints {
    return {
        host: fileURLToPath(new URL('./host.js', import.meta.url)),
        worker: fileURLToPath(new URL('./worker.js', import.meta.url)),
    };
}
