import { isTerminalTaskStatus, type RuntimeStreamEvent } from './runtimeStreamEvent.schema.js';

export type SseProjectionEvent = {
  id: string;
  event: RuntimeStreamEvent['type'];
  data: RuntimeStreamEvent;
  closesStream: boolean;
};

export type ChatProjectionEvent =
  | { type: 'typing'; taskId: string; seq: number; ts: string }
  | { type: 'message'; taskId: string; seq: number; ts: string; text: string; parseMode?: 'plain' | 'markdown' | 'html' }
  | { type: 'media'; taskId: string; seq: number; ts: string; media: Record<string, unknown> }
  | { type: 'markup'; taskId: string; seq: number; ts: string; value: unknown }
  | { type: 'input_required'; taskId: string; seq: number; ts: string; token: string; prompt?: string }
  | { type: 'completed'; taskId: string; seq: number; ts: string }
  | { type: 'error'; taskId: string; seq: number; ts: string; message: string };

export function projectPublic(events: readonly RuntimeStreamEvent[]): RuntimeStreamEvent[] {
  return events.filter((event) => event.visibility === 'public');
}

export function projectDebug(events: readonly RuntimeStreamEvent[]): RuntimeStreamEvent[] {
  return events.filter((event) => event.visibility === 'public' || event.visibility === 'debug');
}

export function projectSse(events: readonly RuntimeStreamEvent[], visibility: 'public' | 'debug' = 'public'): SseProjectionEvent[] {
  const visible = visibility === 'debug' ? projectDebug(events) : projectPublic(events);
  return visible.map((event) => ({
    id: event.id,
    event: event.type,
    data: event,
    closesStream: isTerminalTaskStatus(event),
  }));
}

export function projectChat(events: readonly RuntimeStreamEvent[]): ChatProjectionEvent[] {
  const projected: ChatProjectionEvent[] = [];

  for (const event of projectPublic(events)) {
    if (event.type === 'task.status') {
      if (event.data.state === 'working') {
        projected.push({ type: 'typing', taskId: event.taskId, seq: event.seq, ts: event.ts });
      } else if (event.data.state === 'completed' && event.data.terminal) {
        projected.push({ type: 'completed', taskId: event.taskId, seq: event.seq, ts: event.ts });
      } else if ((event.data.state === 'failed' || event.data.state === 'canceled') && event.data.terminal) {
        const firstText = event.data.message?.parts.find((part) => part.type === 'text')?.text;
        projected.push({
          type: 'error',
          taskId: event.taskId,
          seq: event.seq,
          ts: event.ts,
          message: firstText ?? event.data.state,
        });
      }
      continue;
    }

    if (event.type === 'artifact.delta') {
      for (const part of event.data.parts) {
        if (part.type === 'text') {
          projected.push({
            type: 'message',
            taskId: event.taskId,
            seq: event.seq,
            ts: event.ts,
            text: part.text,
            parseMode: part.format,
          });
        } else if (part.type === 'markup') {
          projected.push({
            type: 'markup',
            taskId: event.taskId,
            seq: event.seq,
            ts: event.ts,
            value: part.value,
          });
        } else if (part.type === 'image' || part.type === 'file' || part.type === 'audio' || part.type === 'video') {
          projected.push({
            type: 'media',
            taskId: event.taskId,
            seq: event.seq,
            ts: event.ts,
            media: part,
          });
        }
      }
      continue;
    }

    if (event.type === 'input.required') {
      const prompt = event.data.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n') || undefined;
      projected.push({
        type: 'input_required',
        taskId: event.taskId,
        seq: event.seq,
        ts: event.ts,
        token: event.data.token,
        prompt,
      });
    }
  }

  return projected;
}

