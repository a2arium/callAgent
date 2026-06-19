import { AlertTriangle, EyeOff, Info, ShieldAlert } from 'lucide-react';
import { cn } from '../../../lib/utils';

export type NoticeKind = 'info' | 'warning' | 'error' | 'unsafe' | 'partial';

const noticeClasses: Record<NoticeKind, string> = {
  info: 'border-zinc-400/50 bg-zinc-100 text-zinc-800 dark:border-zinc-400/30 dark:bg-zinc-500/10 dark:text-zinc-100',
  warning: 'border-amber-500/55 bg-amber-100 text-amber-900 dark:border-amber-400/40 dark:bg-amber-500/10 dark:text-amber-100',
  error: 'border-rose-500/55 bg-rose-100 text-rose-900 dark:border-rose-400/40 dark:bg-rose-500/10 dark:text-rose-100',
  unsafe: 'border-violet-500/55 bg-violet-100 text-violet-900 dark:border-violet-400/40 dark:bg-violet-500/10 dark:text-violet-100',
  partial: 'border-dashed border-violet-500/55 bg-violet-100 text-violet-900 dark:border-violet-300/50 dark:bg-violet-500/10 dark:text-violet-100',
};

export function Notice(props: {
  kind?: NoticeKind;
  title: string;
  children?: React.ReactNode;
  className?: string;
}): React.ReactElement {
  const kind = props.kind ?? 'info';
  const Icon = kind === 'unsafe' ? EyeOff : kind === 'error' ? ShieldAlert : kind === 'warning' || kind === 'partial' ? AlertTriangle : Info;
  return (
    <section className={cn('rounded-lg border p-3 text-sm', noticeClasses[kind], props.className)}>
      <div className="flex items-start gap-2">
        <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0">
          <p className="font-medium">{props.title}</p>
          {props.children ? <div className="mt-1 text-xs opacity-85">{props.children}</div> : null}
        </div>
      </div>
    </section>
  );
}

export function UnsafePreviewNotice(): React.ReactElement {
  return (
    <Notice kind="unsafe" title="Preview hidden for safety">
      Raw input/output payloads are not rendered until a server-side sanitizer is available.
    </Notice>
  );
}
