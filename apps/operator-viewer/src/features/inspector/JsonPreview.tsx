import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Notice } from '../../design/components/ui/notice';
import { middleEllipsis, stringFromUnknown } from '../../design/format';

export function JsonPreview(props: {
  value: unknown;
  title?: string;
  summaryFields?: string[];
  defaultExpanded?: boolean;
  maxPreviewRows?: number;
  maxRawHeight?: number;
  emptyLabel?: string;
  hidden?: boolean;
  hiddenLabel?: string;
}): React.ReactElement {
  const maxPreviewRows = props.maxPreviewRows ?? 5;
  const state = jsonState(props.value, props.hidden);

  if (state.kind === 'hidden') {
    return <Notice kind="unsafe" title={props.hiddenLabel ?? 'Payload hidden for safety'} />;
  }
  if (state.kind === 'missing') {
    return <Notice title={props.emptyLabel ?? 'No JSON payload captured.'} className="bg-background/50" />;
  }

  const formatted = prettyJson(props.value);
  const fields = previewRows(props.value, props.summaryFields, maxPreviewRows);
  const summary = summaryText(props.value, state.kind);

  return (
    <div className="json-preview grid min-w-0 max-w-full gap-2 overflow-x-hidden">
      {props.title ? <p className="text-sm font-medium">{props.title}</p> : null}
      <p className="break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{summary}</p>
      {fields.length > 0 ? (
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full table-fixed text-sm">
            <tbody>
              {fields.map(([field, value]) => (
                <tr key={field} className="border-t border-border first:border-t-0">
                  <td className="w-28 bg-muted/50 px-3 py-2 align-top text-xs text-muted-foreground">{field}</td>
                  <td className="min-w-0 px-3 py-2 align-top">
                    <JsonValue value={value} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <details className="min-w-0 rounded-md border border-border bg-background/50" open={props.defaultExpanded}>
        <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm font-medium">
          View formatted JSON
          <CopyTextButton text={formatted} label="formatted JSON" />
        </summary>
        <HighlightedJson value={props.value} maxRawHeight={props.maxRawHeight ?? 320} />
      </details>
    </div>
  );
}

function JsonValue(props: { value: unknown }): React.ReactElement {
  const display = displayValue(props.value);
  const copyValue = typeof props.value === 'string' ? props.value : stringFromUnknown(props.value);
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1">
      <span className="min-w-0 break-words [overflow-wrap:anywhere]" title={copyValue}>
        {display}
      </span>
      <CopyTextButton text={copyValue} label="value" compact />
    </span>
  );
}

function HighlightedJson(props: { value: unknown; maxRawHeight: number }): React.ReactElement {
  const lines = prettyJson(props.value).split('\n');
  return (
    <pre
      className="json-code max-w-full overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words border-t border-border p-3 font-mono text-xs leading-5 [overflow-wrap:anywhere]"
      style={{ maxHeight: props.maxRawHeight }}
    >
      {lines.map((line, index) => (
        <span key={`${index}-${line}`}>
          {highlightLine(line)}
          {index < lines.length - 1 ? '\n' : null}
        </span>
      ))}
    </pre>
  );
}

function CopyTextButton(props: { text: string; label: string; compact?: boolean }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={props.compact
        ? 'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground'
        : 'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-accent'}
      aria-label={`Copy ${props.label}`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void navigator.clipboard.writeText(props.text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function highlightLine(line: string): React.ReactNode {
  const keyMatch = line.match(/^(\s*)"([^"]+)":(.*)$/);
  if (keyMatch) {
    return (
      <>
        <span className="text-muted-foreground">{keyMatch[1]}</span>
        <span className="text-sky-700 dark:text-sky-300">"{keyMatch[2]}"</span>
        <span className="text-muted-foreground">:</span>
        {highlightValue(keyMatch[3] ?? '')}
      </>
    );
  }
  return highlightValue(line);
}

function highlightValue(value: string): React.ReactNode {
  const parts = value.split(/("(?:[^"\\]|\\.)*"|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?)/g);
  return parts.map((part, index) => {
    if (part.length === 0) return null;
    if (/^"/.test(part)) return <span key={index} className="text-emerald-700 dark:text-emerald-300">{shortenRawString(part)}</span>;
    if (/^-?\d/.test(part)) return <span key={index} className="text-amber-700 dark:text-amber-300">{part}</span>;
    if (part === 'true' || part === 'false') return <span key={index} className="text-violet-700 dark:text-violet-300">{part}</span>;
    if (part === 'null') return <span key={index} className="text-muted-foreground">{part}</span>;
    return <span key={index} className="text-muted-foreground">{part}</span>;
  });
}

function previewRows(value: unknown, summaryFields: string[] | undefined, maxRows: number): Array<[string, unknown]> {
  if (!isRecord(value)) {
    if (Array.isArray(value)) return value.slice(0, maxRows).map((item, index) => [String(index), item]);
    return [['value', value]];
  }
  const preferred = summaryFields ?? defaultSummaryFields(value);
  const seen = new Set<string>();
  const rows: Array<[string, unknown]> = [];
  for (const key of preferred) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      rows.push([key, value[key]]);
      seen.add(key);
    }
  }
  for (const [key, item] of Object.entries(value)) {
    if (rows.length >= maxRows) break;
    if (!seen.has(key)) rows.push([key, item]);
  }
  return rows.slice(0, maxRows);
}

function summaryText(value: unknown, kind: ReturnType<typeof jsonState>['kind']): string {
  if (kind === 'invalid-string') return 'Invalid JSON string. Showing raw text preview.';
  if (Array.isArray(value)) return value.length === 0 ? 'Empty array.' : `Array with ${value.length} item${value.length === 1 ? '' : 's'}.`;
  if (isRecord(value)) {
    if (isTurnTraceProjection(value)) {
      const turn = numberField(value, 'turnSeq');
      const before = stringField(value, 'stageBefore') ?? '?';
      const after = stringField(value, 'stageAfter') ?? '?';
      const result = transitionResult(value);
      const llmCalls = arrayField(value, 'llmCalls')?.length ?? numberField(recordField(value, 'usage') ?? {}, 'llmCalls') ?? 0;
      return `Turn ${turn ?? '?'} completed: ${before} -> ${after}${result ? ` · ${result}` : ''}${llmCalls ? ` · ${llmCalls} LLM call${llmCalls === 1 ? '' : 's'}` : ''}.`;
    }
    const keys = Object.keys(value);
    if (keys.length === 0) return 'Empty object.';
    const status = stringField(value, 'status');
    const kindValue = stringField(value, 'kind');
    const statusCode = numberField(value, 'statusCode');
    if (statusCode !== undefined) return `HTTP status ${statusCode}.`;
    if (status || kindValue) return [kindValue, status].filter(Boolean).join(' · ');
    return `Object with ${keys.length} field${keys.length === 1 ? '' : 's'}.`;
  }
  return 'Primitive JSON value.';
}

function defaultSummaryFields(value: Record<string, unknown>): string[] {
  if (isTurnTraceProjection(value)) {
    return [
      'turnSeq',
      'stageBefore',
      'stageAfter',
      'transition',
      'intent',
      'shield',
      'usage',
      'llmCalls',
      'mentalStateBeforeHash',
      'mentalStateAfterHash',
    ];
  }
  return ['taskId', 'traceparent', 'kind', 'status', 'statusCode', 'url', 'savedPath', 'message'];
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') {
    if (looksLikeHtml(value) || value.length > 600) return `[truncated, ${value.length} chars]`;
    if (looksLikeUrl(value)) return shortenUrl(value);
    if (looksLikeId(value)) return middleEllipsis(value, 24);
    return truncate(value, 180);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (value === undefined) return 'Not captured';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[${value.slice(0, 3).map((item) => displayValue(item)).join(', ')}${value.length > 3 ? `, ... ${value.length} items` : ''}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    return `{ ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? `, ... ${keys.length} keys` : ''} }`;
  }
  return stringFromUnknown(value);
}

function jsonState(value: unknown, hidden: boolean | undefined): { kind: 'hidden' | 'missing' | 'object' | 'array' | 'primitive' | 'invalid-string' } {
  if (hidden) return { kind: 'hidden' };
  if (value === undefined || value === null) return { kind: 'missing' };
  if (Array.isArray(value)) return { kind: 'array' };
  if (isRecord(value)) return { kind: 'object' };
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return { kind: 'primitive' };
    } catch {
      return { kind: 'invalid-string' };
    }
  }
  return { kind: 'primitive' };
}

function prettyJson(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return 'Unserializable value';
  }
}

function shortenRawString(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}... [truncated]"` : value;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function shortenUrl(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname.length > 28 ? `...${url.pathname.slice(-28)}` : url.pathname;
    return `${url.origin}${path}`;
  } catch {
    return truncate(value, 180);
  }
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//.test(value);
}

function looksLikeHtml(value: string): boolean {
  return /<html|<!doctype|<body|<div|<script/i.test(value);
}

function looksLikeId(value: string): boolean {
  return value.length > 28 && /^[a-zA-Z0-9_.:-]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const field = value[key];
  return isRecord(field) ? field : undefined;
}

function arrayField(value: Record<string, unknown>, key: string): unknown[] | undefined {
  const field = value[key];
  return Array.isArray(field) ? field : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}

function isTurnTraceProjection(value: Record<string, unknown>): boolean {
  return (
    typeof value.turnSeq === 'number' &&
    (typeof value.stageBefore === 'string' ||
      typeof value.stageAfter === 'string' ||
      Object.prototype.hasOwnProperty.call(value, 'transition') ||
      Object.prototype.hasOwnProperty.call(value, 'execResult'))
  );
}

function transitionResult(value: Record<string, unknown>): string | undefined {
  const transition = recordField(value, 'transition');
  const result = transition ? recordField(transition, 'result') : undefined;
  const ok = result?.ok;
  if (ok === true) return 'result ok';
  if (ok === false) return 'semantic failure';
  return transition ? stringField(transition, 'kind') : undefined;
}
