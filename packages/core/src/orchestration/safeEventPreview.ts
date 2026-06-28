const REDACTED = '[redacted]';
const MAX_DEPTH = 5;
const MAX_OBJECT_KEYS = 24;
const MAX_ARRAY_ITEMS = 12;
const MAX_STRING_CHARS = 1200;
const LONG_TEXT_SUMMARY_THRESHOLD = 4000;

const SENSITIVE_KEY_PATTERN = /(?:^|[_\-.])(api[_\-.]?key|secret|password|passwd|pwd|token|access[_\-.]?token|refresh[_\-.]?token|authorization|cookie|set[_\-.]?cookie|session[_\-.]?id|private[_\-.]?key)(?:$|[_\-.])/i;
const ENV_KEY_PATTERN = /(?:^|[_\-.])(env|envs|env[_\-.]?vars|environment)(?:$|[_\-.])/i;
const SECRET_VALUE_PATTERNS = [
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
    /\bsk-[A-Za-z0-9_-]{16,}\b/,
    /\bbu_[A-Za-z0-9_-]{16,}\b/,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
    /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/,
];

type ArtifactPreviewEnvelope = {
    state: 'artifact_only';
    artifactId: string;
    summary: string;
    mimeType?: string;
    estimatedSize?: number;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
    return SENSITIVE_KEY_PATTERN.test(key);
}

function isEnvContainerKey(key: string): boolean {
    return ENV_KEY_PATTERN.test(key);
}

function redactSecretLikeString(value: string): string {
    let next = value;
    for (const pattern of SECRET_VALUE_PATTERNS) {
        next = next.replace(pattern, REDACTED);
    }
    return next;
}

function summarizeLongString(value: string): string {
    const trimmedStart = value.trimStart().slice(0, 32).toLowerCase();
    if (value.length >= LONG_TEXT_SUMMARY_THRESHOLD && trimmedStart.startsWith('<')) {
        return `[html/text truncated, ${value.length} chars]`;
    }
    if (value.length <= MAX_STRING_CHARS) {
        return value;
    }
    return `${value.slice(0, MAX_STRING_CHARS)}... [truncated ${value.length} chars]`;
}

function summarizeEnvObject(value: unknown): unknown {
    if (!isPlainObject(value)) {
        return REDACTED;
    }
    const keys = Object.keys(value);
    return keys.reduce<Record<string, string>>((acc, key) => {
        acc[key] = REDACTED;
        return acc;
    }, {});
}

function isArtifactReference(value: Record<string, unknown>): boolean {
    return value.kind === 'artifact' || value.state === 'artifact_only';
}

function isLocalArtifact(value: Record<string, unknown>): boolean {
    return value.kind === 'artifact_local';
}

function summarizeArtifactReference(value: Record<string, unknown>): ArtifactPreviewEnvelope {
    const id = typeof value.id === 'string'
        ? value.id
        : typeof value.artifactId === 'string'
            ? value.artifactId
            : 'unknown';
    const mimeType = typeof value.mimeType === 'string' ? value.mimeType : undefined;
    const estimatedSize = typeof value.estimatedSize === 'number'
        ? value.estimatedSize
        : typeof value.size === 'number'
            ? value.size
            : undefined;
    return {
        state: 'artifact_only',
        artifactId: id,
        summary: id === 'unknown' ? 'Artifact reference' : `Artifact ${id}`,
        ...(mimeType ? { mimeType } : {}),
        ...(estimatedSize !== undefined ? { estimatedSize } : {}),
    };
}

function summarizeLocalArtifact(value: Record<string, unknown>): ArtifactPreviewEnvelope {
    const mimeType = typeof value.mimeType === 'string' ? value.mimeType : undefined;
    const localValue = value.value;
    let estimatedSize: number | undefined;
    if (typeof localValue === 'string') {
        estimatedSize = localValue.length;
    } else if (localValue !== undefined) {
        try {
            estimatedSize = JSON.stringify(localValue).length;
        } catch {
            estimatedSize = undefined;
        }
    }
    return {
        state: 'artifact_only',
        artifactId: 'local',
        summary: estimatedSize !== undefined
            ? `Local artifact, ${estimatedSize} chars`
            : 'Local artifact',
        ...(mimeType ? { mimeType } : {}),
        ...(estimatedSize !== undefined ? { estimatedSize } : {}),
    };
}

function makeSafeEventPreviewInner(value: unknown, depth: number, parentKey?: string): unknown {
    if (parentKey && isSensitiveKey(parentKey)) {
        return REDACTED;
    }
    if (parentKey && isEnvContainerKey(parentKey)) {
        return summarizeEnvObject(value);
    }

    if (typeof value === 'string') {
        return summarizeLongString(redactSecretLikeString(value));
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (typeof value === 'undefined') {
        return undefined;
    }
    if (typeof value === 'function') {
        return '[function]';
    }
    if (typeof value === 'symbol') {
        return value.toString();
    }

    if (depth >= MAX_DEPTH) {
        if (Array.isArray(value)) return `[truncated array, ${value.length} items]`;
        if (isPlainObject(value)) return `[truncated object, ${Object.keys(value).length} keys]`;
        return String(value);
    }

    if (Array.isArray(value)) {
        const items = value
            .slice(0, MAX_ARRAY_ITEMS)
            .map((item) => makeSafeEventPreviewInner(item, depth + 1));
        if (value.length > MAX_ARRAY_ITEMS) {
            items.push(`... [truncated ${value.length - MAX_ARRAY_ITEMS} items]`);
        }
        return items;
    }

    if (isPlainObject(value)) {
        if (isArtifactReference(value)) {
            return summarizeArtifactReference(value);
        }
        if (isLocalArtifact(value)) {
            return summarizeLocalArtifact(value);
        }
        const output: Record<string, unknown> = {};
        const entries = Object.entries(value);
        for (const [key, item] of entries.slice(0, MAX_OBJECT_KEYS)) {
            output[key] = makeSafeEventPreviewInner(item, depth + 1, key);
        }
        if (entries.length > MAX_OBJECT_KEYS) {
            output.__truncatedKeys = entries.length - MAX_OBJECT_KEYS;
        }
        return output;
    }

    return String(value);
}

export function makeSafeEventPreview(value: unknown): unknown {
    return makeSafeEventPreviewInner(value, 0);
}
