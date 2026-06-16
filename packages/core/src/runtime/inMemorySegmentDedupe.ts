/**
 * In-process segment dedupe for Phase 0.2.
 *
 * Durable dedupe (ADR 0005) lands in Phase 2; this is sufficient for the
 * in-process driver and local tests.
 */

export type SegmentDedupe = {
    has(key: string): boolean;
    record(key: string): void;
    clear(): void;
};

export function createInMemorySegmentDedupe(): SegmentDedupe {
    const processed = new Set<string>();
    return {
        has(key: string) {
            return processed.has(key);
        },
        record(key: string) {
            processed.add(key);
        },
        clear() {
            processed.clear();
        },
    };
}
