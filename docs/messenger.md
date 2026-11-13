# Messenger and Instagram: the `messenger` and `instagram` kinds

Two chat kinds that run the real web apps in a sandboxed browser on this machine and answer dither-chat's `chat`
interface (docs/chat.md) from inside the page:

| kind | where | extractor |
|---|---|---|
| `messenger` | messenger.com (or facebook.com/messages with `site: "facebook"`) | `extractors/messenger` → `extractors/meta` |
| `instagram` | instagram.com/direct | `extractors/instagram` → `extractors/meta` |

Both are one shared package, `extractors/meta`: the sandbox and status (`src/run.ts`), the hook (`src/extension/hook.js`),
the checks (`src/raw.ts`) and the mapping to chat facts (`src/map.ts`). Each kind's directory has only its manifest and a
one-line `src/main.ts`.

## Adding one, and what you do

On the accounts page, **Add → Messenger** (optional field "Where Messenger runs": `messenger` or `facebook`) or
**Add → Instagram**. Its extractor starts a sandbox and the account says **Sign in to Messenger (Instagram) in the live
view**. Open the live view and sign in as on your desktop: password, two-factor, any check Meta shows ("Meta asks for a
check in the live view" is attention `verify`); those are yours to pass, nothing here answers them. Messenger may ask for
your end-to-end encryption PIN to restore chat history: enter it there too. The account goes online once the hook has
read your chats. The browser profile keeps the sign-in.

## What runs

- **The sandbox** (packages/browser, as for `google` and `proton`): a private Xvfb display (:80–:89, then :100–:159), an ordinary
  non-headless Chromium with its profile in `<data>/accounts/<id>/profile`, the extension copied to `<id>/extension`
  each start, x11vnc on `<id>/vnc.sock` (no TCP port) for the live view. No CDP, no automation flags.
- **Service workers**: Chromium goes on running the extension's service worker it first registered in a profile,
  whatever the copy or the manifest's version says. So when the copied worker is not the one the last start ran (its
  hash is kept in the account's `extension-worker.sha256`), the sandbox removes the profile's `Default/Service Worker`
  before launching, never while a browser holds the profile (`packages/browser/src/worker.ts`). The sites' own service
  workers go with it and register again on the next visit; cookies and Local Storage, and so the sign-in, stay.
- **The extension**: content scripts only on the site's origins (messenger.com and facebook.com for `messenger`,
  instagram.com for `instagram`). `hook.js` runs in the page at document_start (MAIN world), `content.js` relays, the
  service worker holds the one token-gated loopback WebSocket and reports which page each tab is on (origin and path
  only). The worker also fetches attachments from Meta's CDN hosts (`*.fbcdn.net`, `*.cdninstagram.com`,
  `*.fbsbx.com`) as an `<img>` would: no cookies, the links are signed.
- **What the page can see of the hook** is kept small ([page-traces.md](page-traces.md)): it talks to content.js by
  CustomEvents of this install's own types (no window messages), leaves no mark on `window`, its traps on `__d` and
  `__onAfterModuleFactory` read as native accessors, and what it wraps reads like the client's own functions. It
  opens a LightSpeed transaction for a task as the client opened its own for that task (the mode and name the client
  passed). The event types are not in the source, which has placeholders: the copy made each start gets names made
  for this install and account (`packages/browser/src/markers.ts`, from the manager's own secret).
- **The hook** does nothing at all on sign-in, checkpoint and consent paths. Elsewhere it reaches the client's own
  modules (below), reads what the client holds, forwards what changes, and runs commands through the client's code.
  It never makes a request of its own; the only fetch in it is of a `blob:` URL the page already holds (decrypted
  media of an end-to-end encrypted chat).
- **The extractor** checks everything the hook forwards against the fields it needs (drops and counts what fails),
  maps it to chat facts, paces commands like a person (1.5–3 s between writes, plus typing time for longer text;
  3–6 s between history pages), and reports the hooks as status layers and details.

## How the hook reaches the client

Meta's web apps ship **Haste** modules: `__d(name, deps, factory)`, required by stable string names. A page first runs
a stub (`__d=function(…){__d_stub.push(…)}`), then the module system replaces `__d` and drains the stub. Factories call
their dependencies at use time (`r("X")`, `o("X").f`), so changing a module record's export reaches every caller.
Three independent ways in, so losing one leaves the others:

1. `require("__debug").modulesMap`: every module record (`{ id, exports, defaultExport, factoryFinished, … }`);
2. `require("ifRequired")(name, found, missing)`: exports of a module that already ran, never running one;
3. a trap on `window.__d` (every module's name as it is defined) and on `window.__onAfterModuleFactory` (the module
   system calls it after each factory; ours chains to any the page sets).

A module is read only once its factory has run (the client loaded it). Command modules may be loaded on use, as the
client loads them when you act. Looking a module up by its **shape** walks every module, so it runs at most once a
minute per thing looked for.

**Messenger** keeps its inbox in its **LightSpeed** database (ReStore: tables the UI renders from). Its decrypted
end-to-end chats are mirrored into the same tables (thread types 15 and 16, mapped through `mi_act_mapping_table`), so
one view covers both. Every row the client writes passes through the database's subscription manager
(`notifyTableAndIndexSubscribers(table, prev, next)`); the hook observes it there. 64-bit values are `[high, low]` pairs.

**Instagram**'s web inbox is no longer on LightSpeed ("OffMsys"): it keeps a **Slide** mailbox in a Relay store
(`XFBIGDirectViewerThread`, `SlideMessage`, `XDTUserDict`, `SlideUser` records), fed by its queries and by MQTT deltas
it routes through `IGDSlideMutationProcessor`. Every change reaches the store through `store.publish(source)`; the hook
observes it there. If an Instagram account turns out to run on LightSpeed after all, the hook uses the Messenger
backend for it (no Slide records and a LightSpeed database after 20 s).

## The hook points, their fallbacks, and how the status says which one broke

The extractor puts each hook in the account's `details` as `hook.<id>` (how it was found, or `missing`), and builds the
layers from them. **Core** hooks take the account to attention `selector_broken` ("Messenger's web app changed: … not
found") when still missing 90 s after a signed-in page; **optional** ones leave it online without that feature (the
capability is left out of `hello`, the command answers "not available").

| id | what | found by (first, then fallbacks) | need |
|---|---|---|---|
| `modules` | the module system | `__debug.modulesMap` → `ifRequired` → `require` | core |
| `session` | who is signed in | `CurrentUser` → `CurrentUserInitialData` | core |
| `ls.db` | Messenger's database | `LSDatabaseSingleton` → `LSDatabaseSingletonLazyWrapper` → shape (`runInTransaction` + `tables.threads/messages`) | core |
| `ls.read` | reading rows | `ReQL` (`fromTableDescending`, `getKeyRange`, `toArrayAsync`) → each table's `entries()` iterator | core |
| `ls.changes` | live rows | the subscription manager's `notifyTableAndIndexSubscribers` → each table's `subscribe` → `subscribeToCommit` + re-reading → polling | core |
| `ls.i64` | 64-bit values | `I64` → built-in `[high, low]` decoding | optional |
| `ls.tasks` | the client's task queue | `LSIssueNewTask` + `LSFactory` | optional |
| `ls.send` | sending | the client's own send task, once seen (below) → the composer | optional |
| `ls.reply`, `ls.react`, `ls.edit`, `ls.unsend` | those writes, plain chats | the client's own task for each, once seen | optional |
| `ls.markRead` | marking read | the client's own task, once seen → opening the chat in the page | optional |
| `ls.history` | older messages | the client's fetch task, once seen → what the database already holds | optional |
| `maw.bridge` | the encryption worker's bridge | `MAWBridge` (traced only) | optional |
| `slide.env` | Instagram's Relay environment | `PolarisRelayEnvironment` → any environment the client uses next (`RelayModernEnvironment` prototype) → shape (`getStore` + `commitUpdate` + `execute`) | core |
| `slide.read` | reading records | the store's `RecordSource` | core |
| `slide.changes` | live records | `store.publish` → the delta router → polling the store | core |
| `slide.deltas` | delta types (counts) | `IGDSlideMutationProcessor` | optional |
| `slide.typingIn` | someone typing | `IGDTypingIndicatorTransformer.transformIGDTypingPayload` | optional |
| `slide.send` | send, reply | `IGDMAPISendTextMessage` | optional |
| `slide.react`, `slide.edit` | react, edit | `IGDMAPISendReaction`, `IGDMAPIEditMessage` | optional |
| `slide.unsend` | unsend | `IGDMAPIUnsendMessage` → `IGDMAPIDeleteMessage` (**guesses**: not in the public resources) | optional |
| `slide.typingOut` | typing | `IGDMAPISendTypingIndicator` (1:1 chats only, as the client) | optional |
| `slide.markRead` | mark read | `useIGDMarkThreadAsReadMutation.graphql` via `CometRelay`/`relay-runtime` `commitMutation` | optional |
| `slide.history` | older messages | `IGDMessageListOffMsysQuery.graphql` via `fetchQuery` | optional |

Layers, outermost first: **display → browser → extension → signed in → client modules → mailbox → live updates →
first snapshot → sending**.

- **client modules** failed: `modules` or `session` missing (the module system changed: look at `moduleRecords` and
  `moduleNames` in details).
- **mailbox** failed: `ls.db`/`ls.read` or `slide.env`/`slide.read` missing, or neither backend found.
- **live updates** says "degraded" when it is polling (the client's change feed was not found).
- **first snapshot** shows chats and messages read, and how many objects were dropped (`dropped.<type>` in details:
  `dropped.page.*` by the hook, the rest by the extractor). Drops mean the client's objects no longer have a field we
  need.
- **sending** lists each write and how it is done; it is failed ("read-only: …") when no way to send was found. The
  account is still online and reads.

Other details: `bundleRevision` (Meta's client revision: when it changes, Meta shipped a new bundle), `modules`
(defined, ran), `hooksFound`, `learned` (the client task shapes known), `traced` (how many distinct client actions
were seen), `lastCommand`, `lastError`, `page` (origin and path only).

## Writes

**Instagram** writes go through its own message API modules, which do what its composer does: an optimistic record,
then the mutation (`IGDirectTextSendMutation`, `IGDirectReactionSendMutation`, `IGDirectEditMessageMutation`) through
its send pipeline; typing goes over its MQTT client; mark read is the mutation its thread view commits. Sending files is
not hooked (the media publisher needs the composer's own staging object).

**Messenger** sends everything as tasks in its own queue (`pending_tasks`), which its task sender ships. The hook sends
a task only in the shape the client itself was last seen sending for that action: it watches the client's own tasks go
by, keeps their shape (field names, which fields are the chat, the message, the text, the time, and the small constant
values), and fills in only those. A shape with a field it cannot fill is not used. The shapes persist in
`<id>/learned.json` (no text, no ids) and are handed to the page on every load. Task labels (which action a task is)
are from mautrix-meta's messagix: 46 send, 29 react, 21 mark read, 33 unsend, 742 edit, 228 fetch messages.

- Until the client has done an action once, that action is unavailable (except **send**, which uses the composer, and
  **mark read**, which opens the chat). So: do each once by hand in the live view (checklist below).
- **The composer** (any chat, end-to-end encrypted ones too): the hook opens the chat from its own link in the page's
  chat list, puts the text into the composer as typed text, and presses Enter; what the client then does is its own.
  It refuses if the composer holds a draft, and needs the chat to be in the page's list.
- **End-to-end encrypted chats**: sending through the composer works; replies, reactions, edits, unsends and fetching
  history go through the client's encryption worker (`MAWBridge.sendAndReceive(backend, route, …)`), whose routes are
  not in the public resources. They are refused plainly; the trace records the routes the client uses when you act by
  hand, which is what wiring them needs.
- Sending files is not hooked.

## For the round against the real pages

- `action survey` (Try it on the page, or an app with `chat` at manage): the backend, every hook and how it was found,
  module counts, the names of LightSpeed (`LS*`), encryption (`MAW*`), Messenger web (`MW*`), Instagram (`IGD*`),
  Slide, Relay and MQTT modules, the action modules (send, react, read, typing, unsend, edit, fetch, composer) with
  their export shapes (`{ key: "function/2" }`), the Instagram and Messenger mutations defined, the stored procedures
  the client has loaded (`__sproc_name__`, `__tables__`), record counts by type (Slide) or the table count
  (LightSpeed), field presence counts from the snapshot (how many threads have a name, messages a reply, users an
  fbid, …), delta counts by type, the trace, the learned shapes (kinds only), drops. Names, shapes and counts only.
- **The trace**: while you act in the live view, the log says `client ran mutation <name>`, `client ran task label
  <n>`, `client ran bridge backend/<route>`, each with the names of its fields, the first time each is seen.
- What to look at when something is off: the first non-ok layer; `hook.*` in details; `dropped.*`; the
  `hooks: N found, missing …` lines in `adapter.log`.

## What the public resources showed, and what only a sign-in will

Read on 2026-11-07 from the signed-out pages (messenger.com, facebook.com/messages → login, instagram.com/direct →
login) and the resources their bootloader maps name, including the Instagram chat-tab modules (public static files;
about 8,400 module definitions). Nothing was signed in.

**Seen in the bundles** (and built against): the module system's stub, `__debug.modulesMap`, record fields,
`ifRequired`, `__onAfterModuleFactory`; LightSpeed's schema (`LSDbV1`: 387 tables, their keys) and its writers' column
names (`LSUpsertMessage`, `LSDeleteThenInsertThread`, `LSDeleteThenInsertContact`, `LSAddParticipantIdToGroupThread`,
`LSUpsertReaction`, `LSInsertBlobAttachment`); ReStore's API (`runInTransaction`, `subscribeToCommit`,
`subscriptionManager`, `tables`) and ReQL; `LSDatabaseSingleton`; `LSIssueNewTask`'s arguments and `LSFactory`;
`MAWBridge`, `MAWBridgeSendAndReceive`, `MAWGetLSThreadTypeUtil` (15/16), `MAWChatJid`; `CurrentUser`;
`PolarisRelayEnvironment`; the Slide record shapes (from the Relay fragments: `SlideMessage`, `XFBIGDirectViewerThread`,
`XDTUserDict`, `SlideUser`, `XFBSlideReaction`, `XFBSlideReadReceipt`, contents and attachments) and record ids
(`SlideMessage:<id>`, `XFBIGDirectViewerThread:<id>`, `SlideMailbox:<id>`); `IGDSlideMutationProcessor` and its
delta types; `IGDTypingIndicatorTransformer`; `IGDMAPISendTextMessage`, `IGDMAPISendReaction`, `IGDMAPIEditMessage`,
`IGDMAPISendTypingIndicator`, `IGDMAPISendMediaMessage`; `useIGDMarkThreadAsRead` and its mutation's variables;
`IGDMessageListOffMsysQuery`'s variables; the limits below.

**Only a signed-in page will show:**

- that the Messenger inbox loads `LSDatabaseSingleton` (and ReQL) on messenger.com as it does in the Instagram chat-tab
  code, and that its rows pass through the subscription manager the same way (`hook.ls.changes`);
- that end-to-end encrypted messages appear in the `messages` table with their text (`presence.messages.text` in the
  survey against `presence.e2ee`);
- the client's own task shapes (they are learned, not assumed) and whether its task sender ships a task the hook
  queues exactly as its own (the fake does; the first real `send` via task answers it);
- the composer: that `[role="main"] [contenteditable="true"][role="textbox"]` is Messenger's composer, that the chat
  list has `a[href*="/t/<id>/"]` links (`/e2ee/t/` for encrypted chats), that `insertText` and Enter send;
- the encryption worker's routes (traced), replies and reactions in encrypted chats;
- that Instagram's inbox is on Slide for this account (`backend` in details), that `PolarisRelayEnvironment` holds the
  mailbox, that `SlideUser.id` and `XDTUserDict.interop_messaging_user_fbid` are the ids messages use
  (`presence.users.fbid` against `presence.users.igid`), and how typing's `activity_status` values read;
- Instagram history paging: whether `older_than_message_id` with `first` gives the older page (`asked` in the history
  reply; a query error is logged as `history query: …`);
- Instagram unsend: the module's name (the trace shows the mutation when you unsend by hand);
- media in encrypted chats (`blob:` URLs the page holds, which it may revoke).

## Per-network facts (for dither-chat's tables)

| | Messenger | Instagram |
|---|---|---|
| reactions per person on a message | one (the `reactions` table's key is chat, message, person) | one (`useIGDUniqueReactionsBySender`) |
| which emoji | any (the picker's full emoji set); not free text | any (`IGDCustomReactionsDialog` with an emoji picker); not free text |
| attachment size | 25 MB by default (`MWMediaManagerFileSizeLimit`: 25, a server knob can raise it) | 25 MB (`IGD_DEFAULT_MAX_ATTACHMENT_SIZE_MB`) |
| attachments per message | not in the public resources (the client caps it: a "max media added" error exists on Instagram) | the same |
| text length | not found | 1000 characters (`IGD_COMPOSER_MAX_LENGTH`) |
| group name | yes (`threadName`) | yes (`thread_title`; `IGDEditThreadNameDialog`, `SlideUQPPThreadName` deltas) |
| group picture | yes (`threadPictureUrl`; `LSSetThreadImageURL`) | yes (`thread_image_url`; `SlideUQPPThreadImage` deltas; whether the web app can set it was not seen) |

So `REACTION_RULES` (exclusive, not free text) holds for both; `ATTACHMENT_LIMITS` should be 25 MB for both
(dither-chat's MAX_UPLOAD is also 25 MB); `ABOUT_RULES.instagram.conversation` can have `avatar` too. Configure from
here is not built: these kinds have no `about` or `configure` yet.

## Config

All optional: `site` (`messenger` or `facebook`, Messenger only), `noSandbox`. `testOrigin` is for tests: the start
page, the extension's matches and its media host become it. `DITHER_META_GRACE_MS` (environment, tests) shortens the
90 s before a missing core hook is "selector_broken".

Kept in the account's directory: `profile/` (Chromium's, with the sign-in), `extension/` (re-copied each start; its
`config.json` holds the bridge token and the learned shapes, 0600), `learned.json` (0600), `adapter.log`. Logs and
statuses hold ids, counts, module names and statuses only: never message text, people's names, cookies or tokens.

## Tests

- `extractors/meta/test/hook-messenger.test.ts`, `hook-instagram.test.ts`: `hook.js` and the fake page in a stand-in
  `window` with the fake server called directly (`harness.ts`): every hook and its fallbacks (no `__debug`, no
  singleton, no ReQL, a subscription manager that cannot be wrapped, no database at all, no Polaris environment, no
  delta router or typing transformer, no send module), the snapshot and changes (whitelisted, dropped and counted),
  learning the client's task shapes and sending in exactly them, encrypted chats never sent a task, every Instagram
  command through its modules, sign-in pages running nothing.
- `extractors/meta/test/map.test.ts`: the mapping (both backends), the checks, media links, mentions, pacing.
- `test/messenger-browser.test.ts`, `test/instagram-browser.test.ts`: a real manager runs each kind in its real
  sandbox (Xvfb, Chromium, x11vnc) against the fakes: online with every layer ok, facts, live changes, sending through
  the composer (and an encrypted chat through the client's worker), learned tasks, media, history, the survey, signed
  out, read-only, "selector_broken", nothing secret said, every process gone. Skipped without Xvfb, chromium and
  x11vnc.
- `test/fake-messenger.ts` (the server) and `test/fake-messenger-page.js` (the page): shaped as the real bundles are
  where the hook touches them.
- `scripts/verify-messenger.ts`: both kinds through a throwaway manager's `main.ts` on a temp directory (port 18566).

## Your real-account checklist

Messenger:

1. **Add → Messenger** (leave "Where Messenger runs" empty for messenger.com). It says "Sign in to Messenger in the
   live view".
2. **Live view**: sign in (password, two-factor, any check; tick "Keep me signed in"). If it asks for your end-to-end
   encryption PIN, enter it. Wait for your chats.
3. On the overview, the layers within a minute or two. If one stops, its note and `hook.*` in details say which hook;
   run **Try it → action `{ "action": "survey" }`** and keep its answer for the second round.
4. In details: `backend` is `ls`, `bundleRevision` is set, `hooksFound`, no `dropped.*` (or few).
5. Check in dither-chat (or Try it → `history`): your chats with names and pictures, an encrypted chat's messages
   readable, a group with its name.
6. **Send** from dither-chat to a plain chat and to an encrypted chat (through the composer: the live view shows the
   chat open and the message sent). Then, by hand in the live view, once each in a plain chat: react to a message,
   edit one of yours, unsend one of yours, reply to one, scroll up in a long chat. The log then says `learned the
   client's own … task`, and `learned` in details lists them. Then from dither-chat: react, edit, unsend, reply.
7. By hand in an encrypted chat: reply, react, unsend: the log's `client ran bridge backend/…` lines are what wiring
   those needs.
8. Have someone message you, react, and type: they arrive live; a reaction replaced by another arrives as one remove
   and one add.
9. Leave it a day; restart it (Stop, Start): online without a new sign-in.

Instagram:

1. **Add → Instagram**, sign in in the live view, wait for the inbox (it opens instagram.com/direct/inbox/).
2. Layers all ok; `backend` is `slide` (if it is `ls`, your account runs on LightSpeed: everything above for Messenger
   applies).
3. From dither-chat: send, reply, react, edit, typing (1:1), mark read, history in a long chat (`asked: true` in the
   reply and older messages arriving).
4. By hand in the live view: unsend one of your messages; the log's `client ran mutation …` names it (the unsend hook's
   real name).
5. Survey: `presence.users` (how many users have an fbid, how many only an Instagram id) and `presence.contentTypes`.
6. Have someone message you, react, type: they arrive live.
