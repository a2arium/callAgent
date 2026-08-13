import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDirs = [
  'packages/types',
  'packages/utils',
  'packages/memory-sql',
  'packages/memory-engine',
  'packages/core',
  'packages/chat-bridge',
  'packages/eventbus-nats',
  'packages/driver-hatchet',
  'packages/operator-auth',
  'packages/runtime',
  'packages/cli',
];

const forbidden = [
  /(^|\/).*\.test\.(js|d\.ts|ts)$/,
  /(^|\/).*\.spec\.(js|d\.ts|ts)$/,
  /(^|\/).*\.bak$/,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)\.DS_Store$/,
  /^scripts\/.*\.ts$/,
  /^dist\/generated\/.*(?<!\.d)\.ts$/,
];

const failures = [];

for (const dir of packageDirs) {
  const cwd = path.join(root, dir);
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_cache: process.env.npm_config_cache ?? '/private/tmp/callagent-npm-cache',
    },
  });

  if (result.status !== 0) {
    failures.push(`${dir}: npm pack failed\n${result.stderr || result.stdout}`);
    continue;
  }

  const packOutput = JSON.parse(result.stdout);
  const [pack] = packOutput;
  for (const file of pack.files ?? []) {
    for (const pattern of forbidden) {
      if (pattern.test(file.path)) {
        failures.push(`${pack.name}: forbidden packed file ${file.path}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error('Packlist checks failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('packlist checks passed');
