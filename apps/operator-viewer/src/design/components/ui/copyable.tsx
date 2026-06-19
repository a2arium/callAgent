import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { middleEllipsis } from '../../format';
import { Button } from './button';

export function CopyableId(props: {
  value: string | undefined;
  label?: string;
  max?: number;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  if (!props.value) return <span className="text-muted-foreground">Not captured</span>;
  const label = props.label ?? 'ID';
  return (
    <span className="inline-flex max-w-full items-center gap-1 font-mono text-xs text-zinc-700 dark:text-zinc-200" title={props.value}>
      <span className="truncate">{middleEllipsis(props.value, props.max ?? 22)}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        aria-label={`Copy ${label}`}
        onClick={(event) => {
          event.stopPropagation();
          void navigator.clipboard.writeText(props.value ?? '').then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : <Copy aria-hidden="true" className="h-3.5 w-3.5" />}
      </Button>
    </span>
  );
}
