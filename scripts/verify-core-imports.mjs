import { spawnSync } from 'node:child_process';

const checks = [
  {
    name: 'core root ESM import',
    code: "import('./packages/core/dist/index.js').then(() => console.log('ok'))",
    expectedStdout: 'ok',
  },
  {
    name: 'core runner ESM import',
    code: "import('./packages/core/dist/runner/index.js').then((m) => console.log(typeof m.runAgentWithStreaming))",
    expectedStdout: 'function',
  },
];

for (const check of checks) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', check.code], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    console.error(`${check.name} failed with exit code ${result.status}`);
    if (result.stdout) console.error(result.stdout);
    if (result.stderr) console.error(result.stderr);
    process.exit(result.status ?? 1);
  }

  const stdout = result.stdout.trim();
  if (stdout !== check.expectedStdout) {
    console.error(`${check.name} produced unexpected stdout`);
    console.error(`Expected: ${JSON.stringify(check.expectedStdout)}`);
    console.error(`Received: ${JSON.stringify(stdout)}`);
    process.exit(1);
  }
}

console.log('core import smoke checks passed');

