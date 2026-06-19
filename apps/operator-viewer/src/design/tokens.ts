import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleHelp,
  Clock3,
  Loader2,
  type LucideIcon,
} from 'lucide-react';

export type RuntimeStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'stuck'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'partial'
  | 'unknown';

export type AttentionStatus = 'normal' | 'warning' | 'critical' | 'partial' | 'missing';

export type StatusToken = {
  id: RuntimeStatus;
  label: string;
  icon: LucideIcon;
  shape: 'solid' | 'dashed' | 'double';
  className: string;
  srLabel: string;
};

export const statusTokens: Record<RuntimeStatus, StatusToken> = {
  queued: {
    id: 'queued',
    label: 'Queued',
    icon: Clock3,
    shape: 'dashed',
    className: 'border-slate-500/45 bg-slate-100 text-slate-700 dark:border-slate-400/40 dark:bg-slate-500/10 dark:text-slate-300',
    srLabel: 'Queued run',
  },
  running: {
    id: 'running',
    label: 'Running',
    icon: Loader2,
    shape: 'solid',
    className: 'border-zinc-500/45 bg-zinc-100 text-zinc-800 dark:border-zinc-300/45 dark:bg-zinc-400/10 dark:text-zinc-100',
    srLabel: 'Running run',
  },
  waiting: {
    id: 'waiting',
    label: 'Waiting',
    icon: Clock3,
    shape: 'dashed',
    className: 'border-stone-500/45 bg-stone-100 text-stone-800 dark:border-stone-300/45 dark:bg-stone-400/10 dark:text-stone-100',
    srLabel: 'Waiting run',
  },
  stuck: {
    id: 'stuck',
    label: 'Stuck',
    icon: AlertTriangle,
    shape: 'double',
    className: 'border-amber-600/55 bg-amber-100 text-amber-900 dark:border-amber-300/70 dark:bg-amber-500/15 dark:text-amber-100',
    srLabel: 'Derived stuck waiting run',
  },
  completed: {
    id: 'completed',
    label: 'Completed',
    icon: CheckCircle2,
    shape: 'solid',
    className: 'border-emerald-600/45 bg-emerald-100 text-emerald-900 dark:border-emerald-300/70 dark:bg-emerald-500/20 dark:text-emerald-200',
    srLabel: 'Completed run',
  },
  failed: {
    id: 'failed',
    label: 'Failed',
    icon: AlertTriangle,
    shape: 'solid',
    className: 'border-rose-600/55 bg-rose-100 text-rose-900 dark:border-rose-400/50 dark:bg-rose-500/15 dark:text-rose-100',
    srLabel: 'Failed run',
  },
  cancelled: {
    id: 'cancelled',
    label: 'Cancelled',
    icon: Ban,
    shape: 'solid',
    className: 'border-zinc-500/45 bg-zinc-100 text-zinc-800 dark:border-zinc-400/40 dark:bg-zinc-500/10 dark:text-zinc-300',
    srLabel: 'Cancelled run',
  },
  partial: {
    id: 'partial',
    label: 'Partial data',
    icon: AlertTriangle,
    shape: 'dashed',
    className: 'border-violet-600/45 bg-violet-100 text-violet-900 dark:border-violet-300/50 dark:bg-violet-500/10 dark:text-violet-100',
    srLabel: 'Partial data',
  },
  unknown: {
    id: 'unknown',
    label: 'Unknown',
    icon: CircleHelp,
    shape: 'dashed',
    className: 'border-slate-500/45 bg-slate-100 text-slate-700 dark:border-slate-500/40 dark:bg-slate-700/20 dark:text-slate-300',
    srLabel: 'Unknown status',
  },
};

export const attentionClasses: Record<AttentionStatus, string> = {
  normal: 'border-border bg-card',
  warning: 'border-amber-400/40 bg-amber-500/10',
  critical: 'border-rose-400/50 bg-rose-500/10',
  partial: 'border-violet-400/40 bg-violet-500/10',
  missing: 'border-dashed border-slate-500/50 bg-slate-700/20',
};
