import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { AppShell } from './AppShell';
import { parseFleetSearch, parseRunSearch } from './state';
import { FleetPage } from '../features/fleet/FleetPage';
import { RunDetailPage } from '../features/run/RunDetailPage';
import { AgentsPage } from '../features/agents/AgentsPage';
import { MemoryPage } from '../features/memory/MemoryPage';
import { parseMemorySearch } from './state';
import { AccessPage } from '../features/access/AccessPage';

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

const memoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/memory',
  validateSearch: (search: Record<string, unknown>) => parseMemorySearch(search),
  component: MemoryPage,
});

const usersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/users',
  component: AccessPage,
});

const routeTree = rootRoute.addChildren([indexRoute, agentsRoute, memoryRoute, usersRoute, runRoute]);

export const router = createRouter({
  routeTree,
  basepath: window.location.pathname.startsWith('/operator') ? '/operator' : '/',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
