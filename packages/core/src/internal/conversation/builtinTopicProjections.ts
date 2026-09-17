import { z } from 'zod';
import type { MessageLogRecord } from '../../public-types/messageLog/schemas.js';
import { defineTopicProjection } from '../../public-types/conversation/topicProjection.js';
import { getTopicProjectionRegistry, type TopicProjectionRegistry } from './TopicProjectionRegistry.js';

const TopicTranscriptStateSchema = z.object({
    lines: z.array(
        z.object({
            sequenceNumber: z.number().int().nonnegative(),
            speechAct: z.string(),
            text: z.string(),
        })
    ),
});

function recordPreview(record: MessageLogRecord): string {
    const p = record.payload;
    if (p && typeof p === 'object' && p !== null && 'content' in p) {
        const c = (p as { content: unknown }).content;
        if (typeof c === 'string') {
            return c;
        }
        try {
            return JSON.stringify(c);
        } catch {
            return '';
        }
    }
    return '';
}

const topicTranscript = defineTopicProjection({
    projectionName: 'topic.transcript',
    stateSchema: TopicTranscriptStateSchema,
    initial: () => ({ lines: [] }),
    reduce: (state, record) => ({
        lines: [
            ...state.lines,
            {
                sequenceNumber: record.sequenceNumber,
                speechAct: record.speechAct,
                text: recordPreview(record),
            },
        ],
    }),
});

export const topicTranscriptProjectionToken = topicTranscript.token;

export function registerBuiltinTopicTranscript(registry: TopicProjectionRegistry): void {
    registry.register(topicTranscript.definition);
}

let ensured = false;

/** Idempotent: registers built-in projections on the process-wide registry. */
export function ensureBuiltinTopicProjectionsRegistered(): void {
    if (ensured) {
        return;
    }
    registerBuiltinTopicTranscript(getTopicProjectionRegistry());
    ensured = true;
}
