import { z } from 'zod';

const identifier = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const boundedIdentifier = z.string().min(1).max(64).regex(identifier);

export const runProgressUnitSchema = z.object({
    key: boundedIdentifier,
    completed: z.number().int().nonnegative().safe(),
    total: z.number().int().nonnegative().safe().optional(),
    label: z.string().min(1).max(80).optional(),
}).strict().superRefine((unit, context) => {
    if (unit.total !== undefined && unit.completed > unit.total) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'completed cannot exceed total' });
    }
});

export const runProgressSnapshotSchema = z.object({
    schemaVersion: z.literal('run-progress-v1'),
    phase: boundedIdentifier,
    state: z.enum(['working', 'waiting', 'blocked', 'retrying']),
    summary: z.string().min(1).max(256).optional(),
    units: z.array(runProgressUnitSchema).max(8).optional(),
    metrics: z.record(boundedIdentifier, z.number().finite()).refine(
        (metrics) => Object.keys(metrics).length <= 16,
        'metrics cannot contain more than 16 entries'
    ).optional(),
    next: z.string().min(1).max(256).optional(),
    checkpoint: z.object({
        committedAt: z.string().datetime({ offset: true }),
        version: z.string().min(1).max(128).optional(),
    }).strict().optional(),
}).strict().superRefine((snapshot, context) => {
    const keys = snapshot.units?.map((unit) => unit.key) ?? [];
    if (new Set(keys).size !== keys.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'unit keys must be unique' });
    }
});

export type RunProgressState = z.infer<typeof runProgressSnapshotSchema>['state'];
export type RunProgressUnit = z.infer<typeof runProgressUnitSchema>;
export type RunProgressSnapshot = z.infer<typeof runProgressSnapshotSchema>;

export type RunProgressReportResult =
    | { status: 'accepted' | 'coalesced'; revision: string; reportedAt: string }
    | { status: 'skipped'; code: 'RUN_PROGRESS_DISABLED' | 'RUN_PROGRESS_UNAVAILABLE' | 'RUN_PROGRESS_RATE_LIMITED' }
    | { status: 'rejected'; code: 'RUN_PROGRESS_INVALID' | 'RUN_PROGRESS_FENCE_LOST' | 'RUN_PROGRESS_TERMINAL'; message: string };

export function validateRunProgressSnapshot(value: unknown):
    | { success: true; data: RunProgressSnapshot }
    | { success: false; message: string } {
    const parsed = runProgressSnapshotSchema.safeParse(value);
    if (!parsed.success) return { success: false, message: parsed.error.issues[0]?.message ?? 'Invalid progress snapshot' };
    const bytes = Buffer.byteLength(JSON.stringify(parsed.data), 'utf8');
    if (bytes > 8 * 1024) return { success: false, message: 'Progress snapshot exceeds 8192 UTF-8 bytes' };
    return { success: true, data: parsed.data };
}

export function readRunProgressMode(): 'enabled' | 'disabled' {
    const value = process.env.CALLAGENT_RUN_PROGRESS;
    if (value === undefined || value === '' || value === 'enabled') return 'enabled';
    if (value === 'disabled') return 'disabled';
    throw new Error('CALLAGENT_RUN_PROGRESS must be enabled or disabled');
}
