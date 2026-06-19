import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { AppShell } from './AppShell';
import { parseFleetSearch, parseRunSearch } from './state';
import { FleetPage } from '../features/fleet/FleetPage';
import { RunDetailPage } from '../features/run/RunDetailPage';
import { AgentsPage } from '../features/agents/AgentsPage';

const rootRoute = createRootRoute({
  component: AppShell,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (search: Record<string, unknown>) => parseFleetSearch(search),
  component: FleetPage,
});

const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/runs/$taskId',
  validateSearch: (search: Record<string, unknown>) => parseRunSearch(search),
  component: RunDetailPage,
});

const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/agents',
  component: AgentsPage,
});

const routeTree = rootRoute.addChildren([indexRoute, agentsRoute, runRoute]);

export const router = createRouter({
  routeTree,
  basepath: window.location.pathname.startsWith('/operator') ? '/operator' : '/',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
