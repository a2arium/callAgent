// Minimal input sanitization to reduce prompt-injection/string exploit surface.
// This is intentionally lightweight and can be overridden by agents.

export function sanitizeObservation<T = unknown>(obs: T): T {
    try {
        if (typeof obs === 'string') {
            return sanitizeString(obs) as unknown as T;
        }
        if (Array.isArray(obs)) {
            return obs.map(sanitizeObservation) as unknown as T;
        }
        if (obs && typeof obs === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(obs as Record<string, unknown>)) {
                out[k] = sanitizeObservation(v);
            }
            return out as unknown as T;
        }
        return obs;
    } catch {
        return obs;
    }
}

function sanitizeString(s: string): string {
    let out = s;
    // Remove common HTML/script tags
    out = out.replace(/<\/?script[^>]*>/gi, '');
    out = out.replace(/<\/?style[^>]*>/gi, '');
    // Neutralize HTML comments often used in injections
    out = out.replace(/<!--([\s\S]*?)-->/g, '[comment]');
    // Strip data URLs in simple form
    out = out.replace(/data:[^;]+;base64,[a-z0-9+/=]+/gi, '[data-url]');
    // Collapse excessive control characters
    out = out.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]+/g, ' ');
    return out;
}


