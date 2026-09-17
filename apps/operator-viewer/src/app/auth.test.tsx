// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AuthGate } from './auth';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/operator/');
});

describe('AuthGate', () => {
  it('shows named-user sign in when there is no session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })));
    render(<AuthGate><div>private observer</div></AuthGate>);
    expect(await screen.findByText('Sign in to Observer')).toBeTruthy();
    expect(screen.queryByText('private observer')).toBeNull();
  });

  it('renders the app and selects only a server-provided membership tenant', async () => {
    window.localStorage.setItem('callagent.operator.tenant', 'untrusted');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      user: { id: 'user-1', name: 'Ada', email: 'ada@example.test' },
      mustChangePassword: false,
      installationOwner: false,
      memberships: [{ id: 'membership-1', tenantId: 'tenant-safe', role: 'viewer' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    render(<AuthGate><div>private observer</div></AuthGate>);
    expect(await screen.findByText('private observer')).toBeTruthy();
    await waitFor(() => expect(window.localStorage.getItem('callagent.operator.tenant')).toBe('tenant-safe'));
    expect(window.localStorage.getItem('callagent.operator.token')).toBeNull();
  });
});
