/**
 * What an account needs from you, from its status's attention: the message, a live view to open, and a QR code to
 * scan when it carries one (any kind may). Chat accounts also get the actions that answer their attention, run as
 * their `action` operation through the same checks as an app's call (counted under "This page"): a new link code
 * (Signal, WhatsApp, Telegram, Google Messages), a pairing code for a phone number (WhatsApp), a phone number and the
 * code sent to it (Telegram), the emoji to tap on the phone (Google Messages), and a password or cookies to sign in
 * again (Matrix, Telegram's two-step password; Google Messages' cookies).
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { renderSVG } from 'uqr';
import type { AccountInfo, PageCallResult } from '../../../src/api-types.ts';
import { api, toast } from '../state.ts';

export interface Attention {
  kind?: string;
  message?: string;
  liveView?: boolean;
  /** A URI to show as a QR code (a device link). */
  qr?: string;
  /** When the extractor replaces `qr` with a fresh one. */
  qrRefreshAt?: number;
  detail?: unknown;
}

export const attentionOf = (a: AccountInfo): Attention | null => (a.status?.attention as Attention | undefined) ?? null;

/** Black on white with a quiet zone and square edges, the way phone scanners want it. */
export const qrSvg = (text: string) => renderSVG(text, { ecc: 'M', border: 4, whiteColor: '#ffffff', blackColor: '#000000' }).replace('<svg ', '<svg shape-rendering="crispEdges" ');

/** A chat account's `action` operation, from the page. */
async function chatAction(a: AccountInfo, action: string, args?: Record<string, unknown>): Promise<unknown> {
  const r = await api<PageCallResult>(`/api/accounts/${a.id}/call`, { method: 'POST', body: { op: 'action', input: { action, ...(args ? { args } : {}) } } });
  if (!r.ok) throw new Error(r.error?.message ?? 'it failed');
  return r.result;
}

function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

function LinkCode({ a, at }: { a: AccountInfo; at: Attention }) {
  const chat = a.interfaces.includes('chat');
  const wa = a.kind === 'whatsapp';
  // A phone number instead of the QR: WhatsApp answers with a pairing code to type on the phone, Telegram sends a code.
  const byPhone = wa || a.kind === 'telegram';
  const pairCode = (at.detail as { pairCode?: unknown } | undefined)?.pairCode;
  const svg = useMemo(() => (at.qr ? qrSvg(at.qr) : null), [at.qr]);
  const now = useNow(!!at.qrRefreshAt);
  const [busy, setBusy] = useState('');
  const [phone, setPhone] = useState('');
  const run = async (what: string, action: string, args?: Record<string, unknown>) => {
    setBusy(what);
    try {
      await chatAction(a, action, args);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };
  const left = at.qrRefreshAt ? Math.max(0, Math.ceil((at.qrRefreshAt - now) / 1000)) : null;
  return (
    <div class="link-code" data-link-code>
      {typeof pairCode === 'string' ? (
        <p class="pair-code" data-pair-code>
          {pairCode}
        </p>
      ) : (
        svg && <div class="qr" role="img" aria-label="The code to scan" data-qr={at.qr} dangerouslySetInnerHTML={{ __html: svg }} />
      )}
      <div class="link-side">
        {svg && typeof pairCode !== 'string' && <p class="small muted">{left === null ? 'It refreshes by itself when it expires.' : left > 0 ? `A new code replaces this one in ${left} s.` : 'Getting a new code…'}</p>}
        {typeof pairCode === 'string' && <p class="small muted">Type this code on your phone where WhatsApp asks for it.</p>}
        {chat && byPhone && typeof pairCode !== 'string' && (
          <form
            class="row"
            onSubmit={(e) => {
              e.preventDefault();
              void run('pair', 'pairPhone', { phone: phone.trim() });
            }}
          >
            <input type="tel" placeholder="+15551234567" value={phone} onInput={(e) => setPhone((e.target as HTMLInputElement).value)} aria-label="Your phone number, with its country code" data-pair-phone />
            <button class="btn sm" disabled={!!busy || phone.replace(/\D/g, '').length < 7}>
              {busy === 'pair' ? 'Asking…' : wa ? 'Get a pairing code' : 'Sign in by number'}
            </button>
          </form>
        )}
        {chat && (
          <div class="row">
            <button class="btn sm ghost" disabled={!!busy} onClick={() => run('new', 'refreshLink')} data-new-code>
              {busy === 'new' ? 'Asking…' : 'New code'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Telegram's sign-in by number: the code it sent (in the app or by SMS), again, or back to a QR code. */
function CodeEntry({ a, code }: { a: AccountInfo; code: { type?: string; length?: number; next?: string } }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState('');
  const run = async (what: string, action: string, args?: Record<string, unknown>) => {
    setBusy(what);
    try {
      await chatAction(a, action, args);
      if (what === 'sign') setValue('');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };
  const digits = value.replace(/\D/g, '');
  return (
    <div class="link-side" data-code-entry>
      <form
        class="row"
        onSubmit={(e) => {
          e.preventDefault();
          void run('sign', 'signIn', { code: digits });
        }}
      >
        <input inputMode="numeric" autocomplete="one-time-code" placeholder={code.length ? '•'.repeat(code.length) : 'Code'} maxLength={12} value={value} onInput={(e) => setValue((e.target as HTMLInputElement).value)} aria-label="The code" data-code />
        <button class="btn sm primary" disabled={!!busy || digits.length < (code.length ?? 4)}>
          {busy === 'sign' ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <div class="row">
        <button class="btn sm ghost" disabled={!!busy} onClick={() => run('again', 'resendCode')} data-resend>
          {busy === 'again' ? 'Asking…' : code.next ? `Send it again (${code.next.toLowerCase()})` : 'Send it again'}
        </button>
        <button class="btn sm ghost" disabled={!!busy} onClick={() => run('qr', 'refreshLink')}>
          Use a QR code instead
        </button>
      </div>
    </div>
  );
}

/** Matrix (or any chat account whose sign-in lapsed without a browser): a password, and it signs in again. */
function Relogin({ a }: { a: AccountInfo }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    try {
      await chatAction(a, 'relogin', { password });
      setPassword('');
      toast('Signed in again');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="row" onSubmit={submit} data-relogin>
      <input type="password" autocomplete="off" placeholder="Password" value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} aria-label="Password" />
      <button class="btn sm primary" disabled={busy || !password}>
        {busy ? 'Signing in…' : 'Sign in again'}
      </button>
    </form>
  );
}

/** A Haveno account's password: opens the account; kept in memory, and in secret.json only when remembered. */
function HavenoUnlock({ a }: { a: AccountInfo }) {
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    try {
      await chatAction(a, 'unlock', { password, remember });
      setPassword('');
      toast('Unlocked; the wallet syncs now');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="row" onSubmit={submit} data-haveno-unlock>
      <input type="password" autocomplete="off" placeholder="Account password" value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} aria-label="Account password" />
      <label class="small">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember((e.target as HTMLInputElement).checked)} /> remember (on disk, so it opens after a reboot)
      </label>
      <button class="btn sm primary" disabled={busy || !password}>
        {busy ? 'Opening…' : 'Unlock'}
      </button>
    </form>
  );
}

/**
 * A Haveno account's desktop app: open it in the live view (the node stops meanwhile), or quit it (Haveno may ask
 * there first) so the node comes back.
 */
export function HavenoControls({ a, onLive }: { a: AccountInfo; onLive: () => void }) {
  const phase = (a.status?.details as { phase?: string } | undefined)?.phase;
  const [busy, setBusy] = useState('');
  const run = async (what: string, action: string, args?: Record<string, unknown>, after?: () => void) => {
    setBusy(what);
    try {
      await chatAction(a, action, args);
      after?.();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };
  const inApp = phase === 'app';
  return (
    <div class="row pane-banner" data-haveno-controls>
      {inApp ? (
        <>
          <button class="btn sm" disabled={!!busy || !a.liveView} onClick={onLive}>
            Open live view
          </button>
          <button class="btn sm" disabled={!!busy} onClick={() => run('quit', 'closeApp', undefined, () => toast('Asked the app to quit; confirm in the live view if it asks'))}>
            {busy === 'quit' ? 'Asking…' : 'Back to the node'}
          </button>
          <button class="btn sm ghost danger-text" disabled={!!busy} onClick={() => confirm('Stop the app without asking it? Like pulling the plug: the wallet survives it, but it is a last resort.') && run('kill', 'closeApp', { force: true })}>
            Force quit
          </button>
        </>
      ) : (
        <button
          class="btn sm"
          disabled={!!busy || phase === 'handover' || !a.running}
          onClick={() => run('open', 'openApp', undefined, onLive)}
          title="Haveno's own screens in a live view; the node (and apps' access) stops until the app quits"
        >
          {busy === 'open' || phase === 'handover' ? 'Opening the app…' : 'Open the Haveno app'}
        </button>
      )}
    </div>
  );
}

/**
 * A captcha the owner solves in their own browser (Signal's rate-limit challenge): the page to open, and where to
 * paste the link "Open Signal" points at afterwards. Nothing solves it for them.
 */
function CaptchaEntry({ a, check }: { a: AccountInfo; check: { url: string; action: string } }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    try {
      await chatAction(a, check.action, { captcha: token.trim() });
      setToken('');
      toast('Sent; Signal takes it from here');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="stack" onSubmit={submit} data-captcha>
      <p class="small">
        Open{' '}
        <a href={check.url} target="_blank" rel="noopener noreferrer">
          the captcha page
        </a>
        , solve it, then right-click “Open Signal”, copy the link and paste it here.
      </p>
      <div class="row">
        <input autocomplete="off" spellcheck={false} placeholder="signalcaptcha://…" value={token} onInput={(e) => setToken((e.target as HTMLInputElement).value)} aria-label="The captcha link" />
        <button class="btn sm primary" disabled={busy || !token.trim()}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </form>
  );
}

/** Google Messages paired through a Google account: the cookies of messages.google.com, signed in. */
function GoogleCookies({ a }: { a: AccountInfo }) {
  const [cookies, setCookies] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!cookies.trim()) return;
    setBusy(true);
    try {
      await chatAction(a, 'pairGoogle', { cookies: cookies.trim() });
      setCookies('');
      toast('Sent; look at your phone');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="stack" onSubmit={submit} data-google-cookies>
      <textarea
        rows={3}
        autocomplete="off"
        spellcheck={false}
        placeholder="Cookies of messages.google.com, signed in: “Copy as cURL” from the browser's network tab, a cookie export, or SID=…; HSID=…"
        value={cookies}
        onInput={(e) => setCookies((e.target as HTMLTextAreaElement).value)}
        aria-label="Cookies of messages.google.com"
      />
      <div class="row">
        <button class="btn sm primary" disabled={busy || !cookies.trim()}>
          {busy ? 'Pairing…' : 'Pair with Google'}
        </button>
        <span class="small faint">They go to the account's secret.json on this machine; the page never shows them again.</span>
      </div>
    </form>
  );
}

export function AttentionBlock({ a, onLive }: { a: AccountInfo; onLive: () => void }) {
  const at = attentionOf(a);
  if (!at) return null;
  const chat = a.interfaces.includes('chat');
  const { verification, code, emoji, captcha } = (at.detail ?? {}) as { verification?: unknown; code?: unknown; emoji?: unknown; captcha?: { url?: unknown; action?: unknown } };
  return (
    <div class="attention-block pane-banner" data-attention={at.kind ?? ''}>
      <div class="banner attention">
        <span>
          <strong>Needs you:</strong> {at.message ?? at.kind ?? 'It needs you'}
        </span>
        {at.liveView && a.liveView && (
          <button class="btn sm primary" onClick={onLive}>
            Open live view
          </button>
        )}
      </div>
      {(at.qr || at.kind === 'link_device') && <LinkCode a={a} at={at} />}
      {chat && at.kind === 'verify' && !!code && typeof code === 'object' && <CodeEntry a={a} code={code as { type?: string; length?: number; next?: string }} />}
      {at.kind === 'verify' && typeof emoji === 'string' && (
        <p class="pair-emoji" data-pair-emoji aria-label={`Tap ${emoji} on your phone`}>
          {emoji}
        </p>
      )}
      {chat && at.kind === 'captcha' && typeof captcha?.url === 'string' && typeof captcha.action === 'string' && <CaptchaEntry a={a} check={{ url: captcha.url, action: captcha.action }} />}
      {chat && at.kind === 'login' && !at.liveView && (a.kind === 'gmessages' ? <GoogleCookies a={a} /> : <Relogin a={a} />)}
      {a.kind === 'haveno' && at.kind === 'login' && <HavenoUnlock a={a} />}
      {chat && !!verification && <p class="small muted">A device verification is waiting. Finish it in dither-chat, or with the action verifyDevice under Try it.</p>}
    </div>
  );
}
