/**
 * The live view: the account's sandboxed browser (its VNC, carried by /api/liveview/:id), full screen, to sign in or
 * to see what the extractor sees. dither-chat's live view, moved here with the accounts.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { AccountInfo } from '../../../src/api-types.ts';
import { kindName, named } from '../state.ts';

const XK = { CONTROL: 0xffe3, V: 0x76, SUPER_L: 0xffeb };

export function LiveView({ account, onClose }: { account: AccountInfo; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<any>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [state, setState] = useState('connecting');
  const [fit, setFit] = useState(true);
  const [text, setText] = useState('');
  const [show, setShow] = useState(false);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && e.shiftKey && onClose();
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [onClose]);

  /** Put text on the sandbox's clipboard and press Ctrl+V there, into whichever field has focus. */
  const sendText = (value: string, cmdHeld = false) => {
    const rfb = rfbRef.current;
    if (!rfb || !value) return;
    // Press the keys instead of pasting when the text is short and one line (a password, an address, a code), or when it
    // has characters beyond Latin-1, which the VNC clipboard would carry as "?". Short text then works in apps that
    // cannot read x11vnc's clipboard (GTK and JavaFX ones such as Haveno: its answer to "which formats?" is not one
    // they accept, so they paste nothing), and a password never sits on the sandbox's clipboard at all.
    if ((value.length <= 512 && !/[\r\n]/.test(value)) || /[^\x00-\xff]/.test(value)) {
      for (const ch of value) {
        const cp = ch.codePointAt(0)!;
        const sym = ch === '\n' ? 0xff0d : cp < 0x100 ? cp : 0x01000000 + cp;
        rfb.sendKey(sym, '', true);
        rfb.sendKey(sym, '', false);
      }
      return;
    }
    rfb.clipboardPasteFrom(value);
    // The clipboard has to arrive first. On a Mac the Cmd key is down in the sandbox too, and would make this a different shortcut.
    setTimeout(() => {
      if (cmdHeld) rfb.sendKey(XK.SUPER_L, 'MetaLeft', false);
      rfb.sendKey(XK.CONTROL, 'ControlLeft', true);
      rfb.sendKey(XK.V, 'KeyV', true);
      rfb.sendKey(XK.V, 'KeyV', false);
      rfb.sendKey(XK.CONTROL, 'ControlLeft', false);
      rfb.focus();
    }, 150);
    // It may be a password: do not leave it on the sandbox's clipboard. x11vnc ignores empty text, hence the space.
    clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => rfbRef.current?.clipboardPasteFrom(' '), 2000);
  };

  useEffect(() => {
    let dead = false;
    const el = box.current;
    // noVNC swallows every key, so the browser never gets as far as pasting. Let Ctrl+V through, and take the paste.
    let cmdHeld = false;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        cmdHeld = e.metaKey;
        e.stopPropagation();
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      sendText(e.clipboardData?.getData('text/plain') ?? '', cmdHeld);
      cmdHeld = false;
    };
    el?.addEventListener('keydown', onKey, true);
    el?.addEventListener('paste', onPaste, true);
    (async () => {
      // noVNC uses top-level await; load it only when a live view is opened.
      const { default: RFB } = await import('@novnc/novnc');
      if (dead || !el) return;
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/liveview/${account.id}`;
      const rfb: any = new RFB(el, url, { wsProtocols: ['binary'] });
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.focusOnClick = true;
      rfb.addEventListener('connect', () => {
        setState('connected');
        rfb.focus();
      });
      rfb.addEventListener('disconnect', (e: any) => setState(e.detail?.clean ? 'closed' : 'disconnected'));
      rfbRef.current = rfb;
    })().catch((e) => setState('error: ' + e.message));
    return () => {
      dead = true;
      clearTimeout(clearTimer.current);
      el?.removeEventListener('keydown', onKey, true);
      el?.removeEventListener('paste', onPaste, true);
      try {
        rfbRef.current?.clipboardPasteFrom(' ');
        rfbRef.current?.disconnect();
      } catch {}
      rfbRef.current = null;
    };
  }, [account.id]);

  useEffect(() => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    rfb.scaleViewport = fit;
    rfb.clipViewport = !fit;
    rfb.dragViewport = !fit;
  }, [fit]);

  const submit = () => {
    sendText(text);
    setText('');
    setShow(false);
  };

  return (
    <div class="lv-full" role="dialog" aria-label={`Live view of ${named(account)}`} data-liveview>
      <header class="lv-bar">
        <span class="lv-title">
          <span class="lv-name">
            {named(account)} <span class="muted">{kindName.value.get(account.kind) ?? account.kind}</span>
          </span>
          <span class={`lv-state ${state}`} data-lv-state>
            {state}
          </span>
        </span>
        <form
          class="lv-paste"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          title="Click a field in the sandbox first. Ctrl+V also works there directly."
        >
          <input
            type={(show ? 'text' : 'password') as 'text'}
            value={text}
            autocomplete="off"
            placeholder="Paste or type, then Send"
            aria-label="Text to paste into the sandbox"
            onInput={(e) => setText((e.target as HTMLInputElement).value)}
          />
          <button type="button" class="btn sm ghost" aria-label={show ? 'Hide text' : 'Show text'} onClick={() => setShow(!show)}>
            {show ? 'Hide' : 'Show'}
          </button>
          <button type="submit" class="btn sm" disabled={!text || state !== 'connected'}>
            Send
          </button>
        </form>
        <button class="btn sm ghost" onClick={() => setFit(!fit)} title={fit ? 'Show at actual size, and drag to move around' : 'Fit the whole screen in the window'}>
          {fit ? 'Actual size' : 'Fit'}
        </button>
        <button class="btn sm" onClick={onClose} aria-label="Close live view" data-lv-close>
          Close
        </button>
      </header>
      <div class="lv-screen" ref={box} />
    </div>
  );
}
