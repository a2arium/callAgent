import type { Extension } from '@codemirror/state';
import type { EditorView as CodeMirrorEditorView } from '@codemirror/view';
import { Check, Copy, Download, ExternalLink, Search, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getArtifact, type ArtifactPayload } from '../../api/client';
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
  tenantId?: string;
}): React.ReactElement {
  const maxPreviewRows = props.maxPreviewRows ?? 5;
  const envelope = payloadEnvelope(props.value);
  if (envelope) {
    return <PayloadEnvelopePreview envelope={envelope} title={props.title} defaultExpanded={props.defaultExpanded} maxRawHeight={props.maxRawHeight ?? 320} tenantId={props.tenantId} />;
  }
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
                    <JsonValue value={value} tenantId={props.tenantId} />
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

type PayloadEnvelope =
  | { state: 'available'; contentType: string; value: unknown; truncated: boolean }
  | { state: 'artifact_only'; artifactId: string; summary?: string }
  | { state: 'hidden'; reason: string }
  | { state: 'not_captured'; reason?: string }
  | { state: 'too_large'; limitBytes: number; actualBytes?: number; summary?: string };

function PayloadEnvelopePreview(props: {
  envelope: PayloadEnvelope;
  title?: string;
  defaultExpanded?: boolean;
  maxRawHeight: number;
  tenantId?: string;
}): React.ReactElement {
  const envelope = props.envelope;
  if (envelope.state === 'available') {
    return (
      <JsonPreview
        value={envelope.value}
        title={props.title}
        defaultExpanded={props.defaultExpanded}
        maxRawHeight={props.maxRawHeight}
        tenantId={props.tenantId}
      />
    );
  }
  if (envelope.state === 'hidden') {
    return <Notice kind="unsafe" title={props.title ?? 'Payload hidden'}>{envelope.reason}</Notice>;
  }
  if (envelope.state === 'not_captured') {
    return <Notice title={props.title ?? 'Payload not captured'} className="bg-background/50">{envelope.reason}</Notice>;
  }
  const rows: Array<[string, unknown]> = envelope.state === 'artifact_only'
    ? [['state', 'artifact only'], ['artifactId', envelope.artifactId], ['summary', envelope.summary]]
    : [['state', 'too large'], ['limitBytes', envelope.limitBytes], ['actualBytes', envelope.actualBytes], ['summary', envelope.summary]];
  return (
    <div className="json-preview grid min-w-0 max-w-full gap-2 overflow-x-hidden">
      {props.title ? <p className="text-sm font-medium">{props.title}</p> : null}
      <Notice
        kind={envelope.state === 'too_large' ? 'warning' : 'info'}
        title={envelope.state === 'too_large' ? 'Payload too large to display inline' : 'Payload available as artifact metadata'}
      >
        {envelope.summary}
      </Notice>
      {envelope.state === 'artifact_only' ? (
        <ArtifactActions artifact={{ artifactId: envelope.artifactId }} tenantId={props.tenantId} />
      ) : null}
      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full table-fixed text-sm">
          <tbody>
            {rows.filter(([, value]) => value !== undefined).map(([field, value]) => (
              <tr key={field} className="border-t border-border first:border-t-0">
                <td className="w-28 bg-muted/50 px-3 py-2 align-top text-xs text-muted-foreground">{field}</td>
                <td className="min-w-0 px-3 py-2 align-top">
                  <JsonValue value={value} tenantId={props.tenantId} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="min-w-0 rounded-md border border-border bg-background/50" open={props.defaultExpanded}>
        <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm font-medium">
          View envelope JSON
          <CopyTextButton text={prettyJson(envelope)} label="envelope JSON" />
        </summary>
        <HighlightedJson value={envelope} maxRawHeight={props.maxRawHeight} />
      </details>
    </div>
  );
}

function JsonValue(props: { value: unknown; tenantId?: string }): React.ReactElement {
  const display = displayValue(props.value);
  const copyValue = typeof props.value === 'string' ? props.value : stringFromUnknown(props.value);
  const artifact = artifactRefFromValue(props.value);
  const artifactList = artifactRefsFromValue(props.value);
  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1">
      <span className="min-w-0 break-words [overflow-wrap:anywhere]" title={copyValue}>
        {display}
      </span>
      <CopyTextButton text={copyValue} label="value" compact />
      {artifact ? <ArtifactActions artifact={artifact} tenantId={props.tenantId} compact /> : null}
      {!artifact ? artifactList.map((item) => (
        <ArtifactActions key={item.artifactId} artifact={item} tenantId={props.tenantId} compact />
      )) : null}
    </span>
  );
}

type ArtifactRef = {
  artifactId: string;
  inlineValue?: unknown;
  mimeType?: string;
};

type ArtifactModalRequest = {
  artifact: ArtifactRef;
  tenantId: string;
};

const ArtifactModalContext = createContext<((request: ArtifactModalRequest) => void) | null>(null);

export function ArtifactModalProvider(props: { children: React.ReactNode }): React.ReactElement {
  const [request, setRequest] = useState<ArtifactModalRequest | null>(null);
  const openArtifact = useCallback((nextRequest: ArtifactModalRequest) => {
    setRequest(nextRequest);
  }, []);

  return (
    <ArtifactModalContext.Provider value={openArtifact}>
      {props.children}
      {request ? (
        <ArtifactModal
          artifact={request.artifact}
          tenantId={request.tenantId}
          onClose={() => setRequest(null)}
        />
      ) : null}
    </ArtifactModalContext.Provider>
  );
}

function useOpenArtifactModal(): (request: ArtifactModalRequest) => void {
  const openArtifact = useContext(ArtifactModalContext);
  if (!openArtifact) {
    return () => undefined;
  }
  return openArtifact;
}

function ArtifactActions(props: { artifact: ArtifactRef; tenantId?: string; compact?: boolean }): React.ReactElement {
  const openArtifact = useOpenArtifactModal();
  const resolvable = props.artifact.inlineValue !== undefined || isResolvableArtifactId(props.artifact.artifactId);
  if (!resolvable) {
    return (
      <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground" title="This artifact reference cannot be resolved from storage.">
        metadata only
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        className={props.compact
          ? 'inline-flex h-5 items-center gap-1 rounded px-1.5 text-[11px] text-info hover:bg-info-bg'
          : 'inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs font-medium text-info hover:bg-info-bg'}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openArtifact({
            artifact: props.artifact,
            tenantId: props.tenantId ?? 'default',
          });
        }}
      >
        <ExternalLink className="h-3.5 w-3.5" />
        Open artifact
      </button>
    </>
  );
}

function ArtifactModal(props: { artifact: ArtifactRef; tenantId: string; onClose: () => void }): React.ReactElement {
  const [payload, setPayload] = useState<ArtifactPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'source' | 'preview'>('source');

  useEffect(() => {
    setActiveTab('source');
  }, [props.artifact.artifactId, props.tenantId]);

  useEffect(() => {
    let canceled = false;
    setError(null);
    if (props.artifact.inlineValue !== undefined) {
      setPayload(inlineArtifactPayload(props.artifact));
      setLoading(false);
      return () => {
        canceled = true;
      };
    }
    setLoading(true);
    setPayload(null);
    getArtifact(props.tenantId, props.artifact.artifactId)
      .then((result) => {
        if (!canceled) setPayload(result);
      })
      .catch((err: unknown) => {
        if (!canceled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [props.artifact, props.tenantId]);

  const contentText = useMemo(() => payload ? artifactContentText(payload) : '', [payload]);
  const sourceText = useMemo(() => payload ? artifactSourceText(payload) : '', [payload]);
  const hasPreview = useMemo(() => payload ? canPreviewArtifact(payload) : false, [payload]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="artifact-modal-title">
      <div className="flex max-h-[90vh] w-full max-w-5xl min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <header className="flex min-w-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Artifact</p>
            <div className="mt-1 flex min-w-0 items-center gap-1.5">
              <h3 id="artifact-modal-title" className="truncate font-mono text-sm font-semibold">{props.artifact.artifactId}</h3>
              <CopyTextButton text={props.artifact.artifactId} label="artifact ID" compact />
            </div>
            {payload ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {payload.contentType} · {formatBytes(payload.sizeBytes)}
                {props.artifact.inlineValue === undefined ? ` · tenant ${props.tenantId}` : ' · inline artifact'}
              </p>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">tenant {props.tenantId}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {payload ? (
              <>
                <CopyTextButton text={contentText} label="artifact content" />
                <button
                  type="button"
                  className="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-accent"
                  aria-label="Download artifact"
                  title="Download artifact"
                  onClick={() => downloadArtifact(payload)}
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-accent"
              aria-label="Close artifact modal"
              onClick={props.onClose}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>
        <div className="flex min-h-0 flex-col overflow-hidden p-4">
          {loading ? <Notice title="Loading artifact">Resolving artifact content from storage.</Notice> : null}
          {!loading && error ? (
            <Notice kind="warning" title="Artifact unavailable">
              The artifact may have expired or been cleaned up. {error}
            </Notice>
          ) : null}
          {!loading && payload ? (
            <>
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5 text-xs">
                  <button
                    type="button"
                    className={`rounded px-3 py-1.5 font-medium ${activeTab === 'source' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                    onClick={() => setActiveTab('source')}
                  >
                    Source
                  </button>
                  {hasPreview ? (
                    <button
                      type="button"
                      className={`rounded px-3 py-1.5 font-medium ${activeTab === 'preview' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                      onClick={() => setActiveTab('preview')}
                    >
                      Preview
                    </button>
                  ) : null}
                </div>
                <p className="min-w-0 truncate text-xs text-muted-foreground">{artifactDisplayMode(payload)}</p>
              </div>
              <div className={activeTab === 'source' ? 'min-h-0' : 'hidden'}>
                <ArtifactSource payload={payload} sourceText={sourceText} />
              </div>
              {hasPreview ? (
                <div className={activeTab === 'preview' ? 'min-h-0' : 'hidden'}>
                  <ArtifactPreview payload={payload} contentText={contentText} />
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ArtifactSource(props: { payload: ArtifactPayload; sourceText: string }): React.ReactElement {
  const contentType = normalizeContentType(props.payload.contentType);
  return <CodeMirrorSource value={props.sourceText} contentType={contentType} />;
}

function ArtifactPreview(props: { payload: ArtifactPayload; contentText: string }): React.ReactElement {
  const contentType = normalizeContentType(props.payload.contentType);
  if (contentType.startsWith('image/')) {
    return (
      <div className="flex min-h-0 max-h-[68vh] items-center justify-center overflow-auto rounded-md border border-border bg-background p-3">
        <img src={dataUrlForPayload(props.payload, props.contentText)} alt={`Artifact ${props.payload.artifactId}`} className="max-h-[64vh] max-w-full object-contain" />
      </div>
    );
  }
  if (contentType === 'application/pdf') {
    return (
      <iframe
        title={`Artifact ${props.payload.artifactId} PDF preview`}
        src={dataUrlForPayload(props.payload, props.contentText)}
        className="h-[68vh] w-full rounded-md border border-border bg-background"
      />
    );
  }
  if (isHtmlContentType(contentType)) {
    return (
      <iframe
        title={`Artifact ${props.payload.artifactId} HTML preview`}
        sandbox=""
        srcDoc={props.contentText}
        className="h-[68vh] w-full rounded-md border border-border bg-white"
      />
    );
  }
  if (isMarkdownContentType(contentType)) {
    return (
      <div
        className="artifact-markdown-preview min-h-0 max-h-[68vh] overflow-auto rounded-md border border-border bg-background p-4 text-sm leading-6"
        dangerouslySetInnerHTML={{ __html: renderMarkdownPreview(props.contentText) }}
      />
    );
  }
  return (
    <Notice title="Preview unavailable" className="bg-background/50">
      This artifact MIME type does not have a rendered preview yet. Use Source or Download.
    </Notice>
  );
}

function CodeMirrorSource(props: { value: string; contentType: string }): React.ReactElement {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<CodeMirrorEditorView | null>(null);
  const openSearchRef = useRef<((view: CodeMirrorEditorView) => boolean) | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const parent = parentRef.current;
    if (!parent) return;
    let canceled = false;
    let activeView: CodeMirrorEditorView | null = null;
    setReady(false);

    void Promise.all([
      import('codemirror'),
      import('@codemirror/state'),
      import('@codemirror/view'),
      import('@codemirror/search'),
      import('@codemirror/language'),
      import('@codemirror/lang-json'),
      import('@codemirror/lang-html'),
      import('@codemirror/lang-xml'),
    ]).then(([codeMirrorModule, stateModule, viewModule, searchModule, languageModule, jsonModule, htmlModule, xmlModule]) => {
      if (canceled) return;
      const view = new viewModule.EditorView({
        parent,
        state: stateModule.EditorState.create({
          doc: props.value,
          extensions: [
            codeMirrorModule.basicSetup,
            languageModule.foldGutter(),
            searchModule.search({ top: true }),
            searchModule.highlightSelectionMatches(),
            viewModule.keymap.of(searchModule.searchKeymap),
            stateModule.EditorState.readOnly.of(true),
            viewModule.EditorView.editable.of(false),
            viewModule.EditorView.lineWrapping,
            codeMirrorLanguage(props.contentType, {
              json: jsonModule.json,
              html: htmlModule.html,
              xml: xmlModule.xml,
            }),
            viewModule.EditorView.theme({
              '&': {
                height: '68vh',
                maxHeight: '68vh',
                backgroundColor: 'hsl(var(--background))',
                color: 'hsl(var(--foreground))',
                fontSize: '12px',
              },
              '.cm-scroller': {
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
                lineHeight: '1.65',
              },
              '.cm-content': {
                padding: '10px 0',
              },
              '.cm-line': {
                padding: '0 12px 0 6px',
              },
              '.cm-gutters': {
                backgroundColor: 'hsl(var(--muted) / 0.45)',
                color: 'hsl(var(--muted-foreground))',
                borderRight: '1px solid hsl(var(--border))',
              },
              '.cm-activeLine, .cm-activeLineGutter': {
                backgroundColor: 'hsl(var(--accent) / 0.45)',
              },
              '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
                backgroundColor: 'hsl(var(--accent-border) / 0.45)',
              },
              '.cm-panels, .cm-search': {
                backgroundColor: 'hsl(var(--card))',
                color: 'hsl(var(--foreground))',
              },
              '.cm-panels': {
                borderColor: 'hsl(var(--border))',
              },
              '.cm-search input': {
                backgroundColor: 'hsl(var(--background))',
                color: 'hsl(var(--foreground))',
                border: '1px solid hsl(var(--border))',
                borderRadius: '6px',
                padding: '2px 6px',
              },
              '.cm-search label': {
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                lineHeight: '1',
                verticalAlign: 'middle',
              },
              '.cm-search label input[type="checkbox"]': {
                margin: '0',
                transform: 'translateY(0)',
              },
              '.cm-search button': {
                backgroundColor: 'hsl(var(--background))',
                color: 'hsl(var(--foreground))',
                border: '1px solid hsl(var(--border))',
                borderRadius: '6px',
                padding: '2px 7px',
              },
              '.cm-search button:hover': {
                backgroundColor: 'hsl(var(--accent))',
              },
              '.cm-foldPlaceholder': {
                backgroundColor: 'hsl(var(--muted))',
                borderColor: 'hsl(var(--border))',
                color: 'hsl(var(--muted-foreground))',
              },
            }),
          ],
        }),
      });

      activeView = view;
      viewRef.current = view;
      openSearchRef.current = searchModule.openSearchPanel;
      setReady(true);
    });

    return () => {
      canceled = true;
      activeView?.destroy();
      if (viewRef.current === activeView) viewRef.current = null;
      openSearchRef.current = null;
    };
  }, [props.value, props.contentType]);

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border bg-background">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/25 px-3 py-2">
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs font-medium hover:bg-accent"
          onClick={() => {
            if (viewRef.current && openSearchRef.current) openSearchRef.current(viewRef.current);
          }}
          disabled={!ready}
        >
          <Search className="h-3.5 w-3.5" />
          Search
        </button>
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">Cmd/Ctrl-F searches source. Fold controls appear in the gutter.</span>
      </div>
      <div ref={parentRef} className="min-h-0" />
    </div>
  );
}

function codeMirrorLanguage(
  contentType: string,
  languages: {
    json: () => Extension;
    html: () => Extension;
    xml: () => Extension;
  },
): Extension {
  if (isJsonContentType(contentType)) return languages.json();
  if (isHtmlContentType(contentType)) return languages.html();
  if (isXmlContentType(contentType)) return languages.xml();
  return [];
}

function HighlightedJson(props: { value: unknown; maxRawHeight: number; searchQuery?: string }): React.ReactElement {
  const lines = prettyJson(props.value).split('\n');
  return (
    <pre
      className="json-code max-w-full overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 [overflow-wrap:anywhere]"
      style={{ maxHeight: props.maxRawHeight }}
    >
      {lines.map((line, index) => (
        <span key={`${index}-${line}`}>
          {highlightLine(line, props.searchQuery)}
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

function highlightLine(line: string, searchQuery?: string): React.ReactNode {
  const keyMatch = line.match(/^(\s*)"([^"]+)":(.*)$/);
  if (keyMatch) {
    return (
      <>
        <span className="text-muted-foreground">{highlightSearchText(keyMatch[1] ?? '', searchQuery)}</span>
        <span className="text-sky-700 dark:text-sky-300">{highlightSearchText(`"${keyMatch[2]}"`, searchQuery)}</span>
        <span className="text-muted-foreground">{highlightSearchText(':', searchQuery)}</span>
        {highlightValue(keyMatch[3] ?? '', searchQuery)}
      </>
    );
  }
  return highlightValue(line, searchQuery);
}

function highlightValue(value: string, searchQuery?: string): React.ReactNode {
  const parts = value.split(/("(?:[^"\\]|\\.)*"|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?)/g);
  return parts.map((part, index) => {
    if (part.length === 0) return null;
    if (/^"/.test(part)) return <span key={index} className="text-emerald-700 dark:text-emerald-300">{highlightSearchText(shortenRawString(part), searchQuery)}</span>;
    if (/^-?\d/.test(part)) return <span key={index} className="text-amber-700 dark:text-amber-300">{highlightSearchText(part, searchQuery)}</span>;
    if (part === 'true' || part === 'false') return <span key={index} className="text-violet-700 dark:text-violet-300">{highlightSearchText(part, searchQuery)}</span>;
    if (part === 'null') return <span key={index} className="text-muted-foreground">{highlightSearchText(part, searchQuery)}</span>;
    return <span key={index} className="text-muted-foreground">{highlightSearchText(part, searchQuery)}</span>;
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
      const flow = turnTraceFlowLabel(value);
      const result = transitionResult(value);
      const llmCalls = arrayField(value, 'llmCalls')?.length ?? numberField(recordField(value, 'usage') ?? {}, 'llmCalls') ?? 0;
      return `Turn ${turn ?? '?'} completed: ${flow}${result ? ` · ${result}` : ''}${llmCalls ? ` · ${llmCalls} LLM call${llmCalls === 1 ? '' : 's'}` : ''}.`;
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
    const artifact = artifactRefFromValue(value);
    if (artifact) return `Artifact ${middleEllipsis(artifact.artifactId, 24)}`;
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    return `{ ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? `, ... ${keys.length} keys` : ''} }`;
  }
  return stringFromUnknown(value);
}

function artifactRefFromValue(value: unknown): ArtifactRef | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'artifact' && typeof value.id === 'string') {
    return {
      artifactId: value.id,
      mimeType: stringField(value, 'mimeType'),
    };
  }
  if (value.kind === 'artifact_local' && Object.prototype.hasOwnProperty.call(value, 'value')) {
    if (typeof value.value === 'string' && isTruncatedPreviewString(value.value)) {
      return {
        artifactId: 'local',
        mimeType: stringField(value, 'mimeType'),
      };
    }
    return {
      artifactId: 'inline',
      inlineValue: value.value,
      mimeType: stringField(value, 'mimeType'),
    };
  }
  if (value.state === 'artifact_only' && typeof value.artifactId === 'string') {
    return {
      artifactId: value.artifactId,
      mimeType: stringField(value, 'mimeType'),
    };
  }
  if (typeof value.artifactId === 'string') {
    return {
      artifactId: value.artifactId,
      mimeType: stringField(value, 'mimeType'),
    };
  }
  return undefined;
}

function artifactRefsFromValue(value: unknown): ArtifactRef[] {
  const seen = new Set<string>();
  const refs: ArtifactRef[] = [];
  collectArtifactRefs(value, refs, seen, new Set(), 4);
  return refs;
}

function collectArtifactRefs(
  value: unknown,
  refs: ArtifactRef[],
  seen: Set<string>,
  visited: Set<object>,
  limit: number,
): void {
  if (refs.length >= limit) return;
  const direct = artifactRefFromValue(value);
  if (direct) {
    const key = direct.inlineValue !== undefined ? `${direct.artifactId}:${refs.length}` : direct.artifactId;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push(direct);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (visited.has(value)) return;
  visited.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      collectArtifactRefs(item, refs, seen, visited, limit);
      if (refs.length >= limit) return;
    }
    return;
  }
  for (const item of Object.values(value)) {
    collectArtifactRefs(item, refs, seen, visited, limit);
    if (refs.length >= limit) return;
  }
}

function isResolvableArtifactId(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== 'local' && trimmed !== 'unknown';
}

function artifactContentText(payload: ArtifactPayload): string {
  if (typeof payload.value === 'string') return payload.value;
  return prettyJson(payload.value);
}

function artifactSourceText(payload: ArtifactPayload): string {
  const text = artifactContentText(payload);
  const contentType = normalizeContentType(payload.contentType);
  if (isJsonContentType(contentType) && isJsonParseable(payload.value)) {
    return prettyJson(typeof payload.value === 'string' ? JSON.parse(payload.value) : payload.value);
  }
  if (isHtmlContentType(contentType) || isXmlContentType(contentType)) {
    return formatHtmlSource(text);
  }
  return text;
}

function artifactDisplayMode(payload: ArtifactPayload): string {
  const contentType = normalizeContentType(payload.contentType);
  if (isHtmlContentType(contentType)) return 'HTML source with sandboxed rendered preview';
  if (isXmlContentType(contentType)) return 'Formatted XML source';
  if (isJsonContentType(contentType)) return 'Formatted JSON source';
  if (isMarkdownContentType(contentType)) return 'Markdown source with rendered preview';
  if (contentType.startsWith('image/')) return 'Image source with rendered preview';
  if (contentType === 'application/pdf') return 'PDF source with document preview';
  return 'Plain source view';
}

function canPreviewArtifact(payload: ArtifactPayload): boolean {
  const contentType = normalizeContentType(payload.contentType);
  return isHtmlContentType(contentType) ||
    isMarkdownContentType(contentType) ||
    contentType.startsWith('image/') ||
    contentType === 'application/pdf';
}

function normalizeContentType(value: string | undefined): string {
  return (value ?? 'text/plain').split(';')[0]?.trim().toLowerCase() || 'text/plain';
}

function isHtmlContentType(value: string): boolean {
  return value === 'text/html' || value === 'application/xhtml+xml';
}

function isXmlContentType(value: string): boolean {
  return value === 'application/xml' || value === 'text/xml' || value.endsWith('+xml');
}

function isJsonContentType(value: string): boolean {
  return value === 'application/json' || value.endsWith('+json');
}

function isMarkdownContentType(value: string): boolean {
  return value === 'text/markdown' || value === 'text/x-markdown' || value === 'application/markdown';
}

function isJsonParseable(value: unknown): boolean {
  if (typeof value !== 'string') return value !== undefined;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function formatHtmlSource(value: string): string {
  const compact = value
    .replace(/>\s+</g, '><')
    .replace(/(>)(<)(\/*)/g, '$1\n$2$3');
  const lines = compact.split('\n');
  let indent = 0;
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return '';
      if (/^<\//.test(trimmed)) indent = Math.max(0, indent - 1);
      const formatted = `${'  '.repeat(indent)}${trimmed}`;
      if (
        /^<[^!?/][^>]*[^/]?>$/.test(trimmed) &&
        !/^<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b/i.test(trimmed)
      ) {
        indent += 1;
      }
      return formatted;
    })
    .join('\n');
}

function highlightSearchText(value: string, query: string | undefined): React.ReactNode {
  const needle = query?.trim();
  if (!needle) return value;
  const lowerValue = value.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let index = lowerValue.indexOf(lowerNeedle);
  while (index !== -1) {
    if (index > cursor) nodes.push(value.slice(cursor, index));
    nodes.push(
      <mark key={`${index}-${nodes.length}`} className="rounded bg-warning-bg px-0.5 text-warning">
        {value.slice(index, index + needle.length)}
      </mark>
    );
    cursor = index + needle.length;
    index = lowerValue.indexOf(lowerNeedle, cursor);
  }
  if (cursor < value.length) nodes.push(value.slice(cursor));
  return nodes;
}

function dataUrlForPayload(payload: ArtifactPayload, contentText: string): string {
  const contentType = normalizeContentType(payload.contentType);
  if (contentText.startsWith('data:')) return contentText;
  if (contentType.startsWith('image/') || contentType === 'application/pdf') {
    return `data:${contentType};base64,${contentText}`;
  }
  return `data:${contentType};charset=utf-8,${encodeURIComponent(contentText)}`;
}

function renderMarkdownPreview(value: string): string {
  const blocks = value.replace(/\r\n/g, '\n').split(/\n{2,}/);
  return blocks
    .map((block) => {
      const escaped = escapeHtml(block.trim());
      if (escaped.length === 0) return '';
      const heading = escaped.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        const level = Math.min(6, heading[1]?.length ?? 1);
        return `<h${level}>${inlineMarkdown(heading[2] ?? '')}</h${level}>`;
      }
      if (/^[-*]\s+/m.test(escaped)) {
        const items = escaped
          .split('\n')
          .filter(Boolean)
          .map((line) => line.replace(/^[-*]\s+/, ''))
          .map((line) => `<li>${inlineMarkdown(line)}</li>`)
          .join('');
        return `<ul>${items}</ul>`;
      }
      return `<p>${inlineMarkdown(escaped).replace(/\n/g, '<br />')}</p>`;
    })
    .join('');
}

function inlineMarkdown(value: string): string {
  return value
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inlineArtifactPayload(artifact: ArtifactRef): ArtifactPayload {
  const contentType = artifact.mimeType ?? inferInlineContentType(artifact.inlineValue);
  return {
    artifactId: artifact.artifactId,
    contentType,
    filename: inlineArtifactFilename(contentType),
    sizeBytes: artifactSizeBytes(artifact.inlineValue),
    value: artifact.inlineValue,
  };
}

function inferInlineContentType(value: unknown): string {
  if (typeof value === 'string') {
    return value.trimStart().startsWith('<') ? 'text/html' : 'text/plain';
  }
  if (value !== null && typeof value === 'object') return 'application/json';
  return 'text/plain';
}

function inlineArtifactFilename(contentType: string): string {
  if (contentType === 'text/html') return 'artifact-inline.html';
  if (contentType === 'application/json') return 'artifact-inline.json';
  return 'artifact-inline.txt';
}

function artifactSizeBytes(value: unknown): number {
  const text = typeof value === 'string' ? value : prettyJson(value);
  return new Blob([text]).size;
}

function downloadArtifact(payload: ArtifactPayload): void {
  const text = artifactContentText(payload);
  const blob = new Blob([text], { type: payload.contentType || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = payload.filename || `artifact-${payload.artifactId}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return 'unknown size';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
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

function payloadEnvelope(value: unknown): PayloadEnvelope | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = isRecord(value.envelope) ? value.envelope : value;
  if (!isRecord(candidate)) return undefined;
  const state = candidate.state;
  if (state === 'available') {
    return {
      state,
      contentType: typeof candidate.contentType === 'string' ? candidate.contentType : 'application/json',
      value: candidate.value,
      truncated: candidate.truncated === true,
    };
  }
  if (state === 'artifact_only' && typeof candidate.artifactId === 'string') {
    return { state, artifactId: candidate.artifactId, summary: stringField(candidate, 'summary') };
  }
  if (state === 'hidden') {
    return { state, reason: stringField(candidate, 'reason') ?? 'Payload hidden.' };
  }
  if (state === 'not_captured') {
    return { state, reason: stringField(candidate, 'reason') };
  }
  if (state === 'too_large') {
    return {
      state,
      limitBytes: numberField(candidate, 'limitBytes') ?? 0,
      actualBytes: numberField(candidate, 'actualBytes'),
      summary: stringField(candidate, 'summary'),
    };
  }
  return undefined;
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
  return value.length > 1000 ? `${value.slice(0, 1000)}... [truncated]"` : value;
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

function isTruncatedPreviewString(value: string): boolean {
  return /\.\.\. \[truncated(?: \d+ chars)?\]/.test(value) ||
    /^\[(?:html\/text )?truncated[, ]/.test(value);
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

function turnTraceFlowLabel(value: Record<string, unknown>): string {
  const before = stringField(value, 'stageBefore') ?? '?';
  const after = stringField(value, 'stageAfter');
  const transition = recordField(value, 'transition');
  const terminal = transition ? stringField(transition, 'kind') : undefined;
  if (terminal && terminal !== 'continue') {
    return `${before} -> ${terminal}`;
  }
  return `${before} -> ${after ?? terminal ?? '?'}`;
}
