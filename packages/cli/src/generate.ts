import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveWorkspaceRuntime, scaffoldAgent } from '@a2arium/callagent-core';

type Preset = 'minimal' | 'non-trivial';
type GenerateOptions = { output?: string; project?: string; withAgent?: string; preset?: Preset; force?: boolean; usesLlm?: boolean; usesTools?: boolean; usesChildren?: boolean; usesPlans?: boolean; agentSources?: string[]; packageManager?: string; name?: string; envFile?: string; workspaces?: string };
type Registry = { workspaces: Array<{ name: string; root: string; agentIndex?: string; envFile?: string }> };

export async function createAgentProject(name: string, options: GenerateOptions): Promise<{ output: string; agent?: string }> {
    assertName(name);
    const output = path.resolve(options.output ?? name);
    const created = await prepareEmptyDirectory(output, options.force);
    try {
        const deps = { '@a2arium/callagent-core': '^0.3.0', '@a2arium/callagent-types': '^0.2.0' };
        await write(output, 'package.json', JSON.stringify({ name, version: '0.1.0', private: true, type: 'module', scripts: { build: 'tsc -p tsconfig.json && node scripts/copy-agent-assets.mjs', test: 'jest --config jest.config.mjs' }, dependencies: deps, devDependencies: { typescript: '^5.8.3', jest: '^29.7.0' } }, null, 2) + '\n');
        await write(output, 'tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'nodenext', moduleResolution: 'nodenext', strict: true, esModuleInterop: true, skipLibCheck: true, outDir: 'dist', rootDir: 'src', declaration: true }, include: ['src'], exclude: ['node_modules', 'dist', 'tests', 'src/**/tests'] }, null, 2) + '\n');
        await write(output, '.callagent/agent-paths.json', '{\n  \n}\n');
        await write(output, 'jest.config.mjs', `export default { testEnvironment: 'node', transform: {} };\n`);
        await write(output, 'scripts/copy-agent-assets.mjs', `import { cp, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
const source = path.resolve('src/agents');
const target = path.resolve('dist/agents');
async function visit(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const from = path.join(dir, entry.name);
    if (entry.isDirectory()) await visit(from);
    if (entry.isFile() && (entry.name === 'agent-card.json' || entry.name === 'agent-runtime.json')) {
      const to = path.join(target, path.relative(source, from));
      await mkdir(path.dirname(to), { recursive: true });
      await cp(from, to);
    }
  }
}
await visit(source);
`);
        await fs.mkdir(path.join(output, 'src', 'agents'), { recursive: true });
        await fs.mkdir(path.join(output, 'tests', 'agents'), { recursive: true });
        if (options.withAgent) {
            const { output: _output, ...agentOptions } = options;
            await createAgent(options.withAgent, { ...agentOptions, project: output });
        }
        return { output, ...(options.withAgent ? { agent: options.withAgent } : {}) };
    } catch (error) {
        if (created) await fs.rm(output, { recursive: true, force: true });
        throw error;
    }
}

export async function createAgent(name: string, options: GenerateOptions): Promise<{ output: string; project: string }> {
    assertName(name);
    const project = await findProject(path.resolve(options.project ?? process.cwd()));
    const indexPath = path.join(project, '.callagent', 'agent-paths.json');
    const index = await readRegistryIndex(indexPath);
    if (index[name]) throw new Error(`Agent "${name}" already exists in ${project}`);
    if (await exists(path.join(project, 'agent.ts')) && !(await exists(path.join(project, 'src', 'agents')))) {
        throw new Error(`Agent project uses the legacy flat layout: ${project}. Migrate it before adding another agent.`);
    }
    const output = path.resolve(project, options.output ?? path.join('src', 'agents', name));
    if (output !== project && !output.startsWith(`${project}${path.sep}`)) throw new Error('Agent output must be inside its agent project');
    const created = !(await exists(output));
    try {
        await scaffoldAgent({ name, preset: options.preset ?? 'minimal', outputDir: output, force: options.force, monorepo: false, usesLlm: options.usesLlm, usesTools: options.usesTools, usesChildren: options.usesChildren, usesPlans: options.usesPlans });
        await Promise.all(['package.json', 'tsconfig.json'].map(async (file) => fs.rm(path.join(output, file), { force: true })));
        const distModule = path.relative(project, path.join(project, 'dist', 'agents', name, 'agent.js')).split(path.sep).join('/');
        const distAgentRoot = distModule.slice(0, -'agent.js'.length);
        index[name] = { module: `../${distModule}`, agentCard: `../${distAgentRoot}agent-card.json`, runtimeManifest: `../${distAgentRoot}agent-runtime.json` };
        await atomicJson(indexPath, index);
        return { output, project };
    } catch (error) {
        if (created) await fs.rm(output, { recursive: true, force: true });
        throw error;
    }
}

export async function createWorkspace(name: string, options: GenerateOptions): Promise<{ output: string; sources: string[] }> {
    assertName(name);
    const output = path.resolve(options.output ?? name);
    const created = await prepareEmptyDirectory(output, options.force);
    try {
    const registryPath = path.join(output, '.callagent', 'workspaces.json');
    const packageRanges = { cli: '^0.1.0', runtime: '^0.1.0' };
    await write(output, 'package.json', JSON.stringify({ name, private: true, scripts: { start: 'callagent start', dev: 'callagent start', validate: 'callagent workspace validate', agents: 'callagent agents list', 'db:setup': 'callagent db setup', 'db:migrate': 'callagent db migrate', 'infra:up': 'callagent infra up', 'infra:down': 'callagent infra down', 'infra:restart': 'callagent infra restart' }, devDependencies: { '@a2arium/callagent-cli': packageRanges.cli }, dependencies: { '@a2arium/callagent-runtime': packageRanges.runtime } }, null, 2) + '\n');
    await write(output, '.env.example', `# Shared runtime infrastructure\nMEMORY_DATABASE_URL=postgres://callagent:callagent@localhost:5432/callagent\nNATS_URL=nats://localhost:4222\n\n# Hatchet (create an API token at http://127.0.0.1:8080 for the local POC)\nCALLAGENT_OUTBOX_DISPATCHER=hatchet\nHATCHET_CLIENT_TOKEN=replace-with-hatchet-api-token\nHATCHET_CLIENT_HOST_PORT=localhost:7077\nHATCHET_CLIENT_TLS_STRATEGY=none\n# Change this when another local project already uses 8080.\nHATCHET_DASHBOARD_PORT=8080\nHATCHET_DASHBOARD_URL=http://127.0.0.1:8080\nHATCHET_DASHBOARD_TENANT_ID=707d0855-80ab-4e1f-a156-f1c4546cbf52\n\n# Observer authentication\nCALLAGENT_PUBLIC_URL=http://127.0.0.1:8790\nBETTER_AUTH_SECRET=replace-with-at-least-32-random-characters\nCALLAGENT_OPERATOR_ENABLED=true\nCALLAGENT_OPERATOR_BOOTSTRAP_EMAIL=admin@callagent.local\nCALLAGENT_OPERATOR_BOOTSTRAP_TENANT_ID=default\n# Optional: set a known first-login password; otherwise one is printed once at startup.\n# CALLAGENT_OPERATOR_BOOTSTRAP_PASSWORD=\n`);
    await write(output, '.gitignore', '.env\n.callagent/runtime/\n');
    await write(output, 'README.md', workspaceReadme(name));
    await atomicJson(registryPath, { workspaces: [] });
    for (const source of options.agentSources ?? []) await addAgentSource(source, { workspaces: registryPath });
    return { output, sources: (options.agentSources ?? []).map((source) => path.resolve(source)) };
    } catch (error) {
        if (created) await fs.rm(output, { recursive: true, force: true });
        throw error;
    }
}

export async function addAgentSource(sourceArg: string, options: GenerateOptions): Promise<{ registryPath: string; name: string; agents: string[] }> {
    const registryPath = await findRegistry(options.workspaces);
    const registry = await readRegistry(registryPath);
    const source = path.resolve(process.cwd(), sourceArg);
    const sourceIndex = path.join(source, '.callagent', 'agent-paths.json');
    const agents = Object.keys(await readRegistryIndex(sourceIndex));
    if (agents.length === 0) throw new Error(`Agent source has no agents: ${source}`);
    const name = options.name ?? await sourceName(source);
    if (registry.workspaces.some((entry) => entry.name === name)) throw new Error(`Agent-source name already exists: ${name}`);
    const existingIds = new Set<string>();
    for (const entry of registry.workspaces) for (const id of Object.keys(await readRegistryIndex(path.resolve(path.dirname(registryPath), entry.root, entry.agentIndex ?? '.callagent/agent-paths.json')))) existingIds.add(id);
    const duplicate = agents.find((id) => existingIds.has(id));
    if (duplicate) throw new Error(`Agent id already selected by this workspace: ${duplicate}`);
    registry.workspaces.push({ name, root: portable(path.dirname(registryPath), source), agentIndex: '.callagent/agent-paths.json', ...(options.envFile ? { envFile: options.envFile } : {}) });
    registry.workspaces.sort((left, right) => left.name.localeCompare(right.name));
    await validateCandidateRegistry(registryPath, registry);
    await atomicJson(registryPath, registry);
    return { registryPath, name, agents: agents.sort() };
}

export async function removeAgentSource(name: string, options: GenerateOptions): Promise<{ registryPath: string; name: string }> {
    const registryPath = await findRegistry(options.workspaces);
    const registry = await readRegistry(registryPath);
    const remaining = registry.workspaces.filter((entry) => entry.name !== name);
    if (remaining.length === registry.workspaces.length) throw new Error(`Agent source not found: ${name}`);
    await validateCandidateRegistry(registryPath, { workspaces: remaining });
    await atomicJson(registryPath, { workspaces: remaining });
    return { registryPath, name };
}

async function findProject(start: string): Promise<string> { let current = start; while (true) { try { await fs.access(path.join(current, '.callagent', 'agent-paths.json')); return current; } catch { const parent = path.dirname(current); if (parent === current) throw new Error('No agent project found; pass --project <dir>'); current = parent; } } }
async function findRegistry(requested?: string): Promise<string> { if (requested) return path.resolve(process.cwd(), requested); let current = process.cwd(); while (true) { const candidate = path.join(current, '.callagent', 'workspaces.json'); try { await fs.access(candidate); return candidate; } catch { const parent = path.dirname(current); if (parent === current) throw new Error('No CallAgent workspace found; pass --workspaces <path>'); current = parent; } } }
async function prepareEmptyDirectory(output: string, _force?: boolean): Promise<boolean> { try { const entries = await fs.readdir(output); if (entries.length) throw new Error(`Output exists and is not empty: ${output}. Refusing to overwrite files; choose a new output directory.`); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await fs.mkdir(output, { recursive: true }); return true; } }
async function write(root: string, relative: string, content: string): Promise<void> { const target = path.join(root, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content, 'utf8'); }
async function exists(file: string): Promise<boolean> { try { await fs.access(file); return true; } catch { return false; } }
async function readRegistryIndex(file: string): Promise<Record<string, unknown>> { try { const value = JSON.parse(await fs.readFile(file, 'utf8')) as unknown; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object'); return value as Record<string, unknown>; } catch { throw new Error(`Invalid or missing agent index: ${file}`); } }
async function readRegistry(file: string): Promise<Registry> { try { const value = JSON.parse(await fs.readFile(file, 'utf8')) as unknown; if (!value || typeof value !== 'object' || !Array.isArray((value as Registry).workspaces)) throw new Error('invalid'); return value as Registry; } catch { throw new Error(`Invalid or missing workspace registry: ${file}`); } }
async function atomicJson(file: string, value: unknown): Promise<void> { await fs.mkdir(path.dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.${randomUUID()}.tmp`; await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); await fs.rename(temp, file); }
async function validateCandidateRegistry(registryPath: string, registry: Registry): Promise<void> {
    const candidate = path.join(path.dirname(registryPath), `.workspaces.${process.pid}.${randomUUID()}.json`);
    try {
        await atomicJson(candidate, registry);
        await resolveWorkspaceRuntime({ registryPath: candidate, allowEmpty: true });
    } finally {
        await fs.rm(candidate, { force: true });
    }
}
async function sourceName(source: string): Promise<string> { try { const pkg = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8')) as { name?: unknown }; if (typeof pkg.name === 'string' && pkg.name) return pkg.name.replace(/^@[^/]+\//, ''); } catch { /* use basename */ } return path.basename(source); }
function portable(from: string, to: string): string { const relative = path.relative(from, to); return relative && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : to; }
function assertName(name: string): void { if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('Name must be lowercase kebab-case'); }

function workspaceReadme(name: string): string {
    return `# ${name}\n\nThis is a **CallAgent workspace**: it selects built agent projects, owns shared runtime configuration, and starts the runtime host, Hatchet worker, and Observer. It does not contain or build agent code.\n\n## First-time setup\n\n1. Build every agent project selected in \`.callagent/workspaces.json\`.\n2. Copy \`.env.example\` to \`.env\`. Set \`MEMORY_DATABASE_URL\` and replace \`BETTER_AUTH_SECRET\` with a random value of at least 32 characters.\n3. Start local infrastructure and initialise the database:\n\n\`\`\`bash\nnpm run infra:up\nnpm run db:setup\n\`\`\`\n\n4. Open the Hatchet dashboard at the configured \`HATCHET_DASHBOARD_URL\` (default \`http://localhost:8080\`). Sign in, create an API token under **Settings → API Tokens**, and paste it into \`HATCHET_CLIENT_TOKEN\` in \`.env\`. The token belongs to this workspace's Hatchet instance; do not reuse a token created by a different local stack.\n\nPostgres is external infrastructure; \`infra:up\` starts the packaged Hatchet + NATS Docker profile only.\n\n## Start the runtime\n\n\`\`\`bash\nnpm run validate\nnpm run start\n\`\`\`\n\n\`npm run start\` starts the runtime host at \`http://127.0.0.1:8790\`, the Hatchet worker, and Observer at \`http://127.0.0.1:8790/operator\`. Use \`npm run start -- --no-observer\` to omit Observer. Stop the Docker services with \`npm run infra:down\`.\n\nIf the worker reports \`UNAUTHENTICATED: invalid auth token\`, create a new token in this workspace's current Hatchet dashboard, update \`HATCHET_CLIENT_TOKEN\`, and restart \`npm run start\`.\n\n## Customize infrastructure\n\nTo append a workspace-owned Docker Compose override (for example, local Postgres or different ports), run:\n\n\`\`\`bash\ncallagent infra up --compose docker-compose.local.yml\n\`\`\`\n\nThe default Compose profile is shipped with the installed CallAgent runtime. Keep secrets in \`.env\`; it is intentionally ignored by Git.\n\n## Local framework development\n\nWhen created from a CallAgent source checkout, this workspace uses managed local links automatically. Keep using \`npm run\` commands while the framework versions are unpublished. Check \`callagent local status\` or repair links with \`callagent local sync\`.\n`;
}
