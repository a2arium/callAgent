export type SegmentCancellation = {
    requested: true;
    reason?: string;
    requestedAt?: string;
};

type SnapshotWithCancellation = {
    meta?: {
        cancellation?: unknown;
    };
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readSegmentCancellation(snapshot: unknown): SegmentCancellation | undefined {
    if (!isRecord(snapshot)) {
        return undefined;
    }
    const meta = (snapshot as SnapshotWithCancellation).meta;
    if (!isRecord(meta)) {
        return undefined;
    }
    const cancellation = meta.cancellation;
    if (!isRecord(cancellation) || cancellation.requested !== true) {
        return undefined;
    }
    return {
        requested: true,
        ...(typeof cancellation.reason === 'string' ? { reason: cancellation.reason } : {}),
        ...(typeof cancellation.requestedAt === 'string' ? { requestedAt: cancellation.requestedAt } : {}),
    };
}

export function isSegmentCancellationRequested(snapshot: unknown): boolean {
    return readSegmentCancellation(snapshot) !== undefined;
}

export function markSegmentCancellationRequested(
    snapshot: Record<string, unknown>,
    reason: string | undefined,
    requestedAt: string = new Date().toISOString()
): Record<string, unknown> {
    const meta = isRecord(snapshot.meta) ? snapshot.meta : {};
    const current = readSegmentCancellation(snapshot);
    const resolvedReason = current?.reason ?? reason;
    return {
        ...snapshot,
        meta: {
            ...meta,
            cancellation: {
                requested: true,
                requestedAt: current?.requestedAt ?? requestedAt,
                ...(resolvedReason !== undefined ? { reason: resolvedReason } : {}),
            },
        },
    };
}
