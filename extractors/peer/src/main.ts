/**
 * A chat account another manager holds, passed through as one of that manager's apps (docs/peer.md).
 *
 * config: `url` (the other manager), `account` (the account's id there), `level` (the most this side forwards: read
 * by default). secret.json: `{ app, token }`, this side's app on the other manager. Without them it registers there,
 * asking for `chat` at `level` on that one account, saves what it got and waits for the owner to approve it on that
 * manager's page.
 *
 * Calls go out as the other manager's calls and come back as its answers: its grant is the line that holds. An op
 * above `level` is refused here before it leaves, so even a wider grant there is not used. The account's events come
 * in as they are, except a live view's socket (a path on the other side) and an attention (its fix is on that side's
 * page, not here), which stay there. A start, the other manager coming back, and a gap there each ask for the
 * account's facts again with `snapshot`, which needs only read.
 */
import { AccountsClient, CallFailed, register } from '@dither-accounts/client';
import { chat } from '@dither-accounts/interfaces';
import { linkManager } from '@dither-accounts/link';
import { type Level, levelRank } from '@dither-accounts/spec';

type Ev = { t: string; [k: string]: unknown };
type Secret = { app?: string; token?: string; requests?: string[] };

const LEVELS = ['read', 'write', 'manage'] as const;

let client: AccountsClient | null = null;
let hello: Ev | null = null;
/** The other side's last status for the account, as it came. */
let theirs: Ev | null = null;
let reachable = false;
let approved = false;
let theirsOnline = false;
let setupNote = '';
/** Ask for the facts once the account is there and online: at start and after each reconnect (a restarted manager there kept nothing for us). */
let wantFacts = true;

const link = linkManager({
  onConnect: () => {
    if (hello) link.emit(hello);
    sendStatus();
  },
  async onCommand(cmd) {
    const { t: op, ...input } = cmd;
    const spec = (chat.ops as Record<string, { level: Level; timeoutMs?: number }>)[op];
    if (!spec) throw new Error(`chat has no op ${op}`);
    if (levelRank(spec.level) > levelRank(cap())) throw new Error(`${op} needs ${spec.level}, and this account passes on at most ${cap()} from ${remoteUrl()}`);
    if (!client) throw new Error(setupNote || 'not set up yet');
    try {
      return await client.callRaw(remoteAccount(), op, input, (spec.timeoutMs ?? 30_000) + 5_000);
    } catch (e) {
      if (e instanceof CallFailed) throw new Error(`${remoteUrl()} said ${e.code}: ${e.message}`);
      throw e;
    }
  },
  onShutdown: () => client?.close(),
});

const cap = (): Level => (LEVELS as readonly string[]).includes(link.config.level) ? link.config.level : 'read';
const remoteUrl = (): string => String(link.config.url ?? '');
const remoteAccount = (): string => String(link.config.account ?? '');

function sendStatus() {
  const layers = [
    { name: 'other manager', state: reachable ? 'ok' : client ? 'waiting' : 'failed', note: reachable ? remoteUrl() : setupNote || `not reached: ${remoteUrl()}` },
    { name: 'approved there', state: approved ? 'ok' : 'waiting', note: approved ? `chat at ${cap()}` : 'approve the request on its page' },
    { name: 'account there', state: theirsOnline ? 'ok' : 'waiting', note: theirsOnline ? 'online' : 'not online there' },
  ];
  const self = theirs?.self;
  if (!reachable || !approved) {
    const message = !client ? setupNote : !reachable ? `Can't reach ${remoteUrl()}` : `Approve this account's request on ${remoteUrl()}`;
    return link.emit({ t: 'status', status: !client || reachable ? 'attention' : 'offline', attention: { kind: 'unknown', message }, layers, ...(self ? { self } : {}) });
  }
  // As the other side says, without what belongs to that side.
  const st = String(theirs?.status ?? 'connecting');
  link.emit({ t: 'status', status: st === 'attention' ? 'offline' : st, attention: null, liveView: null, layers, ...(self ? { self } : {}) });
}

function snapshot() {
  client?.callRaw(remoteAccount(), 'snapshot', {}, 125_000).catch((e) => link.log('warn', `snapshot from ${remoteUrl()} failed: ${e instanceof Error ? e.message : e}`));
}

async function start() {
  if (!remoteUrl() || !remoteAccount()) {
    setupNote = 'config needs url and account';
    return sendStatus();
  }
  let sec = link.secret<Secret>();
  if (!sec.app || !sec.token) {
    try {
      const reg = await register(remoteUrl(), {
        // An app's name is at most 64 of letters, digits, space, dot and dash.
        name: `peer ${link.label}`.replace(/[^\w .-]+/g, ' ').trim().slice(0, 64),
        describe: `Another dither-accounts manager showing this account as its own, at most ${cap()}`,
        requests: [{ interface: 'chat', level: cap(), accounts: [remoteAccount()], reason: 'passed on to another manager (peer)' }],
      });
      sec = { app: reg.app, token: reg.token, requests: reg.requests.map((r) => r.id) };
      link.saveSecret(sec);
      link.log('info', `registered on ${remoteUrl()} as ${reg.app}; approve its request there`);
    } catch (e) {
      setupNote = `Can't register on ${remoteUrl()}: ${e instanceof Error ? e.message : e}`;
      sendStatus();
      // The other manager may be starting: try again in a while.
      setTimeout(start, 30_000);
      return;
    }
  }
  setupNote = '';
  client = new AccountsClient({
    url: remoteUrl(),
    app: sec.app!,
    token: sec.token!,
    onConnection: (up) => {
      reachable = up;
      if (up) wantFacts = true;
      sendStatus();
    },
    onAccounts: (views) => {
      const v = views.find((a) => a.id === remoteAccount());
      if (theirsOnline && !v?.online) wantFacts = true;
      approved = !!v;
      theirsOnline = !!v?.online;
      sendStatus();
      // Approved, back, or the account came up there: its facts again (its first ones went out before we read).
      if (approved && theirsOnline && wantFacts) {
        wantFacts = false;
        snapshot();
      }
    },
    onEvents: (account, events) => {
      if (account !== remoteAccount()) return;
      for (const e of events) {
        if (e.t === 'hello') {
          hello = e;
          link.emit(e);
        } else if (e.t === 'status') {
          theirs = e;
          sendStatus();
        } else link.emit(e);
      }
    },
    onGap: (account) => account === remoteAccount() && snapshot(),
  });
  sendStatus();
}

void start();
