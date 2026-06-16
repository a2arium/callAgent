import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeStreamEventSchema, isTerminalTaskStatus, type RuntimeStreamEvent } from './runtimeStreamEvent.schema.js';
import { projectChat, projectDebug, projectPublic, projectSse } from './projections.js';

function repoRootFromHere(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../..');
}

function readEvents(filePath: string): RuntimeStreamEvent[] {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line, index) => {
    const parsedJson = JSON.parse(line) as unknown;
    const parsed = RuntimeStreamEventSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new Error(`${filePath}:${index + 1}: schema validation failed: ${parsed.error.message}`);
    }
    return parsed.data;
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertPublicProjection(file: string, events: RuntimeStreamEvent[]): void {
  const projected = projectPublic(events);
  assert(projected.every((event) => event.visibility === 'public'), `${file}: public projection leaked non-public events`);
}

function assertDebugProjection(file: string, events: RuntimeStreamEvent[]): void {
  const projected = projectDebug(events);
  assert(projected.every((event) => event.visibility !== 'private'), `${file}: debug projection leaked private events`);
}

function assertSseProjection(file: string, events: RuntimeStreamEvent[]): void {
  const projected = projectSse(events);
  const closers = projected.filter((event) => event.closesStream);
  const terminalEvents = events.filter(isTerminalTaskStatus);

  assert(closers.length === terminalEvents.length, `${file}: SSE closer count does not match terminal task statuses`);
  assert(projected.every((event) => event.data.type !== 'artifact.done' || event.closesStream === false), `${file}: artifact.done closed SSE stream`);

  if (terminalEvents.length > 0) {
    const last = projected[projected.length - 1];
    assert(last?.closesStream === true, `${file}: terminal SSE event must be last and close stream`);
  }
}

function assertChatProjection(file: string, events: RuntimeStreamEvent[]): void {
  const projected = projectChat(events);
  const hasWorking = events.some((event) => event.type === 'task.status' && event.data.state === 'working');
  const hasTextDelta = events.some((event) =>
    event.type === 'artifact.delta' &&
    event.data.parts.some((part) => part.type === 'text')
  );
  const hasInputRequired = events.some((event) => event.type === 'input.required');
  const hasCompleted = events.some((event) => event.type === 'task.status' && event.data.state === 'completed' && event.data.terminal);

  if (hasWorking) {
    assert(projected.some((event) => event.type === 'typing'), `${file}: chat projection missing typing event`);
  }
  if (hasTextDelta) {
    assert(projected.some((event) => event.type === 'message'), `${file}: chat projection missing message event`);
  }
  if (hasInputRequired) {
    assert(projected.some((event) => event.type === 'input_required'), `${file}: chat projection missing input_required event`);
  }
  if (hasCompleted) {
    assert(projected.some((event) => event.type === 'completed'), `${file}: chat projection missing completed event`);
  }
}

function validateFile(filePath: string): { file: string; publicCount: number; debugCount: number; sseCount: number; chatCount: number } {
  const events = readEvents(filePath);
  const file = path.basename(filePath);
  assertPublicProjection(file, events);
  assertDebugProjection(file, events);
  assertSseProjection(file, events);
  assertChatProjection(file, events);

  return {
    file,
    publicCount: projectPublic(events).length,
    debugCount: projectDebug(events).length,
    sseCount: projectSse(events).length,
    chatCount: projectChat(events).length,
  };
}

function main(): void {
  const root = repoRootFromHere();
  const examplesDir = path.join(root, 'apps/docs/streaming-harness/examples');
  const files = fs.readdirSync(examplesDir)
    .filter((file) => file.endsWith('.events.ndjson'))
    .sort()
    .map((file) => path.join(examplesDir, file));

  for (const result of files.map(validateFile)) {
    console.log(`${result.file}: projections ok, public=${result.publicCount}, debug=${result.debugCount}, sse=${result.sseCount}, chat=${result.chatCount}`);
  }
}

main();

