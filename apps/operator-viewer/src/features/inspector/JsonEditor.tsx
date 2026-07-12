import { AlertTriangle, Copy, Maximize2, Minimize2 } from 'lucide-react';
import type React from 'react';
import { useRef, useState } from 'react';
import { Button } from '../../design/components/ui/button';
import { cn } from '../../lib/utils';

export type JsonParseResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; message: string; line?: number; column?: number };

export function JsonEditor(props: {
  value: string;
  validation: JsonParseResult;
  copied: boolean;
  onChange: (value: string) => void;
  onFormat: () => void;
  onCopy: () => void;
  onSubmitShortcut?: () => void;
  ariaLabel?: string;
  minHeight?: number;
  fullscreenHeightClass?: string;
}): React.ReactElement {
  const [fullscreen, setFullscreen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const highlighterRef = useRef<HTMLPreElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const lineCount = Math.max(1, props.value.split('\n').length);
  const minHeight = props.minHeight ?? 360;
  const editorHeight = Math.max(minHeight, lineCount * 20 + 24);

  const syncScroll = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (highlighterRef.current) {
      highlighterRef.current.style.transform = fullscreen
        ? `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`
        : `translateX(${-textarea.scrollLeft}px)`;
    }
    if (gutterRef.current) {
      gutterRef.current.style.transform = fullscreen ? `translateY(${-textarea.scrollTop}px)` : '';
    }
  };

  const insertText = (text: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      props.onChange(text);
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const next = `${props.value.slice(0, start)}${text}${props.value.slice(end)}`;
    props.onChange(next);
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.selectionStart = start + text.length;
      textarea.selectionEnd = start + text.length;
    });
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = event.clipboardData.getData('text');
    const formatted = formatJsonIfObject(pasted);
    if (!formatted) return;
    event.preventDefault();
    insertText(formatted);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      props.onFormat();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && props.onSubmitShortcut) {
      event.preventDefault();
      props.onSubmitShortcut();
    }
  };

  return (
    <div
      className={cn(
        'grid gap-0',
        fullscreen ? 'fixed inset-4 z-50 rounded-xl border border-border bg-card p-4 shadow-2xl' : ''
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-t-lg border border-b-0 border-border bg-muted/30 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {props.validation.ok ? null : (
            <span className="inline-flex items-center gap-1 text-rose-800">
              <AlertTriangle className="h-3.5 w-3.5" />
              {props.validation.message}
              {props.validation.line ? ` at line ${props.validation.line}, column ${props.validation.column}` : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={props.onFormat} disabled={!props.validation.ok}>
            Format
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={props.onCopy}>
            <Copy className="h-3.5 w-3.5" />
            {props.copied ? 'Copied' : 'Copy'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setFullscreen(!fullscreen)}
            aria-label={fullscreen ? 'Exit fullscreen editor' : 'Open fullscreen editor'}
          >
            {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            {fullscreen ? 'Exit' : 'Full screen'}
          </Button>
        </div>
      </div>

      <div
        className={cn(
          'grid min-h-[360px] grid-cols-[3.25rem_minmax(0,1fr)] overflow-hidden rounded-b-lg border border-input bg-background',
          fullscreen ? (props.fullscreenHeightClass ?? 'h-[calc(100vh-9rem)]') : ''
        )}
        style={fullscreen ? undefined : { height: editorHeight }}
      >
        <div className="relative overflow-hidden border-r border-border bg-muted/30 px-2 py-3 font-mono text-xs leading-5 text-muted-foreground">
          <div ref={gutterRef} className="text-right">
            {Array.from({ length: lineCount }, (_, index) => (
              <div key={index + 1}>{index + 1}</div>
            ))}
          </div>
        </div>
        <div className="relative min-w-0 overflow-hidden">
          <pre
            ref={highlighterRef}
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 min-h-full min-w-full whitespace-pre p-3 font-mono text-xs leading-5"
          >
            <JsonHighlightedCode text={props.value} />
          </pre>
          <textarea
            ref={textareaRef}
            className={cn(
              'absolute inset-0 resize-none bg-transparent p-3 font-mono text-xs leading-5 text-transparent caret-foreground outline-none selection:bg-primary/20',
              fullscreen ? 'overflow-auto' : 'overflow-x-auto overflow-y-hidden'
            )}
            spellCheck={false}
            wrap="off"
            value={props.value}
            onBlur={() => {
              if (props.validation.ok) props.onFormat();
            }}
            onChange={(event) => props.onChange(event.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onScroll={syncScroll}
            aria-label={props.ariaLabel ?? 'JSON editor'}
            aria-invalid={!props.validation.ok}
          />
        </div>
      </div>
    </div>
  );
}

export function parseJsonAny(text: string): JsonParseResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Value is not valid JSON.';
    return {
      ok: false,
      message,
      ...jsonErrorPosition(text, message),
    };
  }
}

export function parseJsonObject(text: string): JsonParseResult<Record<string, unknown>> {
  const parsed = parseJsonAny(text);
  if (!parsed.ok) return parsed;
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return { ok: false, message: 'Payload must be a JSON object.' };
  }
  return { ok: true, value: parsed.value as Record<string, unknown> };
}

function JsonHighlightedCode(props: { text: string }): React.ReactElement {
  const lines = props.text.split('\n');
  return (
    <>
      {lines.map((line, index) => (
        <div key={index}>{highlightJsonLine(line)}</div>
      ))}
    </>
  );
}

function highlightJsonLine(line: string): React.ReactNode[] | string {
  if (line.length === 0) return '\u00a0';
  const tokenPattern =
    /("(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|[-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b|[{}\[\],:])/g;
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of line.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > cursor) {
      nodes.push(line.slice(cursor, index));
    }
    nodes.push(
      <span key={`${index}-${token}`} className={jsonTokenClass(token, line.slice(index + token.length))}>
        {token}
      </span>
    );
    cursor = index + token.length;
  }
  if (cursor < line.length) nodes.push(line.slice(cursor));
  return nodes;
}

function jsonTokenClass(token: string, afterToken: string): string {
  if (token.startsWith('"')) {
    return afterToken.match(/^\s*:/) ? 'text-sky-800' : 'text-emerald-800';
  }
  if (token === 'true' || token === 'false') return 'text-violet-800';
  if (token === 'null') return 'text-muted-foreground';
  if (/^-?\d/.test(token)) return 'text-amber-800';
  return 'text-muted-foreground';
}

function formatJsonIfObject(text: string): string | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

function jsonErrorPosition(text: string, message: string): { line?: number; column?: number } {
  const positionMatch = message.match(/position\s+(\d+)/i);
  if (!positionMatch) return {};
  const position = Number(positionMatch[1]);
  if (!Number.isFinite(position)) return {};
  const before = text.slice(0, position);
  const lines = before.split('\n');
  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
}
