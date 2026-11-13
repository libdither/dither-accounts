# What a page can see of our hooks

The browser kinds (Discord, Google, Messenger and Instagram, Privacy, Proton Mail, Schwab, X) each run a hook, `hook.js`, in
the site's own page (the MAIN world, at document_start), so the site's own script runs next to it. This page lists
what keeps the hooks out of that script's sight, and what it can still see. A site should not be able to pick out
the people who use this with a line or two of page script.

The parts:

- **What every hook shares**, `packages/browser/src/page/main-world.js`. The copy step puts it into each `hook.js`
  (`packages/browser/src/markers.ts`, which also makes the names below), so there is one copy of it, not six.
- **The other end of the channel**, `packages/browser/src/page/isolated-world.js`, which is every `content.js`.
- **Names**: everything a hook leaves under a name (the channel's event types, Discord's sessionStorage key, the key
  it probes translation bundles with, the stand-in microphone's groupId) is made per install and account when the
  extension is copied, never a name every install shares.
- **The test**: `test/page-traces.test.ts` loads every kind's real copy into one sandboxed Chromium, with probe pages
  (`test/page-traces/`) that look from the page's side at what is listed here.

No service worker is touched by any of this: every change is in the content scripts (and Discord's manifest).

## What the hooks keep out of sight

1. **The channel between hook.js and content.js.** It used to be `window.postMessage`, which every `message` listener
   on the page saw, with readable payloads. Now it is CustomEvents dispatched on `window`, with types made per
   install and account, carrying plain objects (Chromium clones a CustomEvent's detail from one world into the
   other). A page gets no `message` event, and it can only listen for a type it knows. Both ends say hello (a null
   detail) when they start, in whichever order Chromium runs them, and the hook holds what it says until content.js
   has answered. What comes down is handled in a microtask after the event, so page code a command calls never finds
   our event in `window.event`. The hook uses `dispatchEvent`, `addEventListener`, `CustomEvent` and its `detail`
   getter as they were at document_start, so a page that replaces them later sees none of our calls. A MessageChannel
   handed over once was the other candidate, but a MessagePort does not cross worlds in a CustomEvent, and handing it
   over by `postMessage` is itself a message the page sees.
2. **Patched natives.** Each function a hook puts where a native was reads like that native:
   `Function.prototype.toString` gives `function fetch() { [native code] }`, and the function has the native's
   `name` and `length`, no `prototype`, no own keys but those two, and the native's property attributes. That covers
   `fetch` (Google, Privacy, Proton), `XMLHttpRequest`'s `open`, `setRequestHeader` and `send` (Google, Privacy),
   `navigator.credentials.create` and `.get` and `PublicKeyCredential`'s two statics (Privacy and Schwab: the shared
  `packages/browser/src/page/webauthn.js`), and
   `getUserMedia`, `enumerateDevices` and `RTCPeerConnection.prototype.setRemoteDescription` during a Discord bridge
   call. The media ones are now patched on their prototypes, where the natives are, and put back exactly as they
   were. Before, they were assigned onto `navigator.mediaDevices`, which left own properties behind after the call.
   The accessors a hook adds read like native accessors (`function get __d() { [native code] }`, name `get __d`):
   the `webpackChunk*` globals' and their `push` (Discord, Proton), and Meta's `__d` and `__onAfterModuleFactory`. A
   page function a hook wraps reads like the page's own: Meta's `__d` and the module exports and methods it wraps,
   Proton's module factories, X's `onEvent` and the DevTools hook's `inject` and `onCommitFiberRoot`. Each has the
   original's source text, name and length, and a `prototype` only if the original has one. The DevTools hook X
   installs, where none is there, has methods that read as native code. `toString` itself reads as native, by
   `toString` and by `toString.call(toString)`.
3. **Stack frames.** Our script is named `<anonymous>` (a `//# sourceURL`), so a frame of ours in `Error.stack`
   reads `at fetch (<anonymous>:12:34)`, not `chrome-extension://<id>/hook.js`. A native that throws at once under a
   wrapper (XHR's `open` or `send`, `toString` given a non-function) throws with the stack it would have had without
   the wrapper: no frame of ours, and toString's own builtin frame where V8 puts it.
4. **Nothing on `window`.** The global-registry Symbols that marked Privacy's and Meta's hooks as installed are gone.
   A hook now asks whether it is already running with a cancelable event of its own type. Proton no longer marks
   module factories with a Symbol, and no longer puts a Proxy behind `__webpack_require__.m`: the chunk list's `push`
   wraps each new chunk's factories before the runtime copies them in. The probe chunk that hands Discord's and
   Proton's hooks the runtimes' `require` leaves the page's chunk list again once the runtimes have seen it. X's hook
   pushes its probe only onto the list the page's runtime already made (no accessor on `window`), and only when the
   feed needs it, and takes it out again at once. The
   chunk list's global becomes a plain data property again once the runtime has made it.
5. **Discord's `config.json`** (the bridge's address and token) is no longer web-accessible, so a discord.com page
   that knows the extension's id cannot fetch it, or probe for the extension with it. The service worker reads it
   through `chrome.runtime.getURL`, which never needed that.
6. **The passkey's errors** (Privacy, Schwab) are Chromium's own: when the extractor refuses, or does not answer in time, the page gets the
   DOMException Chromium's WebAuthn throws, with its message (`NotAllowedError`: "The operation either timed out or
   was not allowed. …"; `InvalidStateError`, `NotSupportedError`, `SecurityError`, `AbortError` likewise). The
   extractor's own reason stays in its log. A request the hook cannot read goes to the browser's own `create` or
   `get`, which rejects it as it would without the hook.
7. **Discord's stand-in microphone** (listed when the browser has none, during a bridge call) is an
   `InputDeviceInfo` to `instanceof` and to `Object.prototype.toString`. It has no own properties, and its fields,
   `toJSON` and `getCapabilities` answer as a real one's do.
8. **Meta's LightSpeed transaction.** The hook notes what the client passes to `runInTransaction` when it issues a
   task itself (its mode, and the name it traces the transaction by), keeps that with the task's learned shape, and
   opens its own transaction for that task with the same. Before, it used a name of its own.

## What a page can still see

- **Another frame's `toString`.** `iframe.contentWindow.Function.prototype.toString.call(window.fetch)` gives our
  wrapper's source. Our content scripts run in the top frame only, except Schwab's, which run in every schwab.com frame
  (its sign-in widget may be one); a frame the page makes itself (about:blank, srcdoc) runs none of ours, so it has a
  pristine `toString`.
- **Schwab's hook in its frames**: a schwab.com frame has the same wrappers as the top page. In a frame that is not
  the top one, the hook reads `document.featurePolicy` (to leave a call the frame may not make to the browser), which a
  page that replaced that getter would see.
- **CallSite file names.** A page that formats stacks itself (`Error.prepareStackTrace`) gets
  `chrome-extension://<id>/hook.js` from `getFileName()` for a frame of ours. V8 makes that method read-only, so it
  cannot be covered. `toString()` and `getScriptNameOrSourceURL()` give `<anonymous>`.
- **Frames of ours, as `<anonymous>`.** They show under every page function a hook wraps (Meta's `__d`, Proton's
  factories, X's `onEvent`), under page code a hook calls to run a command, and in a failed `fetch`'s stack, which
  Chromium takes when `fetch` is called.
- **Accessors where the page had data properties**: the chunk list's `push` (Discord, Proton; enumerable, as an
  assigned property is), and Meta's `__d` and `__onAfterModuleFactory`. `__onAfterModuleFactory` reads back as a
  function after the page set it to null. It reads like a bound function then, or like the page's own once the page
  sets one.
- **Wrapped page functions are strict-mode functions.** A sloppy-mode original has own `arguments` and `caller`, and
  the wrapper does not. A wrapper shares the original's `prototype` object, whose `constructor` is the original.
  A method Meta wraps on an object that inherited it becomes the object's own property, as an assignment would make it.
- **What the wrappers do inside.** A page that replaces builtins the hooks use while handling a call
  (`Array.prototype.push`, `JSON`, `URL`, `Headers`, …), or hands a wrapper an object with getters or its own
  `toString`, can see calls it did not make. For example, XHR's `open` wrapper turns the URL into a string once more
  than the native does. The channel and `toString` take their references at document_start.
- **Proton's `fetch` wrapper** watches the outcome of the app's `/api/` calls, so a rejected one of those never
  reaches `unhandledrejection`.
- **Google's hook in the Gmail page** records the shape of the page's calls to its own origin
  ([google.md](google.md), "Learning Gmail's protocol"). For those calls its `fetch` returns a promise of its own
  that settles as the native one does (one tick later; a rejection the page leaves unhandled still reaches
  `unhandledrejection`, as that promise's), and reads the response from a clone; an `XMLHttpRequest` gets a `loadend`
  listener (added with the native `addEventListener` taken at document_start), and its status, response and
  Content-Type are read through the natives' own getters. A learn run's `openRead` scrolls the row into view and
  dispatches pointer and mouse events on it, which are `isTrusted: false`, and its `nav` and `back` set the hash and
  call `history.back()` as the page itself might.
- **Google's hook reading Gmail** ([google.md](google.md), "Gmail mail") makes calls of its own from the Gmail page:
  POSTs to the page's `/sync/u/<n>/i/bv`, `fd` and `s` with the page's own headers and the next `c` (so the server sees
  `c` values the page did not send, and the page's own next call may repeat one), and GETs of its "Download message"
  route. They go through the `fetch` taken at document_start, so the page's own `fetch` never sees them, but they show
  in its Resource Timing entries (`performance.getEntriesByType('resource')`) and to a service worker of the page's.
  What the hook notes of the page's own calls (their headers, the sync point in an `s` body, the `ik` in a query) is
  read inside the wrappers it already has, as listed above.
- **The passkey's credentials** (Privacy, Schwab) carry their fields as own properties, where a real `PublicKeyCredential`'s are prototype
  getters. Their methods read as native.
- **Discord's stand-in microphone.** `MediaDeviceInfo.prototype`'s getters, called on it directly, refuse it, and its
  `toJSON` is not the prototype's own function. It is labelled (`default`, `Default`, a groupId) while the browser's
  own entries, with no permission granted, are not.
- **X's DevTools hook** is there on pages where React DevTools is not installed, and its functions read as native
  code where the real one's are JavaScript.
- **X's notifications and profiles** ([x.md](x.md), "Notifications and profiles") are the page's own requests, made by
  its own endpoint factories, but at times the page did not choose: a NotificationsTimeline read every 4-8 minutes
  while the page sits on /i/chat, UserByRestId and UserTweets when someone opens a profile in dither-chat, and the
  Notifications tab's chunks loaded (by the route's own loader) without the tab being opened. They show in Resource
  Timing and to a service worker of the page's. To get the thunk's extra argument the hook dispatches a function to
  the Redux store once: a middleware ahead of redux-thunk would see that action. webpack's record of loaded chunks
  keeps the probe chunk's Symbol id.
- **Discord's sessionStorage** holds its reload counter (a JSON array of times) under this install's name, and the
  key it probes translation bundles with shows in a Proxy's `get` trap.
- **Out of scope here**: the call lab's probe (`DITHER_LAB` only: Discord's `installDitherProbe`, which dither-chat's
  `call-lab.ts` calls by name; the sandbox warns when it puts it in), and what the browser itself shows rather than
  our scripts: Xvfb (and its `-nocursor`), SwiftShader WebGL where there is no GPU, no audio devices, and the
  command-line flags.
