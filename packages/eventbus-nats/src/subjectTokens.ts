import { createHash } from 'node:crypto';

/** NATS-safe single subject token for an arbitrary string. */
export function encodeSegment(s: string): string {
    return createHash('sha256').update(s, 'utf8').digest('base64url').slice(0, 43);
}

export function msgLogSubject(streamPrefix: string, tenantId: string, conversationId: string): string {
    return `${streamPrefix}.${encodeSegment(tenantId)}.${encodeSegment(conversationId)}`;
}

export function busSubject(streamPrefix: string, channel: string): string {
    return `${streamPrefix}.${encodeSegment(channel)}`;
}
