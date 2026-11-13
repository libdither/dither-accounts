/**
 * Sessions: the browsers signed in to this page (auth.ts). Each lasts 90 days from its last use, at most a year from
 * its login; any can be signed out here, and setting the password again (cli.ts set-password) signs out all of them.
 */
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import type { SessionInfo } from '../../../src/api-types.ts';
import { act, ago, api, confirm, toast } from '../state.ts';
import { Card, Empty } from './bits.tsx';

const sessions = signal<SessionInfo[] | null>(null);
async function load() {
  try {
    sessions.value = (await api<{ sessions: SessionInfo[] }>('/api/sessions')).sessions;
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

/** "Firefox on Linux" from a user agent, as far as it says. */
function browser(ua: string | null): string {
  if (!ua) return 'Unknown browser';
  const name = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : null;
  return os ? `${name} on ${os}` : name;
}
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export function Sessions() {
  useEffect(() => {
    void load();
  }, []);
  const rows = sessions.value;
  const revoke = async (s: SessionInfo) => {
    if (s.current && !(await confirm('Sign this browser out?', 'You will need the password to come back.', 'Sign out'))) return;
    if (await act(`/api/sessions/${s.id}`, { method: 'DELETE' }, 'Signed out')) {
      if (s.current) location.href = '/login';
      else void load();
    }
  };
  const others = async () => {
    if (await confirm('Sign out every other browser?', 'Only this one stays signed in.', 'Sign them out')) {
      await act('/api/sessions?others=1', { method: 'DELETE' }, 'Signed out the others');
      void load();
    }
  };
  return (
    <div class="page">
      <p class="lede">
        Browsers signed in to this page. A session lasts 90 days from its last use and at most a year from its sign-in. Setting the password again (<code>cli.ts set-password</code>) signs out every one.
      </p>
      <div class="row toolbar">
        <span class="grow" />
        <button class="btn sm ghost" onClick={others} disabled={!rows || rows.filter((s) => !s.current).length === 0} data-revoke-others>
          Sign out the others
        </button>
      </div>
      {!rows ? (
        <p class="muted">Loading…</p>
      ) : !rows.length ? (
        <Empty>No browser is signed in (this one came in with the CLI's token).</Empty>
      ) : (
        <Card class="sessions">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Browser</th>
                  <th>Signed in</th>
                  <th>Last used</th>
                  <th>Ends</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} data-session={s.id}>
                    <td class="ua">
                      <b>{browser(s.userAgent)}</b>
                      {s.current && <span class="muted"> · this one</span>}
                      <div class="muted small" title={s.userAgent ?? ''}>
                        {s.lastIp ?? s.ip ?? 'unknown address'}
                        {s.ip && s.lastIp && s.ip !== s.lastIp ? ` (signed in from ${s.ip})` : ''}
                      </div>
                    </td>
                    <td>{day(s.createdAt)}</td>
                    <td>{ago(s.lastUsed)}</td>
                    <td>{day(s.expiresAt)}</td>
                    <td class="num">
                      <button class="btn sm ghost" onClick={() => revoke(s)} data-revoke={s.id}>
                        Sign out
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
