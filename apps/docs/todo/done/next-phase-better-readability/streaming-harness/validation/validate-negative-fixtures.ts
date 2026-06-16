import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeStreamEventSchema, isTerminalTaskStatus, type RuntimeStreamEvent } from './runtimeStreamEvent.schema.js';

const PRIVATE_FIELD_NAMES = new Set([
  'rawPrompt',
  'rawToolArgs',
  'rawThought',
  'rawMemory',
  'unredactedTrace',
]);

function repoRootFromHere(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../..');
}

function parseFixture(filePath: string): RuntimeStreamEvent[] {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line, index) => {
    const parsedJson = JSON.parse(line) as unknown;
    const parsed = RuntimeStreamEventSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new Error(`${path.basename(filePath)}:${index + 1}: schema validation failed`);
    }
    return parsed.data;
  });
}

function hasPrivateFieldName(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasPrivateFieldName);
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (PRIVATE_FIELD_NAMES.has(key)) return true;
      if (hasPrivateFieldName(nested)) return true;
    }
  }
  return false;
}

function validateLikePositiveFixture(filePath: string): void {
  const events = parseFixture(filePath);
  if (events.length === 0) throw new Error(`${path.basename(filePath)}: fixture must contain events`);

  for (let index = 0; index < events.length; index += 1) {
    if (events[index].seq !== index) {
      throw new Error(`${path.basename(filePath)}: expected seq ${index}, received ${events[index].seq}`);
    }
  }

  const taskIds = new Set(events.map((event) => event.taskId));
  if (taskIds.size !== 1) {
    throw new Error(`${path.basename(filePath)}: expected one taskId`);
  }

  for (const event of events) {
    if (event.visibility === 'public' && hasPrivateFieldName(event)) {
      throw new Error(`${path.basename(filePath)}: public event contains private field`);
    }
  }

  const terminalEvents = events.filter(isTerminalTaskStatus);
  if (terminalEvents.length > 1) {
    throw new Error(`${path.basename(filePath)}: multiple terminal events`);
  }
  if (terminalEvents.length === 1 && terminalEvents[0].seq !== events[events.length - 1].seq) {
    throw new Error(`${path.basename(filePath)}: terminal event is not last`);
  }
}

function main(): void {
  const root = repoRootFromHere();
  const invalidDir = path.join(root, 'apps/docs/streaming-harness/examples/invalid');
  const files = fs.readdirSync(invalidDir)
    .filter((file) => file.endsWith('.events.ndjson'))
    .sort()
    .map((file) => path.join(invalidDir, file));

  if (files.length === 0) {
    throw new Error(`No invalid fixtures found in ${invalidDir}`);
  }

  for (const filePath of files) {
    let failedAsExpected = false;
    try {
      validateLikePositiveFixture(filePath);
    } catch (error) {
      failedAsExpected = true;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`${path.basename(filePath)}: failed as expected (${message})`);
    }

    if (!failedAsExpected) {
      throw new Error(`${path.basename(filePath)}: expected validation failure, but fixture passed`);
    }
  }
}

main();

