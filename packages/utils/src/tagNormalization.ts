/**
 * Simple tag normalization - always lowercase and trim
 */
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
            .filter((tag, index, arr) => arr.indexOf(tag) === index); // Remove duplicates
    }
} 