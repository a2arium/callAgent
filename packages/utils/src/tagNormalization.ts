import { SemanticQueryError } from '@a2arium/callagent-types';

export const SEMANTIC_TAG_LIMITS = {
    maxStoredTagsPerItem: 64,
    maxRawQueryTagInputs: 64,
    maxRequiredQueryTags: 32,
    maxNormalizedTagBytes: 256,
    defaultQueryLimit: 1_000,
    maxQueryLimit: 10_000,
} as const;

export type SemanticTagLimits = typeof SEMANTIC_TAG_LIMITS;

export type NormalizedRequiredTags = {
    requiredTags: string[];
    suppliedTagCount: number;
};

function normalizeAndValidateTag(tag: string, maxBytes: number): string {
    const normalized = tag.trim().toLowerCase();
    if (Buffer.byteLength(normalized, 'utf8') > maxBytes) {
        throw new SemanticQueryError('SEMANTIC_TAG_TOO_LONG', 'Normalized semantic-memory tag exceeds the byte limit', {
            details: { maxNormalizedTagBytes: maxBytes },
        });
    }
    return normalized;
}

function assertString(value: unknown): asserts value is string {
    if (typeof value !== 'string') {
        throw new SemanticQueryError('SEMANTIC_TAG_INVALID_TYPE', 'Semantic-memory tags must be strings');
    }
}

export function normalizeRequiredTags(
    input: { tag?: unknown; tags?: unknown },
    limits: SemanticTagLimits = SEMANTIC_TAG_LIMITS
): NormalizedRequiredTags {
    const hasTag = Object.prototype.hasOwnProperty.call(input, 'tag') && input.tag !== undefined;
    const hasTags = Object.prototype.hasOwnProperty.call(input, 'tags') && input.tags !== undefined;

    if (hasTag) assertString(input.tag);
    if (hasTags && !Array.isArray(input.tags)) {
        throw new SemanticQueryError('SEMANTIC_TAG_INVALID_TYPE', 'Semantic-memory tags must be an array of strings');
    }

    const plural = hasTags ? input.tags as unknown[] : [];
    const suppliedTagCount = (hasTag ? 1 : 0) + plural.length;
    if (suppliedTagCount > limits.maxRawQueryTagInputs) {
        throw new SemanticQueryError('SEMANTIC_TAG_COUNT_EXCEEDED', 'Semantic-memory query has too many tag inputs', {
            details: { suppliedTagCount, maxRawQueryTagInputs: limits.maxRawQueryTagInputs },
        });
    }

    const normalized: string[] = [];
    const seen = new Set<string>();
    const append = (raw: unknown, singular: boolean): void => {
        assertString(raw);
        const tag = normalizeAndValidateTag(raw, limits.maxNormalizedTagBytes);
        if (!tag) {
            if (singular) {
                throw new SemanticQueryError('SEMANTIC_TAG_EMPTY', 'Semantic-memory tag cannot be empty');
            }
            return;
        }
        if (!seen.has(tag)) {
            seen.add(tag);
            normalized.push(tag);
        }
    };

    if (hasTag) append(input.tag, true);
    for (const tag of plural) append(tag, false);

    if (hasTags && plural.length > 0 && normalized.length === 0) {
        throw new SemanticQueryError('SEMANTIC_TAG_EMPTY', 'Semantic-memory tag array cannot contain only empty tags');
    }
    if (normalized.length > limits.maxRequiredQueryTags) {
        throw new SemanticQueryError('SEMANTIC_TAG_COUNT_EXCEEDED', 'Semantic-memory query has too many distinct tags', {
            details: { requiredTagCount: normalized.length, maxRequiredQueryTags: limits.maxRequiredQueryTags },
        });
    }

    return { requiredTags: normalized, suppliedTagCount };
}

export function normalizeStoredTags(
    tags: unknown,
    limits: SemanticTagLimits = SEMANTIC_TAG_LIMITS
): string[] {
    if (tags === undefined) return [];
    if (!Array.isArray(tags)) {
        throw new SemanticQueryError('SEMANTIC_TAG_INVALID_TYPE', 'Stored semantic-memory tags must be an array of strings');
    }
    if (tags.length > limits.maxStoredTagsPerItem) {
        throw new SemanticQueryError('SEMANTIC_TAG_COUNT_EXCEEDED', 'Semantic-memory item has too many stored tags', {
            details: { suppliedTagCount: tags.length, maxStoredTagsPerItem: limits.maxStoredTagsPerItem },
        });
    }
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const raw of tags) {
        assertString(raw);
        const tag = normalizeAndValidateTag(raw, limits.maxNormalizedTagBytes);
        if (tag && !seen.has(tag)) {
            seen.add(tag);
            normalized.push(tag);
        }
    }
    return normalized;
}

/** Simple compatibility facade for lowercase-and-trim normalization. */
export class TagNormalizer {
    /**
     * Normalize a single tag to lowercase and trim whitespace
     */
    static normalize(tag: string): string {
        return tag.trim().toLowerCase();
    }

    /**
     * Normalize an array of tags, removing duplicates and empties
     */
    static normalizeTags(tags: string[]): string[] {
        return tags
            .filter(tag => typeof tag === 'string' && tag.trim().length > 0)
            .map(tag => TagNormalizer.normalize(tag))
            .filter((tag, index, arr) => arr.indexOf(tag) === index);
    }
}
