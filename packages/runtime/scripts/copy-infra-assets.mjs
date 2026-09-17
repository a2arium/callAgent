import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, 'dist', 'infra'), { recursive: true });
await cp(path.join(root, 'infra', 'docker-compose.yml'), path.join(root, 'dist', 'infra', 'docker-compose.yml'));
