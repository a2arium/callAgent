
/**
 * Utility for manipulating nested query paths (e.g. "a.b[0].c") safely and immutably.
 */
export class PathUtils {
    /**
     * Set a value at a nested path, returning a NEW object (immutable).
     * Arrays are preserved if the path indicates an index.
     */
    static setPathImmutable(
        obj: Record<string, unknown> | undefined,
        path: string,
        value: unknown
    ): Record<string, unknown> {
        if (!obj) obj = {};
        if (!path) return { ...obj };

        const parts = path.split('.');
        const head = parts[0];
        const tail = parts.slice(1).join('.');

        // Handle array-like keys if needed, for now assuming simple dot notation or pre-split
        // The previous implementation splits by '.' so we stick to that contract.

        // Deep clone the current level to maintain immutability
        const next = Array.isArray(obj) ? [...obj] : { ...obj };

        if (parts.length === 1) {
            if (value === undefined) {
                delete (next as any)[head];
            } else {
                (next as any)[head] = value;
            }
            return next as Record<string, unknown>;
        }

        // Recursion
        const currentChild = (next as any)[head];
        const nextChild = PathUtils.setPathImmutable(
            (typeof currentChild === 'object' ? currentChild : {}) as Record<string, unknown>,
            tail,
            value
        );

        (next as any)[head] = nextChild;
        return next as Record<string, unknown>;
    }

    /**
     * Get a value at a nested path.
     */
    static getPath(obj: Record<string, unknown> | undefined, path: string): unknown {
        if (!obj || !path) return undefined;
        const parts = path.split('.');
        let current: any = obj;
        for (const part of parts) {
            if (current === undefined || current === null) return undefined;
            current = current[part];
        }
        return current;
    }

    /**
     * Delete a value at a nested path (immutable).
     */
    static deletePathImmutable(
        obj: Record<string, unknown> | undefined,
        path: string
    ): Record<string, unknown> {
        return PathUtils.setPathImmutable(obj, path, undefined);
    }
}
