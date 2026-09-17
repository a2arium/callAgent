import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(packageRoot, '../../apps/operator-viewer/dist');
const target = path.join(packageRoot, 'dist', 'observer');

try {
  await stat(source);
} catch {
  throw new Error('Observer assets are missing. Build @a2arium/operator-viewer before building @a2arium/callagent-runtime.');
}
await rm(target, { recursive: true, force: true });
await mkdir(path.dirname(target), { recursive: true });
await cp(source, target, { recursive: true });
