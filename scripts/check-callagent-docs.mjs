import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const commandScanRoots = ['README.md', 'packages', 'apps/docs', 'apps/examples'];
const linkCheckedFiles = [
  'README.md',
  'packages/core/README.md',
  'packages/operator-auth/README.md',
  'apps/docs/workspaces-and-runtime.md',
  'apps/docs/callagent-cli-reference.md',
  'apps/docs/callagent-troubleshooting.md',
  'apps/docs/callagent-workspace-model.md',
  'apps/docs/generators-and-workspace-operations.md',
  'apps/docs/migration/callagent-cli-workspace-distribution.md',
  'apps/examples/runtime-host/README.md',
];
const historicalRoots = [
  'apps/docs/migration/done/',
  'apps/docs/todo/done/',
  'apps/docs/todo/installable-workspace-runtime-distribution.md',
  'apps/docs/migration/callagent-cli-workspace-distribution.md',
];
const forbidden = /callagent-scaffold|yarn create-agent/g;
const markdownLink = /\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g;
const failures = [];

for (const entry of commandScanRoots) visit(path.join(root, entry), false);
for (const entry of linkCheckedFiles) visit(path.join(root, entry), true);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
}

function visit(file, checkLinks) {
  if (!fs.existsSync(file)) return;
  const stat = fs.statSync(file);
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(file)) {
      if (child === 'node_modules' || child === 'dist' || child === '.turbo') continue;
      visit(path.join(file, child), checkLinks);
    }
    return;
  }
  if (!file.endsWith('.md')) return;
  const relative = path.relative(root, file).split(path.sep).join('/');
  const text = fs.readFileSync(file, 'utf8');
  if (!historicalRoots.some((historical) => relative === historical || relative.startsWith(historical))) {
    if (forbidden.test(text)) failures.push(`${relative}: removed command found`);
    forbidden.lastIndex = 0;
  }
  if (!checkLinks) return;
  for (const match of text.matchAll(markdownLink)) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const resolved = path.resolve(path.dirname(file), target);
    if (!fs.existsSync(resolved)) failures.push(`${relative}: missing Markdown link target ${target}`);
  }
}
