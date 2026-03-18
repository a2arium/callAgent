import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { 
    AgentCard, 
    AgentCardSchema, 
    AgentRuntimeManifest, 
    AgentRuntimeManifestSchema,
    ManifestErrorDetail,
    ManifestSource,
    ManifestResolutionSource,
    ResolvedManifests
} from '@a2arium/callagent-types';
import { ManifestError } from '../utils/errors.js';
import { ZodError } from 'zod';

/**
 * Resolves both Agent Card and Runtime Manifest with precedence, 
 * validation, identity matching, and hashing.
 */
export async function resolveManifests(
  callerDir: string,
  sources: {
    agentCard?: ManifestSource<AgentCard>;
    runtimeManifest?: ManifestSource<AgentRuntimeManifest>;
  }
): Promise<ResolvedManifests> {
  const [resolvedCard, cardSource, cardPath] = await resolveSingleManifest<AgentCard>(
    callerDir,
    sources.agentCard,
    'agent-card.json',
    'agentCard'
  );

  const [resolvedRuntime, runtimeSource, runtimePath] = await resolveSingleManifest<AgentRuntimeManifest>(
    callerDir,
    sources.runtimeManifest,
    'agent-runtime.json',
    'runtimeManifest'
  );

  // 1. Validation (Zod)
  const card = validateManifest(resolvedCard, AgentCardSchema, 'agentCard', cardPath ?? 'inline');
  const runtime = validateManifest(resolvedRuntime, AgentRuntimeManifestSchema, 'runtimeManifest', runtimePath ?? 'inline');

  // 2. Identity Matching (Rule 10)
  if (card.name !== runtime.name || card.version !== runtime.version) {
    throw new ManifestError(
      `Manifest identity mismatch: agent-card.json (${card.name}@${card.version}) and agent-runtime.json (${runtime.name}@${runtime.version}) must match.`,
      {
        type: 'identity_mismatch',
        agentCardName: card.name,
        agentCardVersion: card.version,
        runtimeName: runtime.name,
        runtimeVersion: runtime.version,
      }
    );
  }

  // 3. Hashing (Rule 3)
  const cardHash = generateStableHash(card);
  const runtimeHash = generateStableHash(runtime);

  return {
    agentCard: card,
    agentCardSource: cardSource,
    agentCardHash: cardHash,

    runtimeManifest: runtime,
    runtimeManifestSource: runtimeSource,
    runtimeManifestHash: runtimeHash,
  };
}

/**
 * Resolves a single manifest based on precedence: inline > path > default
 */
async function resolveSingleManifest<T>(
  callerDir: string,
  source: ManifestSource<T> | undefined,
  defaultFilename: string,
  type: 'agentCard' | 'runtimeManifest'
): Promise<[unknown, ManifestResolutionSource, string | null]> {
  // 1. Inline
  if (source && 'inline' in source) {
    return [source.inline, 'inline', null];
  }

  // 2. Path Override
  if (source && 'path' in source) {
    const fullPath = path.resolve(callerDir, source.path);
    const content = await readManifestFile(fullPath, type);
    return [content, 'pathOverride', fullPath];
  }

  // 3. Default Path
  const defaultPath = path.resolve(callerDir, defaultFilename);
  try {
    const content = await readManifestFile(defaultPath, type);
    return [content, 'defaultPath', defaultPath];
  } catch (error) {
    if (error instanceof ManifestError && error.detail?.type === 'file_not_found') {
      // Default file is missing - resolution fails
      throw error;
    }
    throw error;
  }
}

async function readManifestFile(fullPath: string, type: 'agentCard' | 'runtimeManifest'): Promise<unknown> {
  try {
    const json = await fs.readFile(fullPath, 'utf8');
    try {
      return JSON.parse(json);
    } catch (e: any) {
      throw new ManifestError(`Failed to parse ${path.basename(fullPath)}: ${e.message}`, {
        type: 'parse_error',
        path: fullPath,
        manifest: type,
        message: e.message,
      });
    }
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      throw new ManifestError(`Manifest file not found: ${fullPath}`, {
        type: 'file_not_found',
        path: fullPath,
        manifest: type,
      });
    }
    throw error;
  }
}

function validateManifest<T>(
  data: unknown,
  schema: { parse: (data: unknown) => T },
  type: 'agentCard' | 'runtimeManifest',
  sourceInfo: string
): T {
  try {
    return schema.parse(data);
  } catch (error) {
    if (error instanceof ZodError) {
      const zodErr = error as { issues?: Array<{ path?: unknown[]; message?: string; expected?: string; received?: string }> };
      const errorLines = (zodErr.issues ?? []).map((e) => {
        const path = e.path && e.path.length > 0 ? e.path.join('.') : '(root)';
        const details = e.expected && e.received
          ? ` - expected: ${e.expected}, received: ${e.received}`
          : '';
        return `    ${path}: ${e.message}${details}`;
      });

      const formattedErrors = [
        `  ${type} validation errors:`,
        ...errorLines,
      ].join('\n');

      throw new ManifestError(
        `Validation failed for ${type} (${sourceInfo}):\n${formattedErrors}`,
        {
          type: 'schema_validation',
          manifest: type,
          zodError: error,
        } as unknown as ManifestErrorDetail
      );
    }
    throw error;
  }
}

/**
 * Generates a stable SHA-256 hash by sorting keys
 */
function generateStableHash(data: any): string {
  const stableString = JSON.stringify(data, Object.keys(data).sort());
  return crypto.createHash('sha256').update(stableString).digest('hex').slice(0, 12);
}
