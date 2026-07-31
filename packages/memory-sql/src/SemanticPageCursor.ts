import {
    createCipheriv,
    createDecipheriv,
    createHash,
    randomBytes,
    timingSafeEqual,
} from 'node:crypto';
import { SemanticQueryError } from '@a2arium/callagent-types';

const TOKEN_VERSION = 'v1';
const PAYLOAD_VERSION = 1;
const MAX_CURSOR_LENGTH = 4096;
const AAD = Buffer.from('@a2arium/callagent:semantic-page:v1', 'utf8');
const DATABASE_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type SemanticPageCursorPosition = {
    orderValue: string;
    key: string;
};

export type SemanticPageCursorPayload = {
    asOf: string;
    after: SemanticPageCursorPosition;
};

type StoredCursorPayload = SemanticPageCursorPayload & {
    version: typeof PAYLOAD_VERSION;
    queryDigest: string;
};

function invalidCursor(cause?: unknown): SemanticQueryError {
    return new SemanticQueryError(
        'SEMANTIC_CURSOR_INVALID',
        'Semantic-memory pagination cursor is invalid',
        { cause },
    );
}

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
    if (typeof value !== 'object') {
        throw new SemanticQueryError(
            'SEMANTIC_QUERY_INVALID_COMBINATION',
            'Semantic-memory page filters must contain JSON-compatible values',
        );
    }
    if (seen.has(value)) {
        throw new SemanticQueryError(
            'SEMANTIC_QUERY_INVALID_COMBINATION',
            'Semantic-memory page filters cannot contain cycles',
        );
    }

    seen.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map((entry) => canonicalize(entry, seen));
        }

        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new SemanticQueryError(
                'SEMANTIC_QUERY_INVALID_COMBINATION',
                'Semantic-memory page filters must contain plain JSON objects',
            );
        }
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            const child = (value as Record<string, unknown>)[key];
            if (child === undefined) {
                throw new SemanticQueryError(
                    'SEMANTIC_QUERY_INVALID_COMBINATION',
                    'Semantic-memory page filters cannot contain undefined values',
                );
            }
            result[key] = canonicalize(child, seen);
        }
        return result;
    } finally {
        seen.delete(value);
    }
}

export function semanticPageQueryDigest(query: unknown): string {
    const json = JSON.stringify(canonicalize(query));
    return createHash('sha256').update(json).digest('base64url');
}

export function parseSemanticCursorKey(value: string | undefined): Buffer | undefined {
    if (value === undefined || value.trim() === '') return undefined;
    const normalized = value.trim();
    if (!BASE64URL_PATTERN.test(normalized)) {
        throw new Error('SEMANTIC_CURSOR_KEY must be an unpadded base64url-encoded 32-byte key');
    }
    const decoded = Buffer.from(normalized, 'base64url');
    if (decoded.length !== 32 || decoded.toString('base64url') !== normalized) {
        throw new Error('SEMANTIC_CURSOR_KEY must be an unpadded base64url-encoded 32-byte key');
    }
    return decoded;
}

function validateDatabaseTimestamp(value: unknown): value is string {
    return typeof value === 'string' && DATABASE_TIMESTAMP_PATTERN.test(value);
}

function decodeCanonicalBase64Url(value: string): Buffer {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) throw invalidCursor();
    return decoded;
}

export class SemanticPageCursorCodec {
    constructor(private readonly key: Buffer) {
        if (key.length !== 32) throw new Error('Semantic pagination cursor key must contain 32 bytes');
    }

    encode(queryDigest: string, payload: SemanticPageCursorPayload): string {
        if (!validateDatabaseTimestamp(payload.asOf) || !validateDatabaseTimestamp(payload.after.orderValue)) {
            throw new Error('Semantic pagination cursor timestamp is invalid');
        }
        const stored: StoredCursorPayload = {
            version: PAYLOAD_VERSION,
            queryDigest,
            asOf: payload.asOf,
            after: { ...payload.after },
        };
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.key, iv);
        cipher.setAAD(AAD);
        const encrypted = Buffer.concat([
            cipher.update(JSON.stringify(stored), 'utf8'),
            cipher.final(),
        ]);
        const token = [
            TOKEN_VERSION,
            iv.toString('base64url'),
            encrypted.toString('base64url'),
            cipher.getAuthTag().toString('base64url'),
        ].join('.');
        if (token.length > MAX_CURSOR_LENGTH) throw invalidCursor();
        return token;
    }

    decode(token: string, expectedQueryDigest: string): SemanticPageCursorPayload {
        if (typeof token !== 'string' || token.length === 0 || token.length > MAX_CURSOR_LENGTH) {
            throw invalidCursor();
        }
        const parts = token.split('.');
        if (parts.length !== 4 || parts[0] !== TOKEN_VERSION || parts.slice(1).some((part) => !BASE64URL_PATTERN.test(part))) {
            throw invalidCursor();
        }

        try {
            const iv = decodeCanonicalBase64Url(parts[1]!);
            const encrypted = decodeCanonicalBase64Url(parts[2]!);
            const authTag = decodeCanonicalBase64Url(parts[3]!);
            if (iv.length !== 12 || encrypted.length === 0 || authTag.length !== 16) throw invalidCursor();

            const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
            decipher.setAAD(AAD);
            decipher.setAuthTag(authTag);
            const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
            const parsed = JSON.parse(plaintext) as Partial<StoredCursorPayload>;
            if (
                parsed.version !== PAYLOAD_VERSION
                || typeof parsed.queryDigest !== 'string'
                || !validateDatabaseTimestamp(parsed.asOf)
                || !parsed.after
                || !validateDatabaseTimestamp(parsed.after.orderValue)
                || typeof parsed.after.key !== 'string'
            ) {
                throw invalidCursor();
            }

            const actualDigest = Buffer.from(parsed.queryDigest, 'utf8');
            const expectedDigest = Buffer.from(expectedQueryDigest, 'utf8');
            if (actualDigest.length !== expectedDigest.length || !timingSafeEqual(actualDigest, expectedDigest)) {
                throw new SemanticQueryError(
                    'SEMANTIC_CURSOR_QUERY_MISMATCH',
                    'Semantic-memory pagination cursor does not match the requested query',
                );
            }
            return {
                asOf: parsed.asOf,
                after: { orderValue: parsed.after.orderValue, key: parsed.after.key },
            };
        } catch (error) {
            if (error instanceof SemanticQueryError) throw error;
            throw invalidCursor(error);
        }
    }
}
