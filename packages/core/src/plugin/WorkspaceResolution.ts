import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { AgentCardSchema, AgentRuntimeManifestSchema } from '@a2arium/callagent-types';
import { DEFAULT_AGENT_INDEX_PATH } from './AgentIndexBuilder.js';

export const DEFAULT_WORKSPACE_REGISTRY_PATH = '.callagent/workspaces.json';
export const DEFAULT_WORKSPACE_ENV_FILE = '.env';

export type WorkspaceResolutionIssue = {
    code: string;
    message: string;
    path?: string;
};

export class WorkspaceResolutionError extends Error {
    public readonly issues: WorkspaceResolutionIssue[];

    public constructor(message: string, issues: WorkspaceResolutionIssue[]) {
        super(message);
        this.name = 'WorkspaceResolutionError';
        this.issues = issues;
    }
}

export type ResolvedAgentSource = {
    name: string;
    root: string;
    agentIndexPath: string;
    envFilePath: string;
};

export type ResolvedWorkspaceAgent = {
    id: string;
    sourceName: string;
    modulePath: string;
    agentCardPath?: string;
    runtimeManifestPath?: string;
    digests: {
        module: string;
        agentCard?: string;
        runtimeManifest?: string;
    };
};

export type WorkspaceEnvironmentConflict = {
    key: string;
    keptSource: string;
    ignoredSource: string;
};

export type WorkspaceEnvironmentMetadata = {
    keys: Array<{ key: string; source: string }>;
    conflicts: WorkspaceEnvironmentConflict[];
};

export type ResolvedWorkspaceEnvironment = WorkspaceEnvironmentMetadata & {
    /** Process-ready values. Do not serialize this object into a runtime descriptor. */
    values: Record<string, string>;
};

export type RuntimeWorkspaceDescriptor = {
    schemaVersion: 1;
    registryPath: string;
    invocationCwd: string;
    workspaces: Array<ResolvedAgentSource & {
        indexDigest: string;
        agents: ResolvedWorkspaceAgent[];
    }>;
    environment: WorkspaceEnvironmentMetadata;
    fingerprint: string;
};

export type ResolveWorkspaceOptions = {
    cwd?: string;
    registryPath?: string;
    inheritedEnv?: NodeJS.ProcessEnv;
    allowEmpty?: boolean;
};

type WorkspaceRegistryEntry = {
    name: string;
    root: string;
    agentIndex?: string;
    envFile?: string;
};

type AgentIndexEntry = {
    module: string;
    agentCard?: string;
    runtimeManifest?: string;
};

/**
 * Resolves a CallAgent workspace without importing agent modules or mutating process.env.
 * The returned environment values are intentionally separate from the serializable descriptor.
 */
export async function resolveWorkspaceRuntime(
    options: ResolveWorkspaceOptions = {}
): Promise<{ descriptor: RuntimeWorkspaceDescriptor; environment: ResolvedWorkspaceEnvironment }> {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const registryPath = await resolveRegistryPath(options.registryPath ?? process.env.CALLAGENT_WORKSPACES, cwd);
    const registry = await readRegistry(registryPath);
    const sources = resolveSources(registry, registryPath);

    if (!options.allowEmpty && sources.length === 0) {
        throw new WorkspaceResolutionError('Workspace registry has no agent sources', [{
            code: 'empty_workspace',
            message: `Add an agent source to ${registryPath} before starting the runtime.`,
            path: registryPath,
        }]);
    }

    const environment = await resolveWorkspaceEnvironment({
        workspaceRoot: path.dirname(path.dirname(registryPath)),
        sources,
        inheritedEnv: options.inheritedEnv,
    });
    const workspaces = await resolveAgents(sources);
    const descriptorWithoutFingerprint = {
        schemaVersion: 1 as const,
        registryPath,
        invocationCwd: cwd,
        workspaces,
        environment: environmentMetadata(environment),
    };

    return {
        descriptor: {
            ...descriptorWithoutFingerprint,
            fingerprint: workspaceDescriptorFingerprint(descriptorWithoutFingerprint),
        },
        environment,
    };
}

export async function resolveWorkspaceEnvironment(options: {
    workspaceRoot: string;
    sources: ResolvedAgentSource[];
    inheritedEnv?: NodeJS.ProcessEnv;
}): Promise<ResolvedWorkspaceEnvironment> {
    const values: Record<string, string> = {};
    const owners = new Map<string, string>();
    const conflicts: WorkspaceEnvironmentConflict[] = [];

    for (const [key, value] of Object.entries(options.inheritedEnv ?? process.env)) {
        if (typeof value === 'string') {
            values[key] = value;
            owners.set(key, 'process');
        }
    }

    await mergeEnvFile({
        source: 'workspace',
        filePath: path.join(options.workspaceRoot, DEFAULT_WORKSPACE_ENV_FILE),
        values,
        owners,
        conflicts,
    });
    for (const agentSource of options.sources) {
        await mergeEnvFile({
            source: `agent-source:${agentSource.name}`,
            filePath: agentSource.envFilePath,
            values,
            owners,
            conflicts,
        });
    }

    return {
        values,
        keys: Array.from(owners.entries())
            .map(([key, source]) => ({ key, source }))
            .sort((left, right) => left.key.localeCompare(right.key)),
        conflicts,
    };
}

function environmentMetadata(environment: ResolvedWorkspaceEnvironment): WorkspaceEnvironmentMetadata {
    return {
        keys: environment.keys,
        conflicts: environment.conflicts,
    };
}

async function resolveRegistryPath(requestedPath: string | undefined, cwd: string): Promise<string> {
    const requested = requestedPath ?? DEFAULT_WORKSPACE_REGISTRY_PATH;
    if (path.isAbsolute(requested)) return path.resolve(requested);

    let candidateDir = cwd;
    while (true) {
        const candidate = path.join(candidateDir, requested);
        if (await exists(candidate)) return candidate;
        const parent = path.dirname(candidateDir);
        if (parent === candidateDir) return path.resolve(cwd, requested);
        candidateDir = parent;
    }
}

async function readRegistry(registryPath: string): Promise<WorkspaceRegistryEntry[]> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(await fs.readFile(registryPath, 'utf8'));
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new WorkspaceResolutionError(`Cannot read workspace registry: ${registryPath}`, [{
            code: 'invalid_registry', message: detail, path: registryPath,
        }]);
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.workspaces) || Object.keys(parsed).some((key) => key !== 'workspaces')) {
        throw invalid('Workspace registry must be an object with only a workspaces array', registryPath);
    }

    const names = new Set<string>();
    return parsed.workspaces.map((value, index) => {
        const entryPath = `${registryPath}:workspaces[${index}]`;
        if (!isRecord(value) || Object.keys(value).some((key) => !['name', 'root', 'agentIndex', 'envFile'].includes(key))) {
            throw invalid('Workspace entry contains unsupported fields', entryPath);
        }
        const name = requiredString(value.name, 'name', entryPath);
        if (names.has(name)) throw invalid(`Agent-source name "${name}" is duplicated`, entryPath);
        names.add(name);
        const root = requiredString(value.root, 'root', entryPath);
        return {
            name,
            root,
            ...(value.agentIndex === undefined ? {} : { agentIndex: requiredString(value.agentIndex, 'agentIndex', entryPath) }),
            ...(value.envFile === undefined ? {} : { envFile: requiredString(value.envFile, 'envFile', entryPath) }),
        };
    });
}

function resolveSources(entries: WorkspaceRegistryEntry[], registryPath: string): ResolvedAgentSource[] {
    const registryDir = path.dirname(registryPath);
    return entries.map((entry) => {
        const root = path.resolve(registryDir, entry.root);
        return {
            name: entry.name,
            root,
            agentIndexPath: path.resolve(root, entry.agentIndex ?? DEFAULT_AGENT_INDEX_PATH),
            envFilePath: path.resolve(root, entry.envFile ?? DEFAULT_WORKSPACE_ENV_FILE),
        };
    });
}

async function resolveAgents(sources: ResolvedAgentSource[]): Promise<RuntimeWorkspaceDescriptor['workspaces']> {
    const agentIds = new Set<string>();
    const workspaces: RuntimeWorkspaceDescriptor['workspaces'] = [];
    for (const source of sources) {
        const entries = await readAgentIndex(source);
        const agents: ResolvedWorkspaceAgent[] = [];
        for (const [id, entry] of Object.entries(entries)) {
            if (agentIds.has(id)) throw invalid(`Agent id "${id}" is present in more than one agent source`, source.agentIndexPath);
            agentIds.add(id);
            agents.push(await resolveAgent(source, id, entry));
        }
        workspaces.push({
            ...source,
            indexDigest: await digestFile(source.agentIndexPath, 'agent index'),
            agents: agents.sort((left, right) => left.id.localeCompare(right.id)),
        });
    }
    return workspaces.sort((left, right) => left.name.localeCompare(right.name));
}

async function readAgentIndex(source: ResolvedAgentSource): Promise<Record<string, AgentIndexEntry>> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(await fs.readFile(source.agentIndexPath, 'utf8'));
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new WorkspaceResolutionError(`Cannot read agent index for source "${source.name}"`, [{
            code: 'invalid_agent_index', message: detail, path: source.agentIndexPath,
        }]);
    }
    if (!isRecord(parsed) || Object.keys(parsed).length === 0) throw invalid('Agent index must be a non-empty object', source.agentIndexPath);
    const result: Record<string, AgentIndexEntry> = {};
    for (const [id, value] of Object.entries(parsed)) {
        if (!id.trim()) throw invalid('Agent index id cannot be empty', source.agentIndexPath);
        if (typeof value === 'string') {
            result[id] = { module: requiredString(value, 'module', source.agentIndexPath) };
            continue;
        }
        if (!isRecord(value) || Object.keys(value).some((key) => !['module', 'agentCard', 'runtimeManifest'].includes(key))) {
            throw invalid(`Agent index entry "${id}" contains unsupported fields`, source.agentIndexPath);
        }
        result[id] = {
            module: requiredString(value.module, 'module', source.agentIndexPath),
            ...(value.agentCard === undefined ? {} : { agentCard: requiredString(value.agentCard, 'agentCard', source.agentIndexPath) }),
            ...(value.runtimeManifest === undefined ? {} : { runtimeManifest: requiredString(value.runtimeManifest, 'runtimeManifest', source.agentIndexPath) }),
        };
    }
    return result;
}

async function resolveAgent(source: ResolvedAgentSource, id: string, entry: AgentIndexEntry): Promise<ResolvedWorkspaceAgent> {
    const indexDir = path.dirname(source.agentIndexPath);
    const modulePath = path.resolve(indexDir, entry.module);
    const agentCardPath = entry.agentCard ? path.resolve(indexDir, entry.agentCard) : undefined;
    const runtimeManifestPath = entry.runtimeManifest ? path.resolve(indexDir, entry.runtimeManifest) : undefined;
    const module = await digestFile(modulePath, 'module');
    const card = agentCardPath ? await readJson(agentCardPath, 'agent card') : undefined;
    const manifest = runtimeManifestPath ? await readJson(runtimeManifestPath, 'runtime manifest') : undefined;

    if (card) {
        const parsed = AgentCardSchema.safeParse(card.value);
        if (!parsed.success) throw invalid(`Agent card for "${id}" is invalid: ${parsed.error.issues[0]?.message ?? 'unknown error'}`, agentCardPath!);
        if (parsed.data.name !== id) throw invalid(`Agent index id "${id}" does not match AgentCard.name "${parsed.data.name}"`, agentCardPath!);
    }
    if (manifest) {
        const parsed = AgentRuntimeManifestSchema.safeParse(manifest.value);
        if (!parsed.success) throw invalid(`Runtime manifest for "${id}" is invalid: ${parsed.error.issues[0]?.message ?? 'unknown error'}`, runtimeManifestPath!);
        if (parsed.data.name !== id) throw invalid(`Agent index id "${id}" does not match runtime manifest name "${parsed.data.name}"`, runtimeManifestPath!);
    }
    if (card && manifest) {
        const cardValue = AgentCardSchema.parse(card.value);
        const manifestValue = AgentRuntimeManifestSchema.parse(manifest.value);
        if (cardValue.version !== manifestValue.version) throw invalid(`Agent "${id}" has different card and runtime-manifest versions`, runtimeManifestPath!);
    }

    return {
        id,
        sourceName: source.name,
        modulePath,
        ...(agentCardPath ? { agentCardPath } : {}),
        ...(runtimeManifestPath ? { runtimeManifestPath } : {}),
        digests: {
            module,
            ...(card ? { agentCard: card.digest } : {}),
            ...(manifest ? { runtimeManifest: manifest.digest } : {}),
        },
    };
}

async function mergeEnvFile(params: {
    source: string;
    filePath: string;
    values: Record<string, string>;
    owners: Map<string, string>;
    conflicts: WorkspaceEnvironmentConflict[];
}): Promise<void> {
    let raw: string;
    try {
        raw = await fs.readFile(params.filePath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
    }
    const parsed = parseDotenv(raw);
    const keys = Object.keys(parsed).sort();
    for (const key of keys) {
        const value = parsed[key]!;
        const keptSource = params.owners.get(key);
        if (keptSource) {
            params.conflicts.push({ key, keptSource, ignoredSource: params.source });
            continue;
        }
        params.values[key] = value;
        params.owners.set(key, params.source);
    }
}

async function readJson(filePath: string, label: string): Promise<{ value: unknown; digest: string }> {
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        return { value: JSON.parse(raw), digest: hash(raw) };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw invalid(`Cannot read ${label}: ${detail}`, filePath);
    }
}

async function digestFile(filePath: string, label: string): Promise<string> {
    try {
        return hash(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw invalid(`Cannot read ${label}: ${detail}`, filePath);
    }
}

function invalid(message: string, filePath: string): WorkspaceResolutionError {
    return new WorkspaceResolutionError(message, [{ code: 'validation_error', message, path: filePath }]);
}

function requiredString(value: unknown, key: string, entryPath: string): string {
    if (typeof value !== 'string' || !value.trim()) throw invalid(`Workspace field "${key}" must be a non-empty string`, entryPath);
    return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function exists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

export function workspaceDescriptorFingerprint(value: Omit<RuntimeWorkspaceDescriptor, 'fingerprint'>): string {
    return hash(JSON.stringify(value));
}

function hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}
