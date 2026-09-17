import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = path.join(root, 'packages');
const localProtocols = ['workspace:', 'portal:', 'link:', 'file:'];
const dependencyFields = ['dependencies', 'peerDependencies', 'optionalDependencies'];

const failures = [];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function visitExports(value, pointer, packageName) {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (typeof value.require === 'string' && !value.require.endsWith('.cjs')) {
    failures.push(
      `${packageName} ${pointer}.require points to ${value.require}; require exports must point to a real .cjs build or be omitted`
    );
  }

  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === 'object') {
      visitExports(child, `${pointer}.${key}`, packageName);
    }
  }
}

for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    continue;
  }

  const packageJsonPath = path.join(packagesDir, entry.name, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    continue;
  }

  const pkg = readJson(packageJsonPath);
  const packageName = pkg.name ?? entry.name;

  for (const field of ['name', 'version', 'description', 'license', 'author', 'repository', 'bugs', 'homepage', 'engines', 'publishConfig']) {
    if (pkg[field] == null || pkg[field] === '') {
      failures.push(`${packageName} is missing package metadata field ${field}`);
    }
  }

  if (pkg.publishConfig?.access !== 'public') {
    failures.push(`${packageName} publishConfig.access must be "public"`);
  }

  if (pkg.engines?.node !== '>=20') {
    failures.push(`${packageName} engines.node must be ">=20"`);
  }

  for (const field of dependencyFields) {
    const deps = pkg[field] ?? {};
    for (const [depName, range] of Object.entries(deps)) {
      if (typeof range !== 'string') {
        continue;
      }
      const protocol = localProtocols.find((candidate) => range.startsWith(candidate));
      if (protocol) {
        failures.push(`${packageName} ${field}.${depName} uses local-only protocol ${protocol}`);
      }
    }
  }

  visitExports(pkg.exports, 'exports', packageName);
}

if (failures.length > 0) {
  console.error('Publish manifest checks failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('publish manifest checks passed');
