import { Link, Outlet, useLocation } from '@tanstack/react-router';
import { Activity, HelpCircle, LogOut, Moon, Search, ShieldCheck, Sun, UserCircle } from 'lucide-react';
import { useOperatorConfig } from '../api/hooks';
import { Button } from '../design/components/ui/button';
import { cn } from '../lib/utils';
import { ErrorBoundary } from './ErrorBoundary';
import { useTheme } from './theme';
import { useAuth } from './auth';

export function AppShell(): React.ReactElement {
  const configQuery = useOperatorConfig();
  const location = useLocation();
  const theme = useTheme();
  const auth = useAuth();
  const preferredTenant = window.localStorage.getItem('callagent.operator.tenant') || auth.session.memberships[0]?.tenantId || 'default';
  const membership = auth.session.memberships.find((item) => item.tenantId === preferredTenant);
  const environment = configQuery.data?.environment ?? 'local-dev';
  const isProd = environment.toLowerCase().includes('prod');
  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 border-r border-border bg-sidebar p-4 shadow-[8px_0_30px_hsl(220_20%_10%/0.04)] lg:block">
        <div className="mb-6">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-primary">callAgent</p>
          <h1 className="mt-1 text-lg font-semibold">Operator Dashboard</h1>
        </div>
        <nav className="grid gap-2">
          <NavLink to="/" active={location.pathname === '/'}>Fleet</NavLink>
          <NavLink to="/agents" active={location.pathname === '/agents'}>Agents</NavLink>
          <NavLink to="/memory" active={location.pathname === '/memory'}>Memory</NavLink>
          <NavLink to="/runs/$taskId" params={{ taskId: 'open-directly' }} disabled>
            Run Detail
          </NavLink>
        </nav>
        <div className="absolute bottom-4 left-4 right-4 grid gap-2 text-xs text-muted-foreground">
          {membership?.role === 'admin' ? <NavLink to="/users" active={location.pathname === '/users'}>Users</NavLink> : null}
          <div
            className={cn(
              'rounded-lg border p-3',
              isProd
                ? 'border-danger-border bg-danger-bg text-danger'
                : 'border-border bg-surface-muted text-muted-foreground'
            )}
          >
            <div className="flex items-center gap-2 font-medium">
              <ShieldCheck className="h-4 w-4" />
              {environment}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-surface-muted p-3">
            <div className="flex items-center gap-2">
              <UserCircle className="h-4 w-4" />
              {auth.session.user.email}
            </div>
          </div>
        </div>
      </aside>
      <div className="lg:pl-64">
        <header className="sticky top-0 z-10 border-b border-border bg-background/88 px-4 py-3 backdrop-blur lg:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Activity className="h-5 w-5 text-primary" />
              <div>
                <p className="text-sm font-medium">Execution investigation</p>
                <p className="text-xs text-muted-foreground">Manual refresh MVP · last updated after each fetch</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Active tenant"
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                value={preferredTenant}
                onChange={(event) => {
                  window.localStorage.setItem('callagent.operator.tenant', event.target.value);
                  const url = new URL(window.location.href);
                  url.searchParams.set('tenantId', event.target.value);
                  window.location.assign(url);
                }}
              >
                {auth.session.memberships.map((item) => <option key={item.id} value={item.tenantId}>{item.tenantId} · {item.role}</option>)}
              </select>
              <div className="hidden items-center gap-2 rounded-md border border-border bg-card/80 px-3 py-1.5 text-sm text-muted-foreground md:flex">
                <Search className="h-4 w-4" />
                Global search reserved
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={theme.toggleTheme}
                aria-label={`Switch to ${theme.theme === 'dark' ? 'light' : 'dark'} theme`}
              >
                {theme.theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                {theme.theme === 'dark' ? 'Light' : 'Dark'}
              </Button>
              <Button variant="ghost" size="sm">
                <HelpCircle className="h-4 w-4" />
                Help
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void auth.signOut()}>
                <LogOut className="h-4 w-4" />
                Sign out
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
    return <span className="rounded-md px-3 py-2 text-sm text-muted-foreground/55">{props.children}</span>;
  }
  return (
    <Link
      to={props.to}
      params={props.params}
      className={cn(
        'relative rounded-md px-3 py-2 pl-4 text-sm transition-colors hover:bg-accent hover:text-accent-foreground',
        props.active ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground'
      )}
    >
      {props.active ? <span className="absolute left-1 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary" /> : null}
      {props.children}
    </Link>
  );
}
