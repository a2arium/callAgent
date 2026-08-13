import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STATE_FILE = path.join('.callagent', 'local-source.json');
const PACKAGE_SCOPE = '@a2arium/';

type PackageLink = { name: string; source: string; target: string };
type LocalSourceState = {
    schemaVersion: 1;
    sourceRoot: string;
    createdAt: string;
    packages: PackageLink[];
    shims: string[];
};

export type LocalSourceOptions = { localSource?: string; npm?: boolean };

export async function detectLocalSource(options: LocalSourceOptions = {}): Promise<string | undefined> {
    if (options.npm) return undefined;
    if (options.localSource ?? process.env.CALLAGENT_SOURCE_ROOT) {
        return validateSourceRoot(options.localSource ?? process.env.CALLAGENT_SOURCE_ROOT!);
    }
    if (process.env.CI === 'true') return undefined;
    const cliPath = await fs.realpath(fileURLToPath(import.meta.url));
    const fromCli = await findSourceRoot(path.dirname(cliPath));
    if (fromCli) return fromCli;
    return findSourceRoot(process.cwd());
}

export async function setupLocalSource(project: string, sourceRoot: string): Promise<LocalSourceState> {
    const source = await validateSourceRoot(sourceRoot);
    const packages = await sourcePackages(source, project);
    const statePath = path.join(project, STATE_FILE);
    const existing = await readState(project);
    if (existing && existing.sourceRoot !== source) throw new Error(`Project already has a local CallAgent source overlay: ${existing.sourceRoot}. Run \`callagent local unlink\` first.`);
    const created: string[] = [];
    try {
        for (const entry of packages) {
            if (await ensureOwnedLink(entry.target, entry.source, existing?.packages.find((item) => item.target === entry.target))) created.push(entry.target);
        }
        const shims = await ensureCliShim(project, packages, existing?.shims ?? [], created);
        const state: LocalSourceState = { schemaVersion: 1, sourceRoot: source, createdAt: new Date().toISOString(), packages, shims };
        await atomicJson(statePath, state);
        await ensureIgnore(project);
        return state;
    } catch (error) {
        await Promise.all(created.reverse().map((target) => fs.rm(target, { force: true, recursive: false }).catch(() => undefined)));
        throw error;
    }
}

export async function syncLocalSource(project: string): Promise<LocalSourceState> {
    const state = await readState(project);
    if (!state) throw new Error(`No local CallAgent source overlay in ${project}`);
    return setupLocalSource(project, state.sourceRoot);
}

export async function localSourceStatus(project: string): Promise<{ mode: 'npm' | 'local-source'; sourceRoot?: string; ok: boolean; drift: string[]; packages: Array<{ name: string; source: string; target: string; resolvedTarget?: string }> }> {
    const state = await readState(project);
    if (!state) return { mode: 'npm', ok: true, drift: [], packages: [] };
    const drift: string[] = [];
    const packages: Array<{ name: string; source: string; target: string; resolvedTarget?: string }> = [];
    for (const entry of state.packages) {
        try {
            const resolvedTarget = await fs.realpath(entry.target);
            packages.push({ ...entry, resolvedTarget });
            if (resolvedTarget !== await fs.realpath(entry.source)) drift.push(entry.name);
        } catch {
            packages.push({ ...entry });
            drift.push(entry.name);
        }
    }
    return { mode: 'local-source', sourceRoot: state.sourceRoot, ok: drift.length === 0, drift, packages };
}

export async function unlinkLocalSource(project: string): Promise<void> {
    const state = await readState(project);
    if (!state) return;
    for (const entry of state.packages) {
        try { if (await fs.realpath(entry.target) === await fs.realpath(entry.source)) await fs.rm(entry.target, { recursive: false, force: true }); }
        catch { /* already absent or not owned */ }
    }
    for (const shim of state.shims ?? []) await fs.rm(shim, { force: true }).catch(() => undefined);
    await fs.rm(path.join(project, STATE_FILE), { force: true });
}

export async function localInstall(project: string, packageManager = 'npm'): Promise<void> {
    const state = await readState(project);
    if (!state) throw new Error('Local install requires an existing local-source overlay');
    const manifest = path.join(project, 'package.json');
    const original = await fs.readFile(manifest);
    const parsed = JSON.parse(original.toString()) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const stripped = structuredClone(parsed);
    for (const section of ['dependencies', 'devDependencies'] as const) {
        if (!stripped[section]) continue;
        for (const name of Object.keys(stripped[section]!)) if (name.startsWith(PACKAGE_SCOPE)) delete stripped[section]![name];
    }
    if (packageManager !== 'npm' && packageManager !== 'yarn') throw new Error(`Unsupported local install package manager: ${packageManager}. Use npm or yarn.`);
    const lockPath = path.join(project, packageManager === 'yarn' ? 'yarn.lock' : 'package-lock.json');
    const lock = await readOptional(lockPath);
    const journal = path.join(project, '.callagent', 'local-install.journal');
    if (await exists(journal)) throw new Error(`A previous local install was interrupted: ${journal}. Restore package.json and package-lock.json from that journal before retrying.`);
    await fs.mkdir(path.dirname(journal), { recursive: true });
    await fs.writeFile(journal, JSON.stringify({ manifest: original.toString(), lock: lock?.toString() ?? null }), 'utf8');
    try {
        await fs.writeFile(manifest, `${JSON.stringify(stripped, null, 2)}\n`, 'utf8');
        if (packageManager === 'npm') await run('npm', ['install', '--ignore-scripts', '--no-save', '--package-lock=false'], project);
        else await run('yarn', ['install', '--mode=skip-build'], project, { YARN_NODE_LINKER: 'node-modules' });
    } finally {
        await fs.writeFile(manifest, original);
        if (lock === undefined) await fs.rm(lockPath, { force: true }); else await fs.writeFile(lockPath, lock);
        await fs.rm(journal, { force: true });
    }
    await syncLocalSource(project);
}

export async function validateSourceRoot(input: string): Promise<string> {
    const source = await fs.realpath(path.resolve(input));
    const manifest = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8')) as { name?: string; workspaces?: unknown };
    if (manifest.name !== 'callagent' || !Array.isArray(manifest.workspaces)) throw new Error(`Not a CallAgent source checkout: ${source}`);
    for (const relative of ['packages/core/dist/index.js', 'packages/runtime/dist/index.js', 'packages/cli/dist/cli.js']) {
        if (!(await exists(path.join(source, relative)))) throw new Error(`Local CallAgent source is not built (${relative} is missing). Run \`yarn build\` in ${source}.`);
    }
    if (!(await exists(path.join(source, 'node_modules')))) throw new Error(`Local CallAgent source dependencies are missing. Run \`yarn install\` in ${source}.`);
    return source;
}

async function sourcePackages(sourceRoot: string, project: string): Promise<PackageLink[]> {
    const packagesRoot = path.join(sourceRoot, 'packages');
    const dirs = await fs.readdir(packagesRoot, { withFileTypes: true });
    const result: PackageLink[] = [];
    for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const source = path.join(packagesRoot, dir.name);
        try {
            const manifest = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8')) as { name?: string };
            if (!manifest.name?.startsWith(PACKAGE_SCOPE)) continue;
            result.push({ name: manifest.name, source, target: path.join(project, 'node_modules', ...manifest.name.split('/')) });
        } catch { /* not a package */ }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
}

async function ensureOwnedLink(target: string, source: string, owned?: PackageLink): Promise<boolean> {
    if (await exists(target)) {
        try { if (await fs.realpath(target) === await fs.realpath(source)) return false; }
        catch { /* reject below */ }
        if (!owned) throw new Error(`Refusing to replace unowned package path: ${target}`);
        await fs.rm(target, { recursive: false, force: true });
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
}

async function ensureCliShim(project: string, packages: PackageLink[], owned: string[], created: string[]): Promise<string[]> {
    const cli = packages.find((entry) => entry.name === '@a2arium/callagent-cli');
    if (!cli) return [];
    const shim = path.join(project, 'node_modules', '.bin', 'callagent');
    if (await exists(shim)) {
        try { if (await fs.realpath(shim) === await fs.realpath(path.join(cli.source, 'dist', 'cli.js'))) return [shim]; }
        catch { /* reject below */ }
        if (!owned.includes(shim)) throw new Error(`Refusing to replace unowned CLI shim: ${shim}`);
        await fs.rm(shim, { force: true });
    }
    await fs.mkdir(path.dirname(shim), { recursive: true });
    await fs.symlink(path.join(cli.source, 'dist', 'cli.js'), shim, 'file');
    created.push(shim);
    return [shim];
}
async function findSourceRoot(start: string): Promise<string | undefined> { let current = path.resolve(start); while (true) { try { return await validateSourceRoot(current); } catch { const parent = path.dirname(current); if (parent === current) return undefined; current = parent; } } }
async function readState(project: string): Promise<LocalSourceState | undefined> { try { return JSON.parse(await fs.readFile(path.join(project, STATE_FILE), 'utf8')) as LocalSourceState; } catch { return undefined; } }
async function ensureIgnore(project: string): Promise<void> { const target = path.join(project, '.gitignore'); const current = await readOptional(target); const required = '.callagent/local-source.json\n.callagent/local-install.journal\n'; const content = current?.toString() ?? ''; if (!content.includes('.callagent/local-source.json')) await fs.writeFile(target, `${content}${content && !content.endsWith('\n') ? '\n' : ''}${required}`); }
async function exists(file: string): Promise<boolean> { try { await fs.lstat(file); return true; } catch { return false; } }
async function readOptional(file: string): Promise<Buffer | undefined> { try { return await fs.readFile(file); } catch { return undefined; } }
async function atomicJson(file: string, value: unknown): Promise<void> { const temp = `${file}.${crypto.randomUUID()}.tmp`; await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`); await fs.rename(temp, file); }
function run(command: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv = {}): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...environment } });
        child.once('error', reject);
        child.once('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${command} ${args[0]} failed with exit code ${code}`));
        });
    });
}
