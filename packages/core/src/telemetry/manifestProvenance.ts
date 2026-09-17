import type { z } from 'zod';
import { createHash } from 'node:crypto';
import type { ManifestProvenance, ManifestSource } from '../types/turnTrace.js';
import {
    AgentCardSchema,
    AgentRuntimeManifestSchema,
} from '@a2arium/callagent-types';

type AgentCard = z.infer<typeof AgentCardSchema>;
type AgentRuntimeManifest = z.infer<typeof AgentRuntimeManifestSchema>;

export type ManifestResolutionInput = {
    agentCard?: { source: ManifestSource; content: AgentCard };
    runtimeManifest?: { source: ManifestSource; content: AgentRuntimeManifest };
};

/**
 * Canonicalize a value to a stable JSON string (sorted keys, no extra whitespace).
 */
export function canonicalize(obj: unknown, seen = new WeakSet<object>()): string {
    if (obj === null || typeof obj !== 'object') {
        return JSON.stringify(obj) ?? JSON.stringify(String(obj));
    }
    if (Array.isArray(obj)) {
        if (seen.has(obj)) return '"[Circular]"';
        seen.add(obj);
        try {
            return '[' + obj.map((item) => canonicalize(item, seen)).join(',') + ']';
        } finally {
            seen.delete(obj);
        }
    }
    if (seen.has(obj)) return '"[Circular]"';
    seen.add(obj);

    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
        seen.delete(obj);
        return JSON.stringify(Object.prototype.toString.call(obj));
    }

    const keys = Object.keys(obj as Record<string, unknown>).sort();
    try {
        const pairs = keys.map(
            (k) =>
                JSON.stringify(k) +
                ':' +
                canonicalize((obj as Record<string, unknown>)[k], seen)
        );
        return '{' + pairs.join(',') + '}';
    } finally {
        seen.delete(obj);
    }
}

/**
 * Compute a stable SHA-256 hash of an object (canonical JSON).
 * Stable under whitespace and key order changes.
 */
export function computeStableHash(
    obj: AgentCard | AgentRuntimeManifest | Record<string, unknown>
): string {
    const str = canonicalize(obj);
    return createHash('sha256').update(str, 'utf8').digest('hex');
}

/** Minimal shape required for identity match (avoids Zod version mismatch with callagent-types). */
type ManifestIdentity = { name: string; version: string };

/**
 * Validate that Agent Card name and version match Runtime Manifest.
 * Throws a structured error if mismatch.
 */
export function validateManifestIdentity(
    agentCard: ManifestIdentity,
    runtimeManifest: ManifestIdentity
): void {
    if (agentCard.name !== runtimeManifest.name) {
        throw new Error(
            `Manifest identity mismatch: agentCard.name "${agentCard.name}" !== runtimeManifest.name "${runtimeManifest.name}"`
        );
    }
    if (agentCard.version !== runtimeManifest.version) {
        throw new Error(
            `Manifest identity mismatch: agentCard.version "${agentCard.version}" !== runtimeManifest.version "${runtimeManifest.version}"`
        );
    }
}

/**
 * Resolve manifest provenance from resolved card and runtime manifest.
 * Computes stable hashes and validates identity match.
 */
export function resolveManifestProvenance(
    input: ManifestResolutionInput
): ManifestProvenance {
    const agentCardSource: ManifestSource = input.agentCard?.source ?? 'inline';
    const runtimeManifestSource: ManifestSource =
        input.runtimeManifest?.source ?? 'inline';

    let agentCardHash = '';
    let runtimeManifestHash = '';

    if (input.agentCard?.content) {
        agentCardHash = computeStableHash(
            input.agentCard.content as AgentCard
        );
    }
    if (input.runtimeManifest?.content) {
        runtimeManifestHash = computeStableHash(
            input.runtimeManifest.content as AgentRuntimeManifest
        );
    }

    if (input.agentCard?.content && input.runtimeManifest?.content) {
        validateManifestIdentity(
            input.agentCard.content as ManifestIdentity,
            input.runtimeManifest.content as ManifestIdentity
        );
    }

    return {
        agentCardSource,
        runtimeManifestSource,
        agentCardHash,
        runtimeManifestHash,
    };
}
