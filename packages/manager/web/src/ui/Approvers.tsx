/**
 * Approvers: phones paired to hold passkeys for the privacy and schwab accounts (docs/approver.md). Pair a phone (a
 * one-time code as a QR of dither-approver://pair?url=…&code=…, and as text), see each device's key fingerprint (the
 * app shows the same: compare them), whether it is linked now, and remove it; and the recent requests and how each
 * ended.
 */
import { signal } from '@preact/signals';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ApproverPairing, ApproversState } from '../../../src/api-types.ts';
import { accountName, act, ago, api, confirm, copy, named, toast } from '../state.ts';
import { qrSvg } from './Attention.tsx';
import { Card, Dot, Empty } from './bits.tsx';

export const approvers = signal<ApproversState | null>(null);
export async function loadApprovers() {
  try {
    approvers.value = await api<ApproversState>('/api/approvers');
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

const OUTCOMES: Record<string, string> = {
  waiting: 'Waiting',
  ok: 'Approved',
  denied: 'Denied',
  refused: 'Refused by the app',
  expired: 'Expired',
  'unknown-credential': 'Not on that phone',
  error: 'Failed',
  'no-device': 'No such device',
};
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

function Pairing({ p, onClose }: { p: ApproverPairing; onClose: () => void }) {
  const svg = useMemo(() => qrSvg(p.link), [p.link]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((p.expiresAt - now) / 1000));
  return (
    <Card class="pairing" data-pairing>
      <div class="link-code">
        {left > 0 ? <div class="qr" role="img" aria-label="The pairing code to scan" data-qr={p.link} dangerouslySetInnerHTML={{ __html: svg }} /> : <p class="muted">This code has expired.</p>}
        <div class="link-side">
          <p class="small">Scan it with dither-approver on your phone (Pair this phone), or paste the link there. The phone has to be on the tailnet.</p>
          <p class="small muted" data-pair-expiry>
            {left > 0 ? `Good once, for ${Math.floor(left / 60)} min ${left % 60} s more.` : 'Make a new one to pair.'}
          </p>
          <span class="row nowrap">
            <code class="path" data-pair-link>
              {p.link}
            </code>
            <button class="link-btn small flex-none" onClick={() => copy(p.link, 'Link copied')}>
              Copy
            </button>
          </span>
          <p class="small muted">When it is paired, compare the fingerprint below with the one the app shows.</p>
          <div class="row">
            <button class="btn sm ghost" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    </Card>
  );
}

export function Approvers() {
  const [pairing, setPairing] = useState<ApproverPairing | null>(null);
  useEffect(() => {
    void loadApprovers();
    const t = setInterval(() => document.visibilityState === 'visible' && void loadApprovers(), 3000);
    return () => clearInterval(t);
  }, []);
  const st = approvers.value;
  const deviceName = new Map((st?.devices ?? []).map((d) => [d.id, d.name]));
  const pair = async () => {
    const p = await act<ApproverPairing>('/api/approvers/pair', { method: 'POST' });
    if (p) setPairing(p);
  };
  const remove = async (id: string, name: string) => {
    if (!(await confirm(`Remove ${name}?`, 'Its link closes, and the passkeys on it stop working here. The keys stay on the phone until you remove them there, or in each site’s settings.', 'Remove'))) return;
    const r = await act<ApproversState>(`/api/approvers/${id}`, { method: 'DELETE' }, 'Removed');
    if (r) approvers.value = r;
  };
  return (
    <div class="page approvers">
      <p class="lede">
        Phones that hold passkeys for your Privacy.com and Schwab accounts, so this machine never has the key: each sign-in asks your phone, which shows the account, the site and why, and signs after your fingerprint. On an account’s pane, <b>Keep new passkeys on</b> picks the phone new ones go to.
      </p>
      <div class="row toolbar">
        <span class="grow" />
        <button class="btn sm" onClick={pair} data-pair>
          Pair a phone
        </button>
      </div>
      {pairing && <Pairing p={pairing} onClose={() => setPairing(null)} />}
      {!st ? (
        <p class="muted">Loading…</p>
      ) : !st.devices.length ? (
        <Empty>No phone is paired. Install dither-approver on your phone, then Pair a phone here.</Empty>
      ) : (
        <Card class="sessions">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Phone</th>
                  <th>Key fingerprint</th>
                  <th>Paired</th>
                  <th>Last seen</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {st.devices.map((d) => (
                  <tr key={d.id} data-device={d.id}>
                    <td>
                      <span class="row nowrap">
                        <Dot tone={d.online ? 'good' : 'off'} title={d.online ? 'Linked now' : 'Not linked'} />
                        <b>{d.name}</b>
                      </span>
                      <div class="muted small">
                        {d.online ? 'linked now' : d.push ? 'woken by push when needed' : 'no push: open the app to answer'}
                        {d.waiting > 0 && ` · ${d.waiting} waiting`}
                      </div>
                    </td>
                    <td>
                      <code class="mono" data-fingerprint>
                        {d.fingerprint}
                      </code>
                    </td>
                    <td>{day(d.pairedAt)}</td>
                    <td>{d.online ? 'now' : ago(d.lastSeenAt)}</td>
                    <td class="num">
                      <button class="btn sm ghost" onClick={() => remove(d.id, d.name)} data-remove-device={d.id}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {st && st.approvals.length > 0 && (
        <>
          <h3 class="section-title">Recent requests</h3>
          <Card class="sessions">
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Account</th>
                    <th>Site</th>
                    <th>Phone</th>
                    <th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {st.approvals.slice(0, 50).map((r) => {
                    const acc = accountName.value.get(r.account);
                    return (
                      <tr key={r.id} data-approval={r.id}>
                        <td title={new Date(r.createdAt).toLocaleString()}>{ago(r.createdAt)}</td>
                        <td>
                          {acc ? named(acc) : r.account}
                          <div class="muted small">{r.op === 'create' ? 'new passkey' : 'sign-in'}{r.reason ? ` · ${r.reason}` : ''}</div>
                        </td>
                        <td class="mono small">{r.rpId}</td>
                        <td>{deviceName.get(r.device) ?? <span class="muted">{r.device || '—'}</span>}</td>
                        <td title={r.message ?? ''}>
                          {OUTCOMES[r.outcome] ?? r.outcome}
                          {r.decidedAt && r.outcome !== 'waiting' && <div class="muted small">after {Math.max(0, Math.round((r.decidedAt - r.createdAt) / 1000))} s</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
