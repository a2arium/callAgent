import fs from 'node:fs/promises';
import path from 'node:path';
import { scaffoldAgent } from '@a2arium/callagent-core';

type Preset = 'minimal' | 'non-trivial';
type GenerateOptions = { output?: string; project?: string; withAgent?: string; preset?: Preset; force?: boolean; monorepo?: boolean; usesLlm?: boolean; usesTools?: boolean; usesChildren?: boolean; usesPlans?: boolean; agentSources?: string[]; packageManager?: string; name?: string; envFile?: string; workspaces?: string };
type Registry = { workspaces: Array<{ name: string; root: string; agentIndex?: string; envFile?: string }> };

export async function createAgentProject(name: string, options: GenerateOptions): Promise<{ output: string; agent?: string }> {
    assertName(name);
    const output = path.resolve(options.output ?? name);
    await prepareEmptyDirectory(output, options.force);
    const monorepo = options.monorepo ?? await isCallagentRepositoryProject(output);
    const deps = monorepo ? { '@a2arium/callagent-core': 'workspace:*', '@a2arium/callagent-types': 'workspace:*' } : { '@a2arium/callagent-core': '^0.3.0', '@a2arium/callagent-types': '^0.2.0' };
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
        await createAgent(options.withAgent, { ...agentOptions, monorepo, project: output });
    }
    return { output, ...(options.withAgent ? { agent: options.withAgent } : {}) };
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
    await scaffoldAgent({ name, preset: options.preset ?? 'minimal', outputDir: output, force: options.force, monorepo: options.monorepo, usesLlm: options.usesLlm, usesTools: options.usesTools, usesChildren: options.usesChildren, usesPlans: options.usesPlans });
    await Promise.all(['package.json', 'tsconfig.json'].map(async (file) => fs.rm(path.join(output, file), { force: true })));
    const rel = (file: string) => path.relative(path.dirname(indexPath), path.join(output, file)).split(path.sep).join('/');
    const distModule = path.relative(project, path.join(project, 'dist', 'agents', name, 'agent.js')).split(path.sep).join('/');
    const distAgentRoot = distModule.slice(0, -'agent.js'.length);
    index[name] = { module: `../${distModule}`, agentCard: `../${distAgentRoot}agent-card.json`, runtimeManifest: `../${distAgentRoot}agent-runtime.json` };
    await atomicJson(indexPath, index);
    return { output, project };
}

export async function createWorkspace(name: string, options: GenerateOptions): Promise<{ output: string; sources: string[] }> {
    assertName(name);
    const output = path.resolve(options.output ?? name);
    await prepareEmptyDirectory(output, options.force);
    const registryPath = path.join(output, '.callagent', 'workspaces.json');
    const monorepo = options.monorepo ?? await isCallagentRepositoryProject(output);
    const packageRanges = monorepo
        ? { cli: 'workspace:*', runtime: 'workspace:*' }
        : { cli: '^0.1.0', runtime: '^0.1.0' };
    await write(output, 'package.json', JSON.stringify({ name, private: true, scripts: { dev: 'callagent dev', validate: 'callagent workspace validate', agents: 'callagent agents list' }, devDependencies: { '@a2arium/callagent-cli': packageRanges.cli }, dependencies: { '@a2arium/callagent-runtime': packageRanges.runtime } }, null, 2) + '\n');
    await write(output, '.env.example', '# MEMORY_DATABASE_URL=postgres://localhost:5432/callagent\n# NATS_URL=nats://localhost:4222\n');
    await write(output, '.gitignore', '.env\n.callagent/runtime/\n');
    await write(output, 'README.md', `# ${name}\n\nRun \`npm install\`, then \`npm run validate\` and \`npm run dev\`.\n`);
    await atomicJson(registryPath, { workspaces: [] });
    for (const source of options.agentSources ?? []) await addAgentSource(source, { workspaces: registryPath });
    return { output, sources: (options.agentSources ?? []).map((source) => path.resolve(source)) };
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
    await atomicJson(registryPath, registry);
    return { registryPath, name, agents: agents.sort() };
}

export async function removeAgentSource(name: string, options: GenerateOptions): Promise<{ registryPath: string; name: string }> {
    const registryPath = await findRegistry(options.workspaces);
    const registry = await readRegistry(registryPath);
    const remaining = registry.workspaces.filter((entry) => entry.name !== name);
    if (remaining.length === registry.workspaces.length) throw new Error(`Agent source not found: ${name}`);
    await atomicJson(registryPath, { workspaces: remaining });
    return { registryPath, name };
}

async function findProject(start: string): Promise<string> { let current = start; while (true) { try { await fs.access(path.join(current, '.callagent', 'agent-paths.json')); return current; } catch { const parent = path.dirname(current); if (parent === current) throw new Error('No agent project found; pass --project <dir>'); current = parent; } } }
async function findRegistry(requested?: string): Promise<string> { if (requested) return path.resolve(process.cwd(), requested); let current = process.cwd(); while (true) { const candidate = path.join(current, '.callagent', 'workspaces.json'); try { await fs.access(candidate); return candidate; } catch { const parent = path.dirname(current); if (parent === current) throw new Error('No CallAgent workspace found; pass --workspaces <path>'); current = parent; } } }
async function prepareEmptyDirectory(output: string, force?: boolean): Promise<void> { try { const entries = await fs.readdir(output); if (entries.length && !force) throw new Error(`Output exists and is not empty: ${output}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } await fs.mkdir(output, { recursive: true }); }
async function write(root: string, relative: string, content: string): Promise<void> { const target = path.join(root, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content, 'utf8'); }
async function exists(file: string): Promise<boolean> { try { await fs.access(file); return true; } catch { return false; } }
async function isCallagentRepositoryProject(output: string): Promise<boolean> {
    let current = output;
    while (true) {
        const manifestPath = path.join(current, 'package.json');
        try {
            const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { name?: unknown; workspaces?: unknown };
            if (manifest.name === 'callagent' && Array.isArray(manifest.workspaces)) return true;
        } catch { /* keep walking */ }
        const parent = path.dirname(current);
        if (parent === current) return false;
        current = parent;
    }
}
async function readRegistryIndex(file: string): Promise<Record<string, unknown>> { try { const value = JSON.parse(await fs.readFile(file, 'utf8')) as unknown; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object'); return value as Record<string, unknown>; } catch { throw new Error(`Invalid or missing agent index: ${file}`); } }
async function readRegistry(file: string): Promise<Registry> { try { const value = JSON.parse(await fs.readFile(file, 'utf8')) as unknown; if (!value || typeof value !== 'object' || !Array.isArray((value as Registry).workspaces)) throw new Error('invalid'); return value as Registry; } catch { throw new Error(`Invalid or missing workspace registry: ${file}`); } }
async function atomicJson(file: string, value: unknown): Promise<void> { await fs.mkdir(path.dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.tmp`; await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); await fs.rename(temp, file); }
async function sourceName(source: string): Promise<string> { try { const pkg = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8')) as { name?: unknown }; if (typeof pkg.name === 'string' && pkg.name) return pkg.name.replace(/^@[^/]+\//, ''); } catch { /* use basename */ } return path.basename(source); }
function portable(from: string, to: string): string { const relative = path.relative(from, to); return relative && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : to; }
function assertName(name: string): void { if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('Name must be lowercase kebab-case'); }
