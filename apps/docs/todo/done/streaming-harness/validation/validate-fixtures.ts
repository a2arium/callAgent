import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RuntimeStreamEventSchema,
  isTerminalTaskStatus,
  type RuntimeStreamEvent,
} from './runtimeStreamEvent.schema.js';

const PRIVATE_FIELD_NAMES = new Set([
  'rawPrompt',
  'rawToolArgs',
  'rawThought',
  'rawMemory',
  'unredactedTrace',
]);

type FixtureResult = {
  file: string;
  eventCount: number;
  publicCount: number;
  debugCount: number;
  privateCount: number;
  terminalSeq: number | null;
};

function repoRootFromHere(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../..');
}

function readNdjson(filePath: string): unknown[] {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${filePath}:${index + 1}: invalid JSON: ${message}`);
    }
  });
}

function validateEvents(filePath: string): RuntimeStreamEvent[] {
  return readNdjson(filePath).map((candidate, index) => {
    const parsed = RuntimeStreamEventSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new Error(`${filePath}:${index + 1}: schema validation failed: ${parsed.error.message}`);
    }
    return parsed.data;
  });
}

function assertOrdering(filePath: string, events: RuntimeStreamEvent[]): void {
  if (events.length === 0) {
    throw new Error(`${filePath}: fixture must contain at least one event`);
  }

  for (let index = 0; index < events.length; index += 1) {
    if (events[index].seq !== index) {
      throw new Error(`${filePath}: expected seq ${index}, received ${events[index].seq}`);
    }
  }

  const taskIds = new Set(events.map((event) => event.taskId));
  if (taskIds.size !== 1) {
    throw new Error(`${filePath}: expected exactly one taskId, received ${taskIds.size}`);
  }
}

function assertClosure(filePath: string, events: RuntimeStreamEvent[]): number | null {
  let terminalSeq: number | null = null;

  for (const event of events) {
    if (event.type === 'artifact.done' && isTerminalTaskStatus(event)) {
      throw new Error(`${filePath}: artifact.done must never be terminal`);
    }

    const isTerminal = isTerminalTaskStatus(event);
    if (isTerminal) {
      if (terminalSeq !== null) {
        throw new Error(`${filePath}: multiple terminal task statuses`);
      }
      terminalSeq = event.seq;
    }
  }

  if (terminalSeq !== null && terminalSeq !== events[events.length - 1].seq) {
    throw new Error(`${filePath}: terminal task status must be the last event`);
  }

  return terminalSeq;
}

function hasPrivateFieldName(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasPrivateFieldName);
  }

  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (PRIVATE_FIELD_NAMES.has(key)) {
        return true;
      }
      if (hasPrivateFieldName(nested)) {
        return true;
      }
    }
  }

  return false;
}

function assertVisibility(filePath: string, events: RuntimeStreamEvent[]): void {
  const publicEvents = events.filter((event) => event.visibility === 'public');

  for (const event of publicEvents) {
    if (hasPrivateFieldName(event)) {
      throw new Error(`${filePath}: public event ${event.id} contains a private field name`);
    }
  }
}

function validateFixture(filePath: string): FixtureResult {
  const events = validateEvents(filePath);
  assertOrdering(filePath, events);
  const terminalSeq = assertClosure(filePath, events);
  assertVisibility(filePath, events);

  return {
    file: path.basename(filePath),
    eventCount: events.length,
    publicCount: events.filter((event) => event.visibility === 'public').length,
    debugCount: events.filter((event) => event.visibility === 'debug').length,
    privateCount: events.filter((event) => event.visibility === 'private').length,
    terminalSeq,
  };
}

function main(): void {
  const root = repoRootFromHere();
  const examplesDir = path.join(root, 'apps/docs/streaming-harness/examples');
  const files = fs.readdirSync(examplesDir)
    .filter((file) => file.endsWith('.events.ndjson'))
    .sort()
    .map((file) => path.join(examplesDir, file));

  if (files.length === 0) {
    throw new Error(`No fixture files found in ${examplesDir}`);
  }

  const results = files.map(validateFixture);

  for (const result of results) {
    console.log(`${result.file}: ${result.eventCount} events ok, public=${result.publicCount}, debug=${result.debugCount}, private=${result.privateCount}, terminalSeq=${result.terminalSeq ?? 'none'}`);
  }
}

main();

