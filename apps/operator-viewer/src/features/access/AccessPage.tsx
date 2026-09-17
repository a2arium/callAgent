import { useEffect, useState } from 'react';
import { useAuth } from '../../app/auth';
import { Button } from '../../design/components/ui/button';

type Member = { id: string; tenantId: string; role: 'viewer' | 'operator' | 'admin'; status: 'active' | 'disabled'; user: { id: string; name: string; email: string } };
type Invitation = { id: string; email: string; role: string; status: string; expiresAt: string };

export function AccessPage(): React.ReactElement {
  const { session, refresh } = useAuth();
  const tenantId = window.localStorage.getItem('callagent.operator.tenant') || session.memberships[0]?.tenantId || 'default';
  const current = session.memberships.find((membership) => membership.tenantId === tenantId);
  const [members, setMembers] = useState<Member[]>([]); const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [email, setEmail] = useState(''); const [role, setRole] = useState<'viewer' | 'operator' | 'admin'>('viewer'); const [link, setLink] = useState(''); const [error, setError] = useState('');
  const headers = { 'content-type': 'application/json', 'x-tenant-id': tenantId };
  const load = async () => {
    const response = await fetch('/operator-api/access', { credentials: 'same-origin', headers: { 'x-tenant-id': tenantId } });
    if (!response.ok) { setError(await responseMessage(response)); return; }
    const body = await response.json() as { memberships: Member[]; invitations: Invitation[] };
    setMembers(body.memberships); setInvitations(body.invitations); setError('');
  };
  useEffect(() => { if (current?.role === 'admin') void load(); }, [tenantId, current?.role]);
  if (current?.role !== 'admin') return <Panel title="Users"><p className="text-sm text-muted-foreground">Tenant admin access is required.</p></Panel>;
  const invite = async (event: React.FormEvent) => {
    event.preventDefault(); setLink(''); setError('');
    const response = await fetch('/operator-api/access/invitations', { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify({ email, role }) });
    if (!response.ok) { setError(await responseMessage(response)); return; }
    const body = await response.json() as { url: string }; setLink(body.url); setEmail(''); await load();
  };
  const updateMember = async (member: Member, patch: Record<string, string>) => {
    const response = await fetch(`/operator-api/access/memberships/${encodeURIComponent(member.id)}`, { method: 'PATCH', credentials: 'same-origin', headers, body: JSON.stringify(patch) });
    if (!response.ok) { setError(await responseMessage(response)); return; } await load(); await refresh();
  };
  const reset = async (userId: string) => {
    const response = await fetch(`/operator-api/access/users/${encodeURIComponent(userId)}/reset-link`, { method: 'POST', credentials: 'same-origin', headers, body: '{}' });
    if (!response.ok) { setError(await responseMessage(response)); return; } const body = await response.json() as { url: string }; setLink(body.url);
  };
  return <div className="grid gap-6">
    <div><h2 className="text-2xl font-semibold">Users</h2><p className="text-sm text-muted-foreground">Named users and invitations for tenant <span className="font-mono">{tenantId}</span>.</p></div>
    <Panel title="Create invitation">
      <form className="flex flex-wrap items-end gap-3" onSubmit={invite}><label className="grid flex-1 gap-1 text-sm"><span>Email</span><input className="h-10 rounded-md border border-input bg-background px-3" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label><label className="grid gap-1 text-sm"><span>Role</span><select className="h-10 rounded-md border border-input bg-background px-3" value={role} onChange={(e) => setRole(e.target.value as typeof role)}><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Admin</option></select></label><Button type="submit">Generate link</Button></form>
      {link ? <OneTimeLink link={link} /> : null}{error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
    </Panel>
    <Panel title="Members"><div className="grid gap-3">{members.map((member) => <div key={member.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3"><div className="min-w-52 flex-1"><p className="font-medium">{member.user.name}</p><p className="text-xs text-muted-foreground">{member.user.email}</p></div><select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={member.role} onChange={(e) => void updateMember(member, { role: e.target.value })}><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Admin</option></select><Button variant="ghost" size="sm" onClick={() => void updateMember(member, { status: member.status === 'active' ? 'disabled' : 'active' })}>{member.status === 'active' ? 'Disable' : 'Enable'}</Button>{session.installationOwner ? <Button variant="ghost" size="sm" onClick={() => void reset(member.user.id)}>Reset link</Button> : null}{session.installationOwner && member.user.id !== session.user.id && member.role === 'admin' && member.status === 'active' ? <Button variant="ghost" size="sm" onClick={async () => { const response = await fetch('/operator-api/access/owner/transfer', { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify({ userId: member.user.id }) }); if (!response.ok) setError(await responseMessage(response)); else await refresh(); }}>Make owner</Button> : null}</div>)}</div></Panel>
    <Panel title="Pending invitations"><div className="grid gap-2">{invitations.length === 0 ? <p className="text-sm text-muted-foreground">No pending invitations.</p> : invitations.map((inviteRow) => <div key={inviteRow.id} className="flex items-center gap-3 rounded-lg border border-border p-3"><div className="flex-1"><p className="text-sm font-medium">{inviteRow.email}</p><p className="text-xs text-muted-foreground">{inviteRow.role} · expires {new Date(inviteRow.expiresAt).toLocaleString()}</p></div><Button variant="ghost" size="sm" onClick={async () => { const response = await fetch(`/operator-api/access/invitations/${inviteRow.id}/revoke`, { method: 'POST', credentials: 'same-origin', headers, body: '{}' }); if (!response.ok) setError(await responseMessage(response)); else await load(); }}>Revoke</Button></div>)}</div></Panel>
  </div>;
}

function Panel(props: { title: string; children: React.ReactNode }): React.ReactElement { return <section className="rounded-xl border border-border bg-card p-4"><h3 className="mb-4 font-semibold">{props.title}</h3>{props.children}</section>; }
function OneTimeLink(props: { link: string }): React.ReactElement { return <div className="mt-4 rounded-lg border border-warning-border bg-warning-bg p-3"><p className="text-xs font-semibold uppercase tracking-wide">Shown once</p><div className="mt-2 flex gap-2"><input className="min-w-0 flex-1 rounded border border-input bg-background px-2 font-mono text-xs" readOnly value={props.link} /><Button size="sm" type="button" onClick={() => void navigator.clipboard.writeText(props.link)}>Copy</Button></div></div>; }
async function responseMessage(response: Response): Promise<string> { try { const body = await response.json() as { message?: string; error?: string }; return body.message ?? body.error ?? `${response.status}`; } catch { return `${response.status} ${response.statusText}`; } }
