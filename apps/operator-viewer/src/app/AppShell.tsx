import { Link, Outlet, useLocation } from '@tanstack/react-router';
import { Activity, HelpCircle, Moon, Search, ShieldCheck, Sun, UserCircle } from 'lucide-react';
import { useOperatorConfig } from '../api/hooks';
import { Button } from '../design/components/ui/button';
import { cn } from '../lib/utils';
import { ErrorBoundary } from './ErrorBoundary';
import { useTheme } from './theme';

export function AppShell(): React.ReactElement {
  const configQuery = useOperatorConfig();
  const location = useLocation();
  const theme = useTheme();
  const environment = configQuery.data?.environment ?? 'local-dev';
  const isProd = environment.toLowerCase().includes('prod');
  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 border-r border-border bg-card/95 p-4 lg:block">
        <div className="mb-6">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">callAgent</p>
          <h1 className="mt-1 text-xl font-semibold">Operator Dashboard</h1>
        </div>
        <nav className="grid gap-2">
          <NavLink to="/" active={location.pathname === '/'}>Fleet</NavLink>
          <NavLink to="/agents" active={location.pathname === '/agents'}>Agents</NavLink>
          <NavLink to="/runs/$taskId" params={{ taskId: 'open-directly' }} disabled>
            Run Detail
          </NavLink>
        </nav>
        <div className="absolute bottom-4 left-4 right-4 grid gap-2 text-xs text-muted-foreground">
          <div
            className={cn(
              'rounded-lg border p-3',
              isProd
                ? 'border-rose-500/55 bg-rose-100 text-rose-900 dark:border-rose-400/50 dark:bg-rose-500/10 dark:text-rose-100'
                : 'border-zinc-400/50 bg-zinc-100 text-zinc-800 dark:border-zinc-400/30 dark:bg-zinc-500/10 dark:text-zinc-100'
            )}
          >
            <div className="flex items-center gap-2 font-medium">
              <ShieldCheck className="h-4 w-4" />
              {environment}
            </div>
            <p className="mt-1 opacity-80">Environment is visible on every page.</p>
          </div>
          <div className="rounded-lg border border-border bg-background/50 p-3">
            <div className="flex items-center gap-2">
              <UserCircle className="h-4 w-4" />
              Auth reserved
            </div>
          </div>
        </div>
      </aside>
      <div className="lg:pl-64">
        <header className="sticky top-0 z-10 border-b border-border bg-background/85 px-4 py-3 backdrop-blur lg:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Activity className="h-5 w-5 text-primary" />
              <div>
                <p className="text-sm font-medium">Execution investigation</p>
                <p className="text-xs text-muted-foreground">Manual refresh MVP · last updated after each fetch</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="hidden items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground md:flex">
                <Search className="h-4 w-4" />
                Global search reserved
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={theme.toggleTheme}
                aria-label={`Switch to ${theme.theme === 'dark' ? 'light' : 'dark'} theme`}
              >
                {theme.theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                {theme.theme === 'dark' ? 'Light' : 'Dark'}
              </Button>
              <Button variant="outline" size="sm">
                <HelpCircle className="h-4 w-4" />
                Help
              </Button>
            </div>
          </div>
        </header>
        <main className="p-4 lg:p-6">
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}

function NavLink(props: {
  to: string;
  params?: Record<string, string>;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  if (props.disabled) {
    return <span className="rounded-md px-3 py-2 text-sm text-muted-foreground/60">{props.children}</span>;
  }
  return (
    <Link
      to={props.to}
      params={props.params}
      className={cn(
        'rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground',
        props.active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'
      )}
    >
      {props.children}
    </Link>
  );
}
