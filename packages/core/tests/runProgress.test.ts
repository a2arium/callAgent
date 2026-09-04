import { describe, expect, it } from '@jest/globals';
import { validateRunProgressSnapshot } from '../src/progress/runProgress.js';

describe('run progress contract', () => {
    it('accepts minimal and complete v1 snapshots', () => {
        expect(validateRunProgressSnapshot({ schemaVersion: 'run-progress-v1', phase: 'download', state: 'working' }).success).toBe(true);
        expect(validateRunProgressSnapshot({
            schemaVersion: 'run-progress-v1', phase: 'spool-replay', state: 'retrying', summary: 'Replaying chunks',
            units: [{ key: 'chunks', completed: 2, total: 4, label: 'Chunks' }], metrics: { retries: 1 },
            next: 'Replay chunk 3', checkpoint: { committedAt: '2026-09-04T12:30:00.000Z', version: 'checkpoint-2' },
        }).success).toBe(true);
    });

    it.each([
        {},
        { schemaVersion: 'run-progress-v1', phase: 'Bad Phase', state: 'working' },
        { schemaVersion: 'run-progress-v1', phase: 'work', state: 'working', extra: true },
        { schemaVersion: 'run-progress-v1', phase: 'work', state: 'working', units: [{ key: 'rows', completed: 2, total: 1 }] },
        { schemaVersion: 'run-progress-v1', phase: 'work', state: 'working', units: [{ key: 'rows', completed: 1 }, { key: 'rows', completed: 2 }] },
        { schemaVersion: 'run-progress-v1', phase: 'work', state: 'working', metrics: { bad: Number.NaN } },
    ])('rejects malformed reports', (value) => expect(validateRunProgressSnapshot(value).success).toBe(false));
});
