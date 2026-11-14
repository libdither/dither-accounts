/**
 * `browser`: the account's own signed-in browser, driven the way a person drives it (docs/browser.md), for the one-off
 * jobs its kind has no operation for: put something in a cart, look at a page, fill in a form.
 *
 * - Only in tabs this interface opened: the kind's own tabs (its pulls, its sign-in) are never read or touched.
 * - Only on the kind's own site: a URL outside the extension's host permissions is refused, and a page that leaves it
 *   can't be read.
 * - Real input: a click is a real mouse click on the account's display, typing is real key presses, so the site sees
 *   what it sees from a person (no synthetic events, no DevTools, no automation flags).
 * - Elements are named by the refs `browser.read` hands out (e1, e2…), valid until the page changes; read again after
 *   a click that loads a page.
 * - Buttons that buy, pay, send or delete (by their words) are refused to `browser.click` and to a key pressed on them;
 *   only `browser.press`, at `manage`, presses one. So `write` may fill a cart, not check it out. Best effort, by the
 *   button's words; the grant is the real line.
 * - A captcha or checkpoint is the owner's: answers carry `challenge` and nothing here solves one.
 * - While the kind is pulling, writes answer 409 busy.
 */
import { ev, iface, op, s } from '@dither-accounts/spec';

export interface BrowserTab {
  tabId: number;
  /** The whole URL. */
  url: string;
  title: string;
  /** In front on the display (the live view shows it). */
  active: boolean;
}

export interface BrowserElement {
  /** What click/type take: e1, e2… */
  ref: string;
  /** link, button, textbox, checkbox, radio, combobox, option, tab, menuitem… (the role, else the tag). */
  role: string;
  /** Its accessible name or text, cut to 120 characters. */
  name: string;
  /** A field's value, a checkbox's checked state, a select's chosen option. */
  value?: string;
  href?: string;
  disabled?: boolean;
  /** Inside the window right now (else a click scrolls it in first). */
  inView: boolean;
  /** Pressing it buys, pays, sends or deletes, by its words: only browser.press (manage) presses it. */
  guarded?: boolean;
}

export interface BrowserPage {
  tabId: number;
  url: string;
  title: string;
  /** The page's visible text, cut to `maxText` (default 20 000 characters). */
  text: string;
  textCut: boolean;
  /** Up to `maxElements` (default 300) interactive elements, in page order. */
  elements: BrowserElement[];
  elementsCut: boolean;
  /** What the page asks only a person to do (a captcha, "I am human", a code), when it looks like one. */
  challenge: string | null;
}

/** What a write answers: where the tab is after it, and a challenge if one showed up. */
export interface BrowserAfter {
  tabId: number;
  url: string;
  title: string;
  challenge: string | null;
}

const tab = { tabId: s.optional(s.integer) };

export const browser = iface({
  name: 'browser',
  version: 1,
  describe: "The account's signed-in browser, driven like a person drives it, in tabs of its own.",
  levels: {
    read: "See and read the pages it opened in your account's browser",
    write: "Open pages of the account's site in its browser and click and type in them (not buy, pay, send or delete)",
    manage: 'Also press buttons that buy, pay, send or delete',
  },
  ops: {
    'browser.tabs': op('read', 'The tabs this interface opened, newest first', s.object({}), s.typed<{ tabs: BrowserTab[] }>()),
    'browser.read': op(
      'read',
      "A tab's text and interactive elements, with the refs click and type take (default: the newest tab)",
      s.object({ ...tab, maxText: s.optional(s.integer), maxElements: s.optional(s.integer) }),
      s.typed<BrowserPage>(),
      60_000,
    ),
    'browser.shot': op('read', "A PNG of the account's display with the tab brought to the front (what the live view shows)", s.object(tab), s.typed<{ tabId: number; mime: 'image/png'; base64: string }>(), 60_000),
    'browser.open': op('write', "Open a URL of the account's site in a new tab, in front, and wait for it to load", s.object({ url: s.string }), s.typed<BrowserAfter>(), 75_000),
    'browser.go': op('write', 'Load a URL in a tab', s.object({ ...tab, url: s.string }), s.typed<BrowserAfter>(), 75_000),
    'browser.click': op('write', 'Click an element (a real mouse click), then wait for a page it loads', s.object({ ...tab, ref: s.string }), s.typed<BrowserAfter>(), 75_000),
    'browser.type': op(
      'write',
      'Click a field and type into it with real key presses; clear: select what is there first; enter: press Enter after',
      s.object({ ...tab, ref: s.string, text: s.string, clear: s.optional(s.boolean), enter: s.optional(s.boolean) }),
      s.typed<BrowserAfter>(),
      75_000,
    ),
    'browser.select': op('write', "Pick a select's option by its text or value", s.object({ ...tab, ref: s.string, option: s.string }), s.typed<BrowserAfter>(), 75_000),
    'browser.key': op('write', 'Press keys (xdotool names: Return, Tab, Escape, ctrl+a, Page_Down…)', s.object({ ...tab, keys: s.string }), s.typed<BrowserAfter>(), 75_000),
    'browser.scroll': op('write', 'Scroll the page by about a screen', s.object({ ...tab, direction: s.enum('up', 'down') }), s.typed<BrowserAfter>()),
    'browser.press': op('manage', 'Click an element even when it buys, pays, sends or deletes', s.object({ ...tab, ref: s.string }), s.typed<BrowserAfter>(), 75_000),
    'browser.close': op('write', 'Close a tab this interface opened', s.object(tab), s.object({ closed: s.boolean })),
  },
  events: {
    hello: ev('The extractor started', s.typed<Record<string, unknown>>(), true),
    status: ev("The account's state", s.typed<Record<string, unknown>>(), true),
  },
});
