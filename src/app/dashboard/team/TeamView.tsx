'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { friendlyError } from '@/lib/rpc-error';
import { inputClass } from '@/components/ui';
import type { StaffRole } from '@/lib/context';

type Member = { id: string; display_name: string; role: StaffRole; is_active: boolean; is_me: boolean };
type Invite = { id: string; display_name: string; role: StaffRole; expires_at: string };
type NewInvite = Invite & { code: string };

const ROLE_HELP: Record<Exclude<StaffRole, 'owner'>, string> = {
  manager: 'Runs the floor, menu and settings',
  waiter: 'Takes care of tables and serves food',
  chef: 'Sees the kitchen screen',
  cashier: 'Takes payments',
};

export function TeamView({ myRole, joinUrl }: { myRole: StaffRole; joinUrl: string }) {
  const [team, setTeam] = useState<{ staff: Member[]; invites: Invite[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [created, setCreated] = useState<NewInvite | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState<StaffRole>('waiter');
  const [busy, setBusy] = useState(false);
  const assignable = (Object.keys(ROLE_HELP) as StaffRole[]).filter((r) => myRole === 'owner' || r !== 'manager');

  const load = useCallback(async () => {
    const { data, error: e } = await createClient().rpc('staff_team');
    if (e) setError(friendlyError(e, 'Could not load your team.'));
    else setTeam(data as { staff: Member[]; invites: Invite[] });
  }, []);
  useEffect(() => {
    void createClient().rpc('staff_team').then(({ data, error: e }) => {
      if (e) setError(friendlyError(e, 'Could not load your team.'));
      else setTeam(data as { staff: Member[]; invites: Invite[] });
    });
  }, []);

  async function run(fn: () => PromiseLike<{ data?: unknown; error: { message?: string } | null }>, ok: string | null) {
    setBusy(true); setError(null); setNotice(null);
    const res = await fn();
    setBusy(false);
    if (res.error) { setError(friendlyError(res.error)); return null; }
    setNotice(ok);
    await load();
    return res;
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    const res = await run(() => createClient().rpc('create_staff_invite', { p_role: role, p_display_name: name }), null);
    if (res) { setCreated(res.data as NewInvite); setName(''); }
  }

  const canManage = (m: Member) => !m.is_me && m.role !== 'owner' && (myRole === 'owner' || m.role !== 'manager');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
        <p className="mt-1 text-stone-600">Invite your staff with a one-time code. Each person signs up with their own email and enters the code.</p>
      </div>
      {error ? <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
      {notice ? <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p> : null}

      <section aria-label="Invite someone" className="space-y-4 rounded-2xl border border-stone-200 bg-white p-5">
        <h2 className="font-semibold">Invite someone</h2>
        <form onSubmit={invite} className="flex flex-wrap items-end gap-3">
          <div className="min-w-48 flex-1">
            <label htmlFor="i-name" className="block text-sm font-medium">Their name</label>
            <input id="i-name" required className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label htmlFor="i-role" className="block text-sm font-medium">Job</label>
            <select id="i-role" className={inputClass} value={role} onChange={(e) => setRole(e.target.value as StaffRole)}>
              {assignable.map((r) => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}
            </select>
          </div>
          <button disabled={busy} className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Create invite code</button>
        </form>
        {role !== 'owner' ? <p className="text-sm text-stone-500">{ROLE_HELP[role as Exclude<StaffRole, 'owner'>]}.</p> : null}
        {created ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4" data-testid="invite-code">
            <p className="text-sm text-amber-900">Give this code to <b>{created.display_name}</b>. It works once and expires in 7 days. You won’t see it again.</p>
            <p className="my-2 font-mono text-3xl font-semibold tracking-widest">{created.code}</p>
            <p className="text-sm text-amber-900">They open <b>{joinUrl}</b>, sign up, and type the code.</p>
          </div>
        ) : null}
      </section>

      {team?.invites.length ? (
        <section aria-label="Waiting to join" className="rounded-2xl border border-stone-200 bg-white">
          <h2 className="border-b border-stone-100 px-5 py-3 font-semibold">Waiting to join</h2>
          <ul className="divide-y divide-stone-100">
            {team.invites.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <span className="flex-1"><b>{i.display_name}</b> <span className="text-sm capitalize text-stone-500">· {i.role} · expires {new Date(i.expires_at).toLocaleDateString()}</span></span>
                <button type="button" disabled={busy} onClick={() => run(() => createClient().rpc('revoke_staff_invite', { p_id: i.id }), `Cancelled ${i.display_name}’s invite.`)}
                        className="rounded-lg px-3 py-1.5 text-sm text-red-700 hover:bg-red-50">Cancel invite</button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Your team" className="rounded-2xl border border-stone-200 bg-white">
        <h2 className="border-b border-stone-100 px-5 py-3 font-semibold">Your team</h2>
        {!team ? <p className="px-5 py-6 text-stone-500">Loading…</p> : (
          <ul className="divide-y divide-stone-100">
            {team.staff.map((m) => (
              <li key={m.id} className={`flex flex-wrap items-center gap-3 px-5 py-3 ${m.is_active ? '' : 'opacity-60'}`}>
                <span className="min-w-40 flex-1 font-medium">{m.display_name}{m.is_me ? ' (you)' : ''}</span>
                {canManage(m) ? (
                  <>
                    <select aria-label={`Job for ${m.display_name}`} className={`${inputClass} !w-36`} value={m.role} disabled={busy}
                            onChange={(e) => run(() => createClient().rpc('update_staff_member', { p_staff_id: m.id, p_role: e.target.value, p_active: null }), `${m.display_name} is now a ${e.target.value}.`)}>
                      {assignable.map((r) => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}
                    </select>
                    <button type="button" disabled={busy}
                            onClick={() => run(() => createClient().rpc('update_staff_member', { p_staff_id: m.id, p_role: null, p_active: !m.is_active }),
                              m.is_active ? `${m.display_name} can no longer log in.` : `${m.display_name} can log in again.`)}
                            className={`rounded-full px-3 py-1.5 text-sm font-medium ${m.is_active ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200' : 'bg-stone-100 text-stone-600'}`}>
                      {m.is_active ? 'Active' : 'Turned off'}
                    </button>
                  </>
                ) : <span className="text-sm capitalize text-stone-500">{m.role}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
