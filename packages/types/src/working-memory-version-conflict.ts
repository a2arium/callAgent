export type WorkingMemoryVersionConflictDetails = {
    tenantId: string;
    sessionId: string;
    expectedWmVersion: string;
    actualWmVersion?: string;
};

/** Storage-level optimistic-concurrency signal for working-memory snapshots. */
export class WorkingMemoryVersionConflictError extends Error {
    public readonly code = 'WM_VERSION_CONFLICT';
    public readonly details: WorkingMemoryVersionConflictDetails;
    public readonly conflict: WorkingMemoryVersionConflictDetails;

    constructor(
        details: WorkingMemoryVersionConflictDetails,
        legacyMessage: 'CAS_MISMATCH' | 'WM_VERSION_CONFLICT' = 'WM_VERSION_CONFLICT'
    ) {
        super(legacyMessage);
        this.name = 'WorkingMemoryVersionConflictError';
        this.details = details;
        this.conflict = details;
        Object.setPrototypeOf(this, WorkingMemoryVersionConflictError.prototype);
    }
}

/** Accept typed conflicts and legacy store/fake errors during migration. */
export function isWorkingMemoryVersionConflict(
    error: unknown
): error is WorkingMemoryVersionConflictError | (Error & { code?: string }) {
    if (error instanceof WorkingMemoryVersionConflictError) return true;
    if (error !== null && typeof error === 'object') {
        const candidate = error as { code?: unknown; message?: unknown };
        if (candidate.code === 'WM_VERSION_CONFLICT') return true;
        return candidate.message === 'CAS_MISMATCH' || candidate.message === 'WM_VERSION_CONFLICT';
    }
    return error === 'CAS_MISMATCH' || error === 'WM_VERSION_CONFLICT';
}
