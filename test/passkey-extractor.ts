/**
 * A test extractor that holds passkeys for privacy.com like the privacy and schwab kinds do, without a browser: the
 * test sends it the page's request as a command (`webauthn`, a WebauthnUp's op, options and caller) and gets the
 * answer the page would. Its authenticator reaches the approver through the link (approverVia). test/approver.test.ts.
 */
import { linkManager } from '@dither-accounts/link';
import { approverVia, Authenticator, respond, secretStore, type WebauthnUp } from '../packages/passkey/src/index.ts';

const link = linkManager({
  onConnect: () => {
    link.emit({ t: 'hello', version: '1', label: link.label });
    link.emit({ t: 'status', status: 'online' });
  },
  async onCommand(cmd) {
    if (cmd.t === 'webauthn') {
      const r = await respond(auth, { ...cmd, sid: 'test', page: String(cmd.origin), top: true } as unknown as WebauthnUp);
      if (r.refused) link.log('warn', 'passkey request refused', { code: r.refused.code, reason: r.refused.message });
      return r.answer;
    }
    if (cmd.t === 'summary') return auth.summary();
    throw new Error(`unknown op ${cmd.t}`);
  },
});
const auth = new Authenticator(secretStore(link), ['privacy.com'], Date.now, 'top', undefined, approverVia(link));
auth.reasonFor = (op) => (op === 'create' ? 'Add a passkey in the test' : 'Sign in for the test');
