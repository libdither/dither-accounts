# X direct messages and notifications: the `x` kind

`extractors/x` holds one X account's direct messages, legacy DMs and encrypted XChat conversations alike, its
notifications (who liked, reposted, replied to, quoted or mentioned your posts, who followed you) as one read-only
conversation, the profiles of the people in them, anyone's profile with their recent posts and any post's thread on
request, and, when asked, likes, reposts, posts, replies and quotes and who liked or reposted a post, from the real x.com web app signed in in a sandboxed browser on this machine, and answers the `chat` interface
(docs/chat.md) from it. Like the Discord kind, it hooks into the client from inside the page: it reads what the
client holds in plaintext and runs commands as the client's own UI events. It never decrypts anything itself and
never makes a request the page would not make for the same click.

## Adding it, and what you do

On the accounts page, **Add → X** (no fields). Its extractor starts a sandbox (packages/browser, as for Google and
Proton) and the account says **Sign in to X in the live view**. Open the live view and sign in as on your desktop:
password, second factor, any check X shows (those are yours; nothing here answers them). Leave the browser on Chat
(x.com/i/chat), where it starts.

If X asks for your **XChat PIN** on this browser (a new browser has no keys for your encrypted chats until you enter
it), the account says **Enter your XChat PIN in the live view** (attention `verify`, with the live view). Enter it
there. The PIN goes into X's page only; this repo never sees it.

## What x.com is now (read from its bundles as of November 2026, signed out and signed in)

x.com serves two clients. **Signed in** it is X's own **"responsive-web"** (webpack, React, Redux with redux-thunk,
Relay), and it mounts the XChat embed inside it: the DM hooks all work there (a signed-in self-test found every
hook). **Signed out** it is "x-web" (below), which loads the same embed. The DM hooks are built on the embed alone, so
they work under either; the notifications and profiles are read through responsive-web's own endpoints
("Notifications and profiles", below).

| | |
|---|---|
| the host app, signed in: "responsive-web" | `https://abs.twimg.com/responsive-web/client-web/main.<hash>.js` and lazy chunks (`bundle.Notifications.<hash>.js`, …): webpack 5 with the chunk list `webpackChunk_twitter_responsive_web`, React, a **Redux store** (react-redux's Provider) whose redux-thunk extra argument is `{ api, … }`, where `api.withEndpoint(factory)` calls `factory({ apiClient, featureSwitches, relayEnvironment, jotaiStore })`. Endpoint factories are modules like `({ apiClient: e }) => ({ fetchNotifications: (…) => e.graphQL(NotificationsTimelineQuery, …) })`. The XChat embed is loaded by `ondemand.XChatEmbed*` chunks. |
| the host app, signed out: "x-web" | `https://abs.twimg.com/x-web/x-web/entry-client-logged-out-<hash>.js` and chunks: ES modules built by Vite with **Rolldown** (`rolldown-runtime-*.js`), **TanStack Router** with server rendering (`$_TSR`, `data-tsr-stream-part`), React **19.3.1**, Relay for GraphQL, the React Compiler. No `webpackChunk` global and no Redux store. `window.__INITIAL_DATA__` holds feature switches. |
| DMs, "XChat" | a **Module Federation** remote (`@module-federation/vite` 1.22.1, global name `xchat`): `https://chat.x.com/embed-v1.json` names `https://abs.twimg.com/x-web/xchat/embed/<sha>/remoteEntry.js` (`contractVersion: 1`, `dmSchemaVersion: 197`). It exposes one module, `./xchat`, exporting `contractVersion`, `preload` and `start(host)`; `start` returns `render(surface, element, props)` for the surfaces `route` (/i/chat), `drawer`, `overlays`, `settings` and `share`, each drawn into an **open shadow root** with the embed's own React 19.3.1 copy. |
| the chat logic | `dm-core-<hash>.js` (11.8 MB): **Kotlin/JS**, X's Kotlin Multiplatform chat core (`@x-clients/dm-core`, shared with the phone apps). Kotlin's reflection names survive minification (`$metadata$.simpleName`: `WebDmObjectGraph`, `DmState`, `MessageItemReceived`, …), exported properties are getters with their source names, data-class fields keep readable names, Longs are BigInts. |
| storage | a **SQLite** database in a worker on **OPFS** (`sqlite.worker-*.js`, schema with `dm_reaction`, `dm_conv_previews`, …). Messages are kept decrypted on the device. Live updates come over `wss://chat-ws.x.com`. |
| the PIN | the **Juicebox** SDK (`juicebox-sdk-*.js`) recovers the private key with the PIN; the page goes to `/i/chat/pin/<mode>` (`verify`, `change`, …) when keys are missing on this browser (`onLocalKeysMissing`, `onNoLocalKeypair`). |
| legacy DMs and XChat | **one core and one inbox hold both**: each conversation has `isLegacy` (inbox row and conversation state), each message `isEncrypted` and `isUndecryptable`, legacy media a `legacyMediaUrl`, XChat media `mediaHashKey` and `convKeyVersion`. Legacy groups and XChat groups are told apart (`canBeAddedToLegacyGroup`). |

What the hooks use (all exported names, from `dm-core` and the React chunks that call it):

- `WebDmObjectGraph` (one per page, in a React context): `conversationListComponent(callbacks, cancellation, flag)`,
  `convComponentContainer(conversationId)`, `dmPinEntryComponent(…)`, `ownerUser`, `unreadMessageCount`, …
- `DefaultConversationListComponent`: `state` (an `ExportedStateFlow` of `ConversationListState`: `previews`,
  `previewItems` (the rows, and a `MessageRequests` item for the Requests row: `priorityCount`, `isUnseen`,
  `relevantUserNames`), `messageRequestsButton`, `isLoadingConversations`, `typingIndicatorsByConversation`,
  `hasMoreItemsInfo`, `hasCheckedKeypairsFromDb`, …), `onEvent(ConversationListEvent)`. A row is
  `ConversationPreviewWithMetadata` (`conversationId`, `isLegacy`, `unreadCount`, `preview` with `timestamp`,
  `lastReadSequenceNumber`, `latestMessagePreview`; `metadata`, a `ConversationMetadataWithKeyData` whose own
  `metadata` is the `ConversationMetadata`: `attributes` (`customTitle`, `customDescription`, `customAvatarUrl`,
  `muted`, `archived`, `defaultTtl`, `adminOnlyEditGroupInfo`, `adminOnlyAddMembers`, `adminOnlySendMessages`, …),
  `sortedParticipants` (`Participant`: `userId`, `isAdmin`, `isCurrentMember`), `selfParticipantIfCurrentMember`).
- `WebConvComponentContainer.dmComponent(…)` → `DefaultDmComponent`: `state` (`DmState`: `convId`, `chatItems.items`,
  `isLegacy`, `currentParticipantIds`, `readOnlyReason`), `composer` (its own `state` and `onEvent`), `onEvent(DmEvent)`,
  `messageActions(item, target)`.
- A message item (`MessageItemReceived` and its siblings): `id`, `created`, `sequenceNumber`,
  `sequenceNumberForReadState`, `textContent`, `fullText`, `senderInfo`, `isEncrypted`, `isUndecryptable`,
  `reactions` (`ReactionItem`: `reaction`, `participants`, `isSelected`, `attachmentId`), `replyPreview`, `attachments`,
  `editHistory`, `messageInfo.showEdited`, `hiddenState`, `forwardedMessage`, `alignsToViewerSide`.
- The graph's other factories, each what a screen makes: `messageRequestsComponent(callbacks, cancellation, other)`
  (the Requests page: `DefaultMessageRequestsComponent`, state `MessageRequestsState` with `previews`,
  `isLoading`, `hasMoreItemsInfo`, `confirmDeleteConvId`, `confirmBlockConvId`; `onEvent(MessageRequestsEvent)`),
  `newDmComponent(cancellation, …, onBack, onOpen(convId))` (New message and Create a group: `NewDmState` with
  `suggestions` of `NewDmSuggestion { user }`, `isCreateGroupMode`, `selectedGroupUsers`; the user an
  `XChatUserImpl` with `canSendMessage`, `cannotMessageReason`, `canBeAddedToGroup`); and on the container
  `addGroupParticipantsComponent(cancellation, convId, callbacks)` (Add people: `AddParticipantSuggestion { user,
  alreadyParticipant }`, `selectedUserIds`, `isCallingApi`; `handleEvent`) and `editGroupMetadataComponent(…)`
  (Edit Group: `currentTitle`, `currentDescription`, `saveButtonEnabled`, `descriptionCharactersRemaining`;
  `handleEvent`). The DM component has `forwardComponent` (the forward dialog: `ForwardMessageState` with
  `suggestions` of `ShareSheetSuggestion.Conversation { result }`, `selectedSuggestions`, `forwardedMessage`;
  `handleEvent`). A component's `Cancellation` is anything with `subscribe(teardown)`.
- `messageActions(item, target)` answers a `MessageActionsModel` (`rail`, `overflow`: `ChatMessageAction`s such as
  `Reply`, `Forward`, `Edit`, `DeleteForSelf`, `DeleteForAll`), which the UI sends back as `MessageActionClick`.
- Events, sealed classes with their subclasses as statics, exactly what the UI sends for a click:
  `ConversationListEvent.RowClicked(preview)`, `.ScrolledToBottomOfConversations`; `DmEvent.ScrolledToTop(info)`,
  `.VisibleReadableItemsChanged(scrolledToBottom, seqs)`, `.ReactionPickerItemClick(ReactionPickerItem(emoji,
  selected), message, attachmentId)`, `.DeleteMessageForAll(message)`, `.ReplyToMessageClicked(message)`,
  `.ResolveMediaImmediately(item)`, `.BackButtonClicked`; `ChatComposerEvent.UserChangedText(text, cursor)`,
  `.RightButtonClicked(button)` (when `rightButton` is `SendActive`), `.StartEditingMessage(message)`,
  `.StartReplyingToMessage(message, attachmentId)`, `.OnFileAttached(uri)`; `DmEvent.AcceptMessageRequest`,
  `.DeclineMessageRequest` and `.BlockMessageRequest` with their `Confirm…` (objects), `.MessageActionClick(action)`;
  `MessageRequestsEvent.AcceptRequestClicked(convId)`, `.DeleteRequestClicked(convId)` / `.ConfirmDelete`,
  `.BlockRequestClicked(convId)` / `.ConfirmBlock`, `.ScrolledToBottom`; `NewDmEvent.QueryChanged(query)`,
  `.SuggestionClicked(suggestion)`, `.CreateAGroupItemClicked`, `.CreateButtonClicked`;
  `AddGroupParticipantsEvent.QueryChanged`, `.UserRowClicked(suggestion)`, `.DoneClicked`;
  `EditGroupMetadataEvent.TitleTextUpdated(text)`, `.DescriptionTextUpdated(text)`, `.SaveButtonClicked`;
  `ForwardMessageEvent.QueryChanged`, `.SelectSuggestion(suggestion)`, `.UserChangedText(text, cursor)`,
  `.SendButtonClicked`, `.BackButtonClicked`. A conversation id is an `XConversationId` (`OneOnOne`, `Group`;
  `Companion.fromStringRequired`); a one-to-one's is the two user ids, the lower first, `a:b`.
- Addresses (the embed's own navigation): a conversation is `/i/chat/<id>` with its `:` written `-`; the Requests
  page `/i/chat/requests`, a request under it `/i/chat/requests/<id>`.

The file names above carry hashes that change with every build; nothing here depends on them (see the hooks).

## What runs

- **The sandbox** (packages/browser): Xvfb (:80–:89, then :100–:159), an ordinary Chromium with its profile in
  `<data>/accounts/<id>/profile` (which keeps the sign-in) and the extension copied in each start, x11vnc for the live
  view. No CDP, no automation flags.
- **Service workers**: Chromium goes on running the extension's service worker it first registered in a profile,
  whatever the copy or the manifest's version says. So when the copied worker is not the one the last start ran (its
  hash is kept in the account's `extension-worker.sha256`), the sandbox removes the profile's `Default/Service Worker`
  before launching, never while a browser holds the profile (`packages/browser/src/worker.ts`). The sites' own service
  workers go with it and register again on the next visit; cookies and Local Storage, and so the sign-in, stay.
- **The extension** (`src/extension`): `hook.js` in the page (MAIN world, at document_start on x.com), `content.js`
  relaying (ISOLATED world), `sw.js` holding the one token-gated loopback WebSocket to the extractor and reporting
  which page the tab is on (origin and path only).
- **What the page can see of the hook** is kept small ([page-traces.md](page-traces.md)): `hook.js` and `content.js`
  talk by CustomEvents of this install's own types (no window messages), the DevTools hook's functions read as
  native code, and the `onEvent` wrappers read like the client's own. The event types are not in the source, which
  has placeholders: the copy made each start gets names made for this install and account
  (`packages/browser/src/markers.ts`, from the manager's own secret), so no two installs show a site the same ones and
  none of them names us.
- **The extractor** (`src/main.ts`): checks every object the hook sends again (`validate.ts`), works out what changed
  (`ingest.ts`: the hook sends whole states), maps it to chat facts (`map.ts`), paces commands (`pace.ts`: writes
  1.2 s apart plus up to 0.9 s, reading 2.5 s apart plus up to 3.5 s) and computes the status (`status.ts`).

### The hooks, with their fallbacks

The self-test reports each as found or missing and how it was found; the account's details list them as
`hook.<name>`. Every one is located by a stable name or by shape, never by a module id or a minified name.

| hook | primary | fallback | without it |
|---|---|---|---|
| `react` | React's DevTools hook, installed before React loads: both React copies register (`inject`) and report every commit (`devtools`) | React's container keys `__reactContainer$…` on the page and in open shadow roots (`dom`) | nothing (core) |
| `graph` | a value in the fiber trees whose Kotlin class is `WebDmObjectGraph` (`name`) | an object with `conversationListComponent` and `convComponentContainer` (`shape`) | nothing (core) |
| `inbox` | `DefaultConversationListComponent` (`name`), the one the UI made | state flow + `onEvent` + `inboxCategoryDropdownComponent` (`shape`) | nothing (core) |
| `classes` | the sealed event classes from the core module's exports: its chunk (`dm-core-*.js`, from resource timing) imported again, which gives the same module instance without a request; matched by Kotlin name (`module`) or by their statics (`module+shape`). The module is found by its file name, or from the stack of one of the graph's getters called on nothing (`stack`) | the classes of the events the UI itself sends (`events`) | each command that needs them |
| `open` | `ConversationListEvent.RowClicked(row)` on the UI's list (`event:…`) | the conversation's address as the client writes it, `/i/chat/<id>` with `:` as `-` (a request's under `/requests/`), as a link (`navigate`); also used when the row event does not open it within 6 s, and for conversations not in the inbox (requests, a new one-to-one) | — |
| `history` | `DmEvent.ScrolledToTop(olderItemsInfo)` | — | no `history` capability |
| `read` | `DmEvent.VisibleReadableItemsChanged` + Kotlin's `List.fromJsArray` | — | no `markRead` |
| `quietReads` | the DM component's `onEvent`, wrapped once on its prototype (`prototype`) | — | opening a conversation to read it may mark it read |
| `send` | `ChatComposerEvent.UserChangedText` then `RightButtonClicked(SendActive)` | — | **read-only** (below) |
| `reply` | `ChatComposerEvent.StartReplyingToMessage` (`composer`) | `DmEvent.ReplyToMessageClicked` (`dm`) | replies refused |
| `edit` | `ChatComposerEvent.StartEditingMessage`, then type and send | — | no `edit` |
| `unsend` | `DmEvent.DeleteMessageForAll(message)` when the message's actions offer `DeleteForAll` (their `overflow`, or an older `deletableMessage`), the target from a class with `Companion.forMessage` (by shape) | — | no `redact` |
| `reactions` | `DmEvent.ReactionPickerItemClick(ReactionPickerItem(emoji, selected), item, null)` | — | no `react` |
| `attach` | the composer's own file input (`dm-composer-file-input`) in the shadow root: files set on it and a `change`, as when you pick them; checked while a conversation is open | — | files refused |
| `self` | the signed-in user's id the graph was made with (a Kotlin `UserId` field, `graph`) | x.com's `twid` cookie, which holds only the user id (`cookie`) | no `self` |
| `requests` | the Requests page's component from the graph's own `messageRequestsComponent` (`graph`), kept while the account runs | the Requests page itself, opened by its address and its component found in the fibers (`DefaultMessageRequestsComponent`, or a state with `selectedTab` and `confirmBlockConvId`), the inbox shown again after (`page`) | no `requests` |
| `answer` | the Requests list's `AcceptRequestClicked`, `DeleteRequestClicked` + `ConfirmDelete`, `BlockRequestClicked` + `ConfirmBlock` (`list:…`) | the conversation's own bar: `DmEvent.AcceptMessageRequest`, `DeclineMessageRequest` + `ConfirmDeclineMessageRequest`, `BlockMessageRequest` + `ConfirmBlockMessageRequest` (`dm`; also always for a group's request, which X's list does not answer) | no `requests` |
| `openDirect` | New message's component (`newDmComponent`): the handle typed into its search (`QueryChanged`), the person's suggestion clicked (`SuggestionClicked`), the conversation its `onOpen` names (`search`) | XChat's id rule, the two ids lower first (`id`); nothing checks X lets you message them | no `openDirect` |
| `createGroup` | New message → `CreateAGroupItemClicked`, each person from its search (`SuggestionClicked`), `CreateButtonClicked`; a name after, on Edit Group (`newDm`) | — | no `createGroup` |
| `addMembers` | the conversation container's `addGroupParticipantsComponent`: each from its search (`UserRowClicked`), `DoneClicked` (`container`) | — | no `addMembers` |
| `groupInfo` | the container's `editGroupMetadataComponent`: `TitleTextUpdated` / `DescriptionTextUpdated`, `SaveButtonClicked` (`container`) | — | no `configure` (`about` stays: it reads the inbox row) |
| `typing` | `ChatComposerEvent.UserChangedText` with a space and then nothing, in the open conversation's composer, whose typing handler sends the indicator (`composer`); never over a draft | — | no `typing` |
| `forward` | the message's `Forward` from its actions (`rail`), sent as `DmEvent.MessageActionClick`, then the forward dialog: the target among its suggestions (searched by name when not among the first), `SelectSuggestion`, a note as `UserChangedText`, `SendButtonClicked` (`action`) | `ChatMessageAction.Forward(message, null)` made here when the actions offer none (`action+new`) | no `forward` |

The PIN screen is told from the page's path (`/i/chat/pin/<mode>`), or failing that from its test ids in the shadow
roots (`pin-code-input-container`, `pin-title`), or a `…PinEntryComponent` in the fibers. Sign-in pages from the path
(`/i/flow/login`, `/i/jf/onboarding`, …) or the logged-out entry having loaded; checks from `/account/access` and other
`/i/flow/` pages.

### Reading

The hook subscribes to the inbox's state flow and to each open conversation's, and forwards a whitelisted copy:
ids, sequence numbers, times, texts, flags, reactions, attachments, users (an object with a screen name next to an id),
as primitives (BigInts as strings). Anything without the fields the mapping needs is dropped and counted, in the page
and again in the extractor (`dropped` in the details, by kind and reason: `message.no-time 3`).

The UI holds one open conversation, so messages are read by opening one: a conversation whose newest message is newer
than what was announced (from the inbox row's latest sequence number), at a reading pace, one at a time, and closed
again with `DmEvent.BackButtonClicked` (or its address). A fresh account looks at its 10 newest conversations; after a
restart only the ones with something new (`x-state.json` keeps the newest sequence number announced per
conversation, and nothing else). The inbox is scrolled a page at a time, as a person scrolls, up to 100
conversations.

**Quiet reads.** X's UI reports whatever is on screen as read (`VisibleReadableItemsChanged`). For conversations the
hook opens itself, it holds that event back (`readsHeld` in the details counts them), so reading does not mark
anything read on X. `markRead` sends that same event on purpose, for the messages up to the one named. Conversations
you open yourself in the live view are not touched.

### Requests, new chats and groups

Past reading and writing in a conversation, each feature is one of X's own screens, driven by its events, with its
own hook and capability (the hook's section "requests, new chats, groups, typing, forwarding"; the extractor's
`gaps.ts`). The components a screen would make are made with the graph's or the conversation container's own
factory and dropped after (a Cancellation whose `subscribe` takes the teardown); waiting is on their own state, and a
toast they raise is the refusal.

- **Requests.** The inbox's Requests row (`previewItems`' `MessageRequests` item: how many, and whether looked at)
  decides when to look: none waiting is said (`requests: []`) without opening anything; something waiting makes the
  Requests page's component and keeps it, so new requests and answers on the phone show as they come. **X marks the
  priority requests seen when that page loads its first page (`markSeenPriorityRequests`, the
  `MarkMessageRequestsSeen` mutation): the dot on the Requests row goes, on every device of yours. Nothing goes to the
  sender.** Opening a request's conversation (under `/i/chat/requests/…`, as its row does) shows the same page beside
  it. Its messages are read quietly like any conversation's: the read marks the UI makes are held, so nothing is
  marked read and nothing tells the sender (the hub never sends `markRead` or `typing` there either).
- **Typing** needs the conversation open: it is opened (quietly) for it and kept open 15 s, ready for the message that
  usually follows.
- **New chats and groups** go through X's own search, which takes a handle: the account must have seen the person's
  handle (any identity it announced), or the hub passes a handle for `openDirect`.

### Commands

| op | what the page does |
|---|---|
| `send` | opens the conversation, types the text into the composer (`UserChangedText`), presses send when the composer offers it. Markdown is made plain (X has no formatting). |
| `send` with `replyTo` | first `StartReplyingToMessage` on that message (it must be loaded) |
| `send` with files | the composer's file input takes them; it uploads them itself; send when ready |
| `edit` | `StartEditingMessage`, then type and send, if X offers editing that message |
| `redact` | delete for everyone, if X offers it (your own messages; X decides) |
| `react` | the reaction picker's click; again on a reaction of yours removes it. No super reactions. |
| `markRead` | the read event for the messages up to the one named |
| `typing` | a space typed into the composer and taken out again (X's own typing indicator goes, at most one per conversation every 6 s); nothing for a stop, nothing in a request, never over a draft |
| `forward` | the message's Forward action and X's forward dialog: the target conversation picked, the note typed, Send. A conversation the dialog does not offer answers `{ fallback }` (the hub sends the content itself) |
| `answer` | a request's Accept, Delete (decline) or Block on the Requests page (a group's, Accept in its conversation); declined or blocked, the conversation goes (`leave`) |
| `openDirect` | the one-to-one with them if there is one; else New message's search for their handle (or the handle given), and X's refusal when it will not let you message them. Nothing exists on X until the first message (`startsAtFirstSend`) |
| `createGroup` | New message → Create a group with each person from its search, Create, then the name on Edit Group. Whom X refuses (or whose handle this account has not seen) is in `failed` |
| `addMembers` | Add people with each from its search, Done; whom X refuses is in `failed` |
| `about` | the inbox row's settings and members (a group's name, description, picture, admins, admin-only flags; a one-to-one's two people) |
| `configure` | `name` and `topic` (description) on Edit Group, where the About says this account may; the picture is refused (not built) |
| `history` | scrolls to the top (`ScrolledToTop`) until it has enough or X has no more; messages arrive as backfill |
| `fetchMedia` (`x-media://<conversation>/<message>/<n>`) | the attachment as the page shows it: its blob, or after `ResolveMediaImmediately` (the client loading it), or its twimg URL fetched with the page's cookies as an `<img>` would. At most 25 MB. |
| `profile` | someone's profile and recent posts through responsive-web's own endpoints ("Notifications and profiles") |
| `post` | one post's thread (what it answers, the post, its replies; `cursor` for more replies) through the post page's own endpoint ("Notifications and profiles", `post`) |
| `postAct` | like, unlike, repost or unrepost a post, the one call its button makes ("Answering on X") |
| `publish` | a post, a reply (`replyTo`) or a quote (`quote`) through the composer's own `sendTweet` ("Answering on X") |
| `postReactors` | who liked or reposted a post, a page (`cursor` for more), as its Likes and Reposts tabs ask ("Answering on X") |
| `action diagnose` | the page's shapes into `diagnostics.json` (below) |
| `action selftest` | the self-test now |
| `action resync` | conversations and people announced again; the 10 newest read again |

Each waits, up to a limit, for the result to show in the client's own state (the sent message, the edit, the
reaction) before it answers. What the page refuses (no message to edit, not yours to delete, no send button) fails the
call with that reason.

Two things the page can notice: React's DevTools hook is present (as for anyone with React DevTools installed), and
the core's chunk is imported again (the module map answers it; were it not there, the browser would fetch the same
public file the page loads).

## Notifications and profiles

Around the chat, the signed-in page is responsive-web, and the hook reads X's notifications, profiles and post threads
through its own endpoint factories (`hook.js`, "the feed"; mapping in `src/feed.ts`; the protocol's shapes in
`packages/chat-protocol/src/feed.ts`). Each request is the one the Notifications tab, a profile or a post's page makes: the page's own
factory, given the page's own API client by `withEndpoint`, with the variables, features, headers and transaction id
the page sends. Nothing here builds a query.

### The hooks

Reported in the self-test with the others (`hook.<name>` in the details); none of them is needed by the DMs, and a
missing one takes only the feed, `profile`, `posts` or answering on X away.

| hook | how it is found | without it |
|---|---|---|
| `webpack` | webpack's require: a chunk pushed onto `webpackChunk_twitter_responsive_web`, whose function the runtime runs with its require; the chunk leaves the list again at once (`chunk`) | no feed, no `profile`, no `posts` |
| `store` | the Redux store, from react-redux's context value `{ store, subscription }` in the fiber trees (a provider's value, or the Provider's memo: `provider`), or any value with `dispatch`, `getState`, `subscribe` and `replaceReducer` (`shape`) | no feed, no `profile`, no `posts` |
| `endpoints` | the thunk's extra argument: `store.dispatch((dispatch, getState, extra) => extra)` returns it and no action reaches a reducer; `extra.api.withEndpoint` (`thunk.api`) or `extra.withEndpoint` (`thunk`) | no feed, no `profile`, no `posts` |
| `notifications` | the Notifications tab's timeline module (`getCreationOptions().network`: `getEndpoint(api)` is `api.withEndpoint(factory).fetchNotifications`, `getEndpointParams({count, cursor}, state)` its variables; the one whose `timelineType` is `All`). Its chunk is lazy: the route's own loader (a module whose source is `Promise.all([n.e(…), …]).then(() => n(<id>))`, picked because one of its chunks is named `bundle.Notifications.*` by `require.u`) loads it as opening the tab would (`loader`); if the tab was opened already the module is there (`module`). `pending` until the first read. | no feed |
| `profiles` | the factories whose source has `fetchOneUser:(` (UserByRestId) and `fetchUserTweets:(` (UserTweets, the Posts tab), found by reading the module sources (`require.m`, each once, with the page's untouched `toString`) and taking the export that holds the words (`module`) | no `profile` capability |
| `posts` | the factory whose source has `fetchTweetDetail:(` (TweetDetail, a post's page; in x.com's main bundle), found the same way (`module`) | no `posts` capability; no quoting (the quoted post is read through it) |
| `actions` | the tweet actions factory: the export whose source has `sendTweet:function(` and also `unretweet(` (in x.com's main bundle, one factory with `like`, `unlike`, `retweet`, `unretweet`, `sendTweet`, `destroy`, bookmarks and more), found the same way (`module`) | no `postActions`, no `publish` |
| `reactors` | the factory whose source has `fetchLikedBy:(` (`fetchLikedBy`: Favoriters, `fetchRetweetedBy`: Retweeters, `fetchEditHistory`). Its chunk is lazy: `shared~bundle.QuoteTweetActivity~bundle.TweetActivity` (also `bundle.TweetEditHistory`). At the first `postReactors` the route table's loader with a chunk named `bundle.TweetActivity` by `require.u` (else `bundle.TweetEditHistory`) is run as opening a post's likes would: its chunks, then its module (`loader`); found already loaded when someone opened a post's likes in the page (`module`). `pending` until then, and `postReactors` is offered while pending | no `postReactors` |

The notifications module also exports `updateLastSeenCursor`, the thunk that marks notifications seen on X. It is
never called; reading the timeline does not mark anything seen (the tab calls that thunk separately).

What comes back is forwarded as a whitelisted copy (`FEED_KEYS` in hook.js: the timeline, entry, notification, user and
post fields `feed.ts` reads, keys of digits for the user lookup's ids; at most 60,000 nodes, else `notifications.too-big`
is counted) and checked again in the extractor, where what does not fit is dropped and counted (`feed.dropped`:
`post.TweetTombstone 1`, `notification.no-time 2`).

### The feed conversation

One conversation per account, `{ nativeId: 'feed:<your user id>', shape: 'channel', variant: 'feed', name: 'Notifications' }`, read-only. Only the
**All** timeline is read (it holds mentions too). One message per actor:

| X shows | message id | kind, body | author | `extra.feed` |
|---|---|---|---|---|
| a like (`heart_icon`), aggregated or not | `like:<post>:<user>`, one per person in `from_users` and per post in `target_objects`, all with the notification's time | `system`, "liked your post" ("liked a post you were mentioned in" when the post is someone else's) | the liker | `{ type: 'like', post, url }` |
| a repost (`retweet_icon`) | `repost:<post>:<user>` | `system`, "reposted your post" (or "…a post you were mentioned in") | the reposter | `{ type: 'repost', post, url }` |
| a follow (`person_icon`) | `follow:<user>` | `system`, "followed you" | the follower | `{ type: 'follow', url }` (their profile) |
| a reply (a `TimelineTweet` entry) | `reply:<their post>` | `text`, their post's text; `mentionsSelf` | its author | `{ type: 'reply', theirs, url }`; `theirs.replyTo` is `{ id, author }` of your post (X sends only its id, so there is no `post`) |
| a mention | `mention:<their post>` | `text`, their post's text; `mentionsSelf` | its author | `{ type: 'mention', theirs, url }` |
| a quote | `quote:<their post>` | `text`, their post's text | its author | `{ type: 'quote', theirs, post, url }` (`post` is the quoted post, also `theirs.quoteOf`) |
| anything else (milestones, X's own notices, recommendations…) | `other:<notification id>:<user>`, or `:-` with nobody named | `system`, X's own sentence (`rich_message.text`) | that person, or **`x`** (an identity `{ nativeId: 'x', displayName: 'X' }`) | `{ type: 'other', text, post?, url? }` |

Which kind a `TimelineTweet` entry is comes from its client event (`user_replied_to_your_tweet`,
`user_quoted_your_tweet`, `user_mentioned_you`), else from the post (quoting your post, replying to you, else a mention).
`post` and `theirs` are `PostFact`s: `id`, `url` (`https://x.com/<handle>/status/<id>`), `ts`, `author`, `text` (links
expanded from `entities.urls`, a long post's whole `note_tweet` text, a reply's leading @names left out as
`display_text_range` says, the media and quote links removed, `&amp;` and the like decoded), `replyTo`, `repostOf`,
`quoteOf`, `counts` (replies, reposts, likes, quotes, views), `media` (`image`, `video`, `gif`; the https
`pbs.twimg.com` picture, a video's poster frame, size and alt text). A post wrapped in `TweetWithVisibilityResults` is
the post inside; tombstones are dropped.

Before the messages of a page: the conversation (once), an identity fact for every actor and every post author
(handle, display name, https avatar), then the people's profiles (below). Messages are sent oldest first; `live: true`
only for one newer than the newest announced, under 15 minutes old and not announced before (an aggregated like comes
again with every new liker; the earlier likers are not live again). A fresh account's first read is backfill.

**Pacing**, like a person checking the tab: the first read 30-60 s after the account goes online, then every 4-8
minutes (jittered), only while it is online, and not while a command or catching up on DMs is running (then 20-40 s
later). A fresh account reads back two pages (40 a page asked; X sends fewer) or seven days at most, older entries left
out. After that each read asks only for what is newer than the newest page's Top cursor. `x-state.json` keeps, besides
the DMs' sequence numbers, `feed: { top, newestMs, ids }`: the Top cursor, the newest time announced and the last 2,000
message ids announced (ids and cursors only).

### People in it

For each actor seen, a `personAbout` event (`{ who, about, ts }`) at most once per person per 24 hours (kept in memory,
not on disk; after a restart they are announced again): `displayName`, `handle`, `avatar`, `bio` (links expanded),
`createdAt`, `counts` (`followers`, `following`, `posts`), `followsYou`, `relationship: 'following'` when you follow
them, `links` (their X profile, and their website), and their location as a fact. Never posts.

### `profile`

Capability `profile` when `store`, `endpoints` and `profiles` are found. Only on request (someone opened the profile),
never on a timer, at the reading pace. The hook calls the page's `fetchOneUser({ user_id })` (UserByRestId; the page
normalizes it to `{ entities: { users: { <id>: user } }, result }`) and `fetchUserTweets({ count: 20, userId })`
(UserTweets, the Posts tab; `isPaymentsEnrolled` is left out, which the page sets from its state), a moment apart as
opening a profile does. The reply is the `PersonAbout` above plus `posts`: up to 20, the pinned one first with
`pinned: true` (from the timeline's `TimelinePinEntry`), then newest first, reposts as the reposter's post with
`repostOf` and empty text, quotes with `quoteOf`, promoted posts left out. Identity facts for every author named come
first. An unknown or suspended user fails with "X did not give this profile".

### `post`

Capability `posts` when `store`, `endpoints` and `posts` are found. `{ t: 'post', post, cursor? }` reads one post's
thread as its page on X shows it: only on request (someone opened the post), never on a timer, at the reading pace
(2.5-6 s after the last read ended, shared with every other read: DMs, media, notifications, profiles), one request
per call. The hook calls the page's `fetchTweetDetail({ focalTweetId, cursor, referrer: 'tweet', rankingMode:
'Relevance' })` (TweetDetail, with the variables, features and field toggles the page adds itself,
`includePromotedContent` among them as the page asks), which resolves to the conversation's URT timeline. Nothing else is sent: no like, no read mark, and nothing is drawn, so the
page logs no view or impression of the post, its replies, the ads or "Discover more".

The reply is a `PostThread`: `focal` (the post), `ancestors` (the `tweet-<id>` items above it: what it answers, the
thread's first post first), `replies` (one chain per `conversationthread-<id>` module, a reply and the answers X shows
under it, at most 20 a chain and 100 chains a page; the focal post's author going on with their own thread first, as
X shows it) and `more`: the page's Bottom cursor ("Show more replies"), else ShowMoreThreads, else
ShowMoreThreadsPrompt, or null. Asked again with that `cursor`, the answer is the next page: more modules, and posts
added to a chain already shown (`TimelineAddToModule`) as one more chain; `focal` may be absent then. A module's own
"Show replies" cursor (ShowMore) is not followed. Promoted entries (`promoted-…`, `promotedMetadata`) and "Discover
more" (`tweetdetailrelatedtweets-…`) are left out; posts that are gone (`TweetTombstone`, unavailable) are dropped and
counted (`post.TweetTombstone`). Every `PostFact` (here, in profiles and in the feed) carries `root`, the thread's first
post (`legacy.conversation_id_str`). Identity facts for every author come first. A post X does not give (deleted,
protected, unknown) fails with "X did not give this post".

The copy the hook forwards of a TweetDetail answer may hold 200,000 nodes (60,000 for other answers), and its cursor
entries are copied first, so a long thread cut short still says where more replies are (`detail.too-big` counts a
cut). `history` for the feed or the hub's logged posts (`feed:<id>`, `posts:<id>`) is answered at once with nothing:
they are no chat on X, and the page is never sent looking for one.

## Answering on X

Likes, reposts, posts and who liked: each the one call X's own button or composer makes, through the page's own
factories (`actions`, `reactors` above), made **once, when the command comes**: nothing is sent before, nothing is
retried after. A write goes at a person's pace (the DMs' writing pace: 1.2-2.1 s after the last write ended); a read of
who liked goes at the reading pace (2.5-6 s, shared with every other read). Every `PostFact` the extractor gives
(threads, profiles, the feed, a post just made) carries `viewer: { liked, reposted }`, from the post's
`legacy.favorited` and `legacy.retweeted` as X answered them for this account (left out when X sends neither).

Capabilities: `postActions` and `publish` when `store`, `endpoints` and `actions` are found; `postReactors` when
`store` and `endpoints` are found and `reactors` is found or pending.

### `postAct`

`{ t: 'postAct', post, act }`: `like` calls the factory's `like({ id })` (FavoriteTweet `{ tweet_id }`), `unlike`
`unlike({ id })` (UnfavoriteTweet), `repost` `retweet({ id })` (CreateRetweet `{ tweet_id }`), `unrepost`
`unretweet({ id })` (DeleteRetweet `{ source_tweet_id }`). No `promotedContent` is passed (that is for ads). The
answer is a `PostViewer` with the one flag the act sets: `{ liked: true }`, `{ liked: false }`, `{ reposted: true }`,
`{ reposted: false }`; the other flag is not read (ask `post` for the whole post). When X answers that it is so
already (code 139 for a like, 327 for a repost) the act counts as done. Any other failure fails the call with X's
words: the page's API client rejects with an ApiError whose `errors` hold X's codes and messages (the message after
its "Kind: " prefix, as the client cuts it); the first message is the error, else the error's own message.

### `publish`

`{ t: 'publish', text, replyTo?, quote? }`. The text is checked first against X's rules as the hub checks it
(`composeState` with `POST_RULES.x`: 280, weighted), so a too-long post fails ("too long for X: 281 of 280") before
the page is asked. Then the composer's own `sendTweet(options)` with `{ status: text }`, plus, for a reply,
`in_reply_to_status_id` and `exclude_reply_user_ids: ''` (nobody left out), and, for a quote, `attachment_url:
https://x.com/<handle>/status/<id>`. The handle is the quoted post's author's, read first through the post page's
factory without replies (`fetchTweetDetail({ focalTweetId, withReplies: false })`: TweetResultByRestId); a quoted
post X does not give fails the call ("X did not give the post to quote") before anything is posted. `sendTweet` sends
CreateTweet (CreateNoteTweet for a long post on an account allowed one: its own choice) and resolves to the made post
normalized: `{ entities: { tweets: { <id>: post, flat } }, result: <id> }`.

Once X has made the post, the answer is that post and the call never fails: the hook reads it back alone
(TweetResultByRestId, 0.4-0.9 s later) and `feed.ts parsePublished` maps it as any post (author, `replyTo`,
`quoteOf`, `root`, `viewer`); if that read fails, the normalized post `sendTweet` gave (its legacy fields at the
top, its author as an id); else the id, the text and now. The link is made with your handle when X's answer gave none.
Identity facts for the people in it come first. Only when X's answer names no post at all does the call fail, with
"X did not say which post it made: look on X before posting again" (it may have been made). A failure of the send
itself is X's words: "Status is a duplicate." (187), "No status found with that ID." (144) and the like.

### `postReactors`

`{ t: 'postReactors', post, kind: 'like' | 'repost', cursor? }`: the page's `fetchLikedBy` or `fetchRetweetedBy`
(`{ count: 20, cursor, enableRanking: true, tweetId }`: ranked, as the Likes tab's ranked timeline asks), which
resolves to the `favoriters_timeline` / `retweeters_timeline` URT timeline. The answer is a `ReactorsPage`: `who`, in
X's order, each `{ id, followers?, following?, followsYou?, verified? }` (followers from `legacy.followers_count`;
`following`: you follow them, `followsYou`: they follow you, from `relationship_perspectives` or `legacy`;
`verified` when `is_blue_verified`, `verification.verified` or `legacy.verified`), and `more`: the Bottom cursor,
or null when the page has nobody on it. Identity facts for everyone in it come first. X shows who liked a post only to
its author (since 2024): for someone else's post the answer is `{ who: [], more: null }` if X answers with an empty
timeline (as the fake does), else X's error. Reposts are public.

### What is a guess about the live X

Read from the public bundle (2026-11-12), run only against the fake:

- the actions factory's marker (`sendTweet:function(`, `unretweet(`), and that `withEndpoint` gives it the same
  client the buttons use;
- that X still answers "already liked" with code 139 and "already reposted" with 327, and that the ApiError's
  `errors` carry them (`extensions.code` or `code`) with a readable message;
- what `sendTweet` with only `status` (and the reply or quote fields) sends: `batch_compose`,
  `semantic_annotation_ids` and `media` are filled by its own variable builder; `exclude_reply_user_ids: ''` as an
  empty list; whether a reply needs more (X's composer may add the mentioned users);
- that `attachment_url` with the author's handle is what quoting needs (the composer's own form), and that
  TweetResultByRestId gives a just-made post at once;
- whether `result` of the normalized answer is the new id (the tweet schema's `idAttribute` is `rest_id`);
- the TweetActivity route's loader: that the route table holds a loader whose chunks include one named
  `bundle.TweetActivity` (`shared~bundle.QuoteTweetActivity~bundle.TweetActivity` holds the factory), and that loading
  it from /i/chat works;
- what Favoriters answers for someone else's post (an empty timeline is assumed), whether its last page carries a
  Bottom cursor with nobody (handled either way), and how many people a page holds with `count: 20`.

**What a live check should look at**: after one like and unlike of a post of your own, one repost and unrepost, one
reply to your own post (then delete it on X), and `postReactors` on a post of yours with likes: `hook.actions` should
say `found (module)` and `hook.reactors` `found (loader)` (or `module`). `action diagnose` writes
`diagnostics.json`, whose `page.feed` has `actions.keys` (the factory's method names: `like`, `unlike`,
`retweet`, `unretweet`, `sendTweet` must be among them), `reactors.chunk` (the chunk it loaded) or
`reactors.chunks` (the loaders' activity chunks, when none worked), and the shapes of the last answers:
`responses.act` (`{ favorite_tweet }`, `{ create_retweet: … }`…), `responses.created` (the normalized post),
`responses.reactors` (the timeline). The log names each failed act (`postAct.like failed {error}`) with X's words.

### Users in both layouts

2025's (`core.name/screen_name/created_at`, `avatar.image_url`, `location.location`, `relationship_perspectives
.following/followed_by`, counts in `legacy`) and the older one (everything in `legacy`: `name`, `screen_name`,
`profile_image_url_https`, `location`, `following`, `followed_by`), and the flat one the user lookup normalizes to.

## The status, and telling which hook broke

Layers: **display → browser → extension → signed in → hooks → XChat keys → inbox → sending → feed**. The feed layer
never changes the account's status: the DMs go on whatever it says.

| what you see | which | what to look at |
|---|---|---|
| attention `login`, layer *signed in* waiting | X's sign-in page | sign in in the live view |
| attention `verify` "Enter your XChat PIN…", layer *XChat keys* waiting `(verify)` | the PIN screen | enter the PIN in the live view |
| layer *hooks* waiting "N of 23 found so far; not yet graph, inbox" | still loading, or not on /i/chat | wait 90 s; the page path is in the details |
| attention `selector_broken` "X changed: graph, inbox no longer found", layer *hooks* failed | a core hook | `hook.react`, `hook.graph`, `hook.inbox` in the details; `diagnostics.json` (written by itself when this happens) |
| attention `selector_broken` "…sending was not found, so this account only reads", layer *sending* failed "read-only" | `send` | `hook.send` missing; `classes.ChatComposerEvent` in `diagnostics.json`. It keeps reading; the hub is told it cannot send. |
| layer *sending* ok "can send; not reactions" | one feature | that `hook.<name>`; only its capability is gone |
| layer *inbox* "…; 12 objects dropped" | the shapes moved | `dropped` in the details names the kind and reason |
| `lastCommand` "send failed" | a command | the log line `send failed {error}` |
| layer *feed* waiting "first read at 12:34:56" | the feed has not read yet (30-60 s after online) | wait |
| layer *feed* failed "X changed: store, endpoints not found, so notifications cannot be read" | a feed hook, past the grace period | `hook.webpack`, `hook.store`, `hook.endpoints`, `hook.notifications`, `hook.profiles`, `hook.posts`, `hook.actions`, `hook.reactors`; `feed` in `diagnostics.json` |
| `lastCommand` "postAct.like failed", "publish failed", "postReactors failed" | answering on X | the log line with X's words; `feed.actions`, `feed.reactors` and `feed.responses` in `diagnostics.json` |
| layer *feed* failed "last read failed: …" | the last read | the log line `feed read failed {error}`; it tries again 4-8 minutes later |

`details` (names, ids and counts only): `display`, `page`, `pageState`, `pinMode`, `extensionAttached`, `hookVersion`,
`hooks`, `self` (the user id and how it was found), `conversations`, `xchat`, `legacy`, `groups`, `openInPage`,
`reactRenderers`, `fiberRoots`, `modulesLoaded`, `modulesScanned`, `readsHeld`, `dropped`, `lastCommand`,
`diagnostics`, `hook.<name>` for each hook (the feed's too: `hook.webpack`, `hook.store`, `hook.endpoints`,
`hook.notifications`, `hook.profiles`, `hook.posts`, `hook.actions`, `hook.reactors`): `found (via)`, `pending` or `missing`, and the feed's counts: `feed.items`
(messages announced since the start), `feed.people` (profiles announced), `feed.lastFetch`, `feed.nextFetch`,
`feed.lastError`, `feed.dropped`.

**Diagnostics** (`action diagnose` from Try it, and by itself once 20 s after the account first goes online, when a
core hook is missing past the grace period, and when a command fails with "X changed"): `diagnostics.json` in the
account directory, mode 0600, at most every 10 minutes unless asked. It holds shapes only: the React renderers and
their versions, root and fiber counts, the context providers by Kotlin class, the graph's class and key names, the
module it scanned and how it was found, each event class with its subclasses' names and the argument counts of the ones
used here, the inbox component's and state's keys with their value types (`bigint`, `list(20)`,
`obj:ConversationPreviewWithMetadata`, `enum:RightButton.SendActive`), one inbox row's shape two levels deep, for each
open conversation its state's, items' and composer's shapes and counts of items by class, the self-test and the drop
counts; and `feed`: the feed hooks and how they were found, webpack's module count and which words were found, the
store's own keys and its state's top-level keys, the endpoints object's keys, the notifications module's keys and
creation options' shape and the chunk it loaded, the post actions factory's method names, the activity chunk loaded
for who liked (or the loaders' activity chunks when none worked), and the shapes of the last notifications, user,
posts, thread, act, made post and reactors answers (keys and types, arrays as their length and first element, ids as
`<id>`). Never a value.

The log (`adapter.log`) has ids, counts, hook and class names and statuses (`feed read: 3 new, 1 page(s)`). Never
message text, a notification's words, a person's name or handle (the account's own handle is in its *signed in* layer, as for every chat kind), a cookie, a token or the PIN.

## Facts and ids

- **Conversations**: X's conversation id as the client has it (legacy one-to-one DMs are `<user id>-<user id>`). Shape
  `group` from the id's Kotlin class (`ConversationId.Group`) or more than one other person, `self` for a DM with
  yourself, else `direct`. `encrypted: true` for XChat, `false` for legacy DMs. Groups carry their custom name and
  picture. Participants: you and the others the row or the open conversation names.
- **People**: the user id, the screen name as `handle`, the display name, the picture (https only).
- **Messages**: the item's `id`; body as X has it (plain text, kept as is); author from the sender; `kind: 'encrypted'`
  with an empty body when XChat could not decrypt it on this browser; replies by the reply's message id or its
  sequence number; reactions as a snapshot on first sight, then `reaction` events (reactions on a single attachment
  are counted in `extra.attachmentReactions`, not shown); `extra.seq`, `extra.encrypted`, `extra.edited`. An edit sends
  the message again with `editedTs` (when it was seen). Live only when newer than what was announced in that
  conversation and less than 15 minutes old.
- **Deletes**: a message the client hides (`hiddenState`), or one gone from inside the range the page has loaded.
- **Read state**: from the inbox row (unread count, up to the last read message when it is known).
- **Typing**: from the inbox's typing indicators (start, and stop when gone; 8 s).
- **Groups**: a group's description is its `topic`; a conversation you muted on X has `mute: { level: 'none' }`.
- **Requests** (the Requests page, `requests` / `request` / `requestGone`): one per conversation, its id the
  conversation's. A one-to-one is `kind: 'message'` from the other person, answers accept, decline (X's Delete) and
  block; a group someone put you in is `kind: 'invite'` with its name and size, answered only with accept (X's
  list answers one-to-ones only, and its conversation bar has no decline for groups). The request's conversation is
  announced and read as any other (quietly); the hub keeps it quiet until it is accepted.
- **Attachments**: `x-media://…` references, fetched through the page; kind from the mime or X's media type.

## What is verified, and what is not

**Verified** by `test/x-browser.test.ts` and `scripts/verify-x.ts` against the fake x.com (`test/fake-x.ts`,
`extractors/x/test/fake-page/`): an ES-module page whose host and embed each bundle **real React 19.3.1** (built
with Bun.build, minified, production), the embed drawn into an open shadow root, and a core shaped like the real one
(Kotlin `$metadata$` names, getters over mangled fields, BigInt sequence numbers, `ExportedStateFlow`, sealed events
with statics, mangled export names, the UI's own read marking from an effect). In real Chromium through a real manager:
the DevTools hook catching both renderers; every hook found and how; the inbox (legacy DM, XChat group, XChat
one-to-one) and people; catching up with **no read reaching the fake server**; live messages and typing; send, reply,
edit, react (and remove), unsend (and the refusal for someone else's message), mark read (exactly one read call),
history scrolled to the beginning, a picture fetched through the page and one sent through the composer's file input;
diagnostics holding shapes only; nothing personal in the log or status; the PIN screen as attention, then online;
signed out as attention; and the fallbacks: the core module under another file name found from a stack, the
composer's class hidden (read-only, said so, still reading, sends refused), every Kotlin class renamed (found by
shape; reactions, which have no shape to go by, missing and only that). The unit tests (`extractors/x/test`) cover
validation, mapping, the diffs and the status.

The feed and profiles, against the same fake's responsive-web part (`test/fake-x-feed.ts`,
`extractors/x/test/fake-page/rw-*.js`: a webpack 5 runtime with `req.m`, `req.u`, `req.e` loading the lazy
`bundle.Notifications` chunk and a shared one by script tags, minified-style modules, a Redux store with redux-thunk
whose extra is `{ api }`, react-redux's Provider in the host's React, factories with `fetchNotifications:(`,
`fetchOneUser:(` and `fetchUserTweets:(`, the route's loader, `updateLastSeenCursor`, and a GraphQL server answering
NotificationsTimeline, UserByRestId and UserTweets with X's shapes, made-up people): every feed hook found and how,
the Notifications chunk loaded once by the loader, the first read two pages back and no further, every kind of
message with its author's identity and profile first, a new like live on the next look (asked for by the Top cursor),
`profile` with the pinned post, a repost, a quote and a picture, **no seen-marking call reaching the fake server**,
diagnostics with the answers' shapes only, nothing of the feed in the log or status. `extractors/x/test/feed.test.ts`
covers the parsing (both user layouts and the flat one, `TweetWithVisibilityResults`, long posts, reposts, quotes,
media, aggregated likes, replies, mentions, follows, X's own notices, cursors, drops by reason) and what is announced
(order, live, profiles once a day, the kept state).

Answering on X, the same way (the fake's main chunk has the tweet actions factory with mutations POSTed as JSON and
an API client that rejects as x.com's does; `rw-activity.js` holds the activity route's two lazy chunks; the server
keeps each post's `favorited`, `retweeted` and counts, and answers X's errors 139, 327, 144 and 187): like, repost,
like again (139, done), unlike, unrepost, each one POST with X's variables, and the post read again showing
`viewer`; a like of an unknown post failing with X's words, sent once; a post, a reply (`reply.in_reply_to_tweet_id`)
and a quote (`attachment_url` with the author's handle, the quoted post read first), each read back and answered
with its author, `replyTo`, `quoteOf` and `root`; a duplicate failing with X's words after exactly one CreateTweet;
a too-long or empty post refused before the page is asked; who liked your post, ranked, two pages and an empty last
one, its chunks loaded once by the route's loader, who reposted it, and nobody for someone else's post.
`feed.test.ts` covers `viewer` in every kind of post, `parsePublished`'s three ways and `parseReactors`.

Also verified the same way: the Requests page's list (a one-to-one request and a group invitation), its
conversation read with no read reaching the fake, Accept, Delete and Block with their confirmations (and the
conversation bar's Accept for a group), a new request live, the Requests page itself as the fallback (`page`);
`openDirect` finding one there already, opening a new one through New message's search that the first message makes,
and X's refusal for someone it lets nobody message; Create a group with a name set after on Edit Group, someone X
will not add in `failed`; Add people; About with admins and admin-only info (refused before anything is asked of X);
a description on Edit Group; typing from the composer (and none for a stop, or again too soon, and nothing left in
the composer); a forward with a note, and `fallback` for a conversation X's dialog does not offer.

**Not verified: the real X**, beyond this: a live account signed in, and its self-test found every DM hook (the
signed-in x.com is responsive-web, not x-web; the embed is the same). The shapes above are read from the public
bundles; only using a signed-in page shows:

- that the graph, list and DM components sit in the fiber trees where the hook looks (context value, props, `useMemo`
  results, React Compiler caches), and that the embed's React registers with the DevTools hook (it calls
  `inject` and `onCommitFiberRoot` in its bundle, as x-web's does);
- `RowClicked`'s argument: the row object the hook passes may not be the type the list expects (then the address
  fallback opens it, and `hook.open` says `navigate`), and the real path segment for a conversation id;
- what `id`, `created`, `senderInfo`, `reactions[].reaction`/`participants` and the attachments' fields hold (types the
  hook converts tolerantly; drops are counted by reason);
- whether opening a conversation marks it read by any other route than `VisibleReadableItemsChanged` (the UI's
  `UiShown`, the component itself);
- whether `DeleteMessageForAll` takes `deletableMessage.message` or the item, and `ReactionPickerItemClick` the item;
- how the composer's `rightButton` behaves with attachments, and how media resolves (`localOrRemoteUri`, blobs);
- the PIN modes, and whether a new browser always goes to `/i/chat/pin/…`;
- the inbox's paging (`hasMoreItemsInfo`).
- whether the inbox's `previewItems` carry the Requests row as read here, or only `messageRequestsButton` (then the
  requests are looked at only once at the start and on changes the hook can see);
- that a `messageRequestsComponent` made by the hook (not by the page) loads and stays live; that answering from its
  list behaves as the page's buttons (`ConfirmDelete` and `ConfirmBlock` after the confirmation state is set);
- whether opening a request's conversation sends anything to the sender by another route than
  `VisibleReadableItemsChanged` (X's own help says the sender is not told until you accept);
- `newDmComponent`'s argument order (from the embed: `cancellation, undefined, undefined, onBack, onOpen`), that
  `QueryChanged` with a whole handle searches as typing it does, and that `onOpen` gets the new group's id;
- Add people and Edit Group made on a container the hook made (`convComponentContainer`), and their callbacks'
  `onFinished` after a save;
- that a space and then nothing in the composer sends X's typing indicator (its `TypingIndicatorSendHandler` runs on
  a text change) and leaves no draft;
- the forward dialog's first suggestions, and what `result` holds for a conversation (`inboxItem.conversationId` is
  what is matched);
- that `/i/chat/<id with - for :>` opens a one-to-one nobody has written in yet.

**The feed and profiles, unverified on a real account** (read from the signed-in bundle as of November 2026, run
only against the fake):

- that the store is found from react-redux's context value (or by its shape), and that its thunk's extra has `api`
  with `withEndpoint` (read in `main`: `(e, t, { api: i }) => i.withEndpoint(…)`);
- that the chunk probe gets the require on the live page, that the route loader is found by `require.u` naming
  `bundle.Notifications.*`, and that loading its chunks from /i/chat works as from the tab;
- the notifications answer itself: the icons (`heart_icon`, `retweet_icon`, `person_icon`; others are `other`),
  whether `timestamp_ms` is a string, the client event names for replies, mentions and quotes, how aggregated likes
  grow, whether the Top cursor gives only what is newer and what a page holds;
- what `fetchOneUser` normalizes a user to (the flat layout is assumed from the code: the user schema's
  `processStrategy` was not read in full), and whether UserTweets without `isPaymentsEnrolled` answers as the page's;
- that reading the timeline never moves X's own unread count (the brief's finding: only `updateLastSeenCursor` does).
- answering on X: see "Answering on X", "What is a guess about the live X".

## Your real-account checklist

1. Add **X** on the accounts page. Open the live view, sign in, pass X's checks yourself. Leave it on Chat.
2. If it asks for your XChat PIN, enter it in the live view. Then check the account goes **online**, every layer ok.
3. Look at the details: every `hook.<name>` should say `found`; note any `missing` and any `via` that is a fallback
   (`dom`, `shape`, `stack`, `events`, `navigate`).
4. Run **Try it → action `{ "action": "diagnose" }`**, or wait for the automatic one; `diagnostics.json` in the account
   directory is the second round's input (shapes only: safe to share).
5. In dither-chat: your conversations appear (legacy and XChat, groups named), recent messages are there, and **your
   phone shows nothing newly read** from this (the decisive check for quiet reads).
6. Send a message to someone (or yourself), reply to one, edit it, react and unreact, delete it for everyone, load
   older history, open a picture, send a picture; each should show on your phone as if you did it in the browser.
7. About a minute after it goes online: the account's details show `hook.webpack`, `hook.store`, `hook.endpoints`,
   `hook.notifications` (`loader` or `module`) and `hook.profiles` found, and `feed.items` counting; the *feed* layer
   ok. In dither-chat the Notifications conversation holds your recent likes, reposts, replies, mentions, quotes and
   follows, one per person, and **X's own bell still shows your unread notifications** (nothing marked seen). Open
   someone's profile in dither-chat: their bio, counts and recent posts. If anything is off, `diagnostics.json`'s
   `feed` has the shapes of what X answered.
   Answering on X: like and unlike a post of your own, repost and unrepost it, reply to it once (delete the reply on
   X after), and open who liked it; each shows on your phone as if done in the browser, and `hook.actions` and
   `hook.reactors` say `found` ("Answering on X", "What a live check should look at").
8. Mark a conversation read from dither-chat: it should show read on your phone.
9. The new hooks: `hook.requests` (`graph`), `hook.answer` (`list:…`), `hook.openDirect` (`search`),
   `hook.createGroup`, `hook.addMembers`, `hook.groupInfo`, `hook.typing`, `hook.forward` should all say `found`;
   `diagnostics.json` has `requests` (`signal: true` means the inbox's Requests row was read) and `graphFactories`.
10. **Requests**: have someone you do not follow (a second account of yours) send you a DM. In dither-chat it shows
    under Requests with what they wrote; open it there and check **your phone shows it still unread and the sender's
    app shows no "seen"**. Expect the dot on X's Requests row to go (X marks the page seen). Then Accept it: it moves
    to your inbox on the phone. Try Delete and Block on two more (they leave X's Requests on the phone).
11. **New chat**: start a chat with someone you have never messaged (by their handle in New): nothing appears on X
    until you send; your first message should arrive as a normal DM. Try someone who cannot be messaged by you: the
    reason shows.
12. **Groups**: make a group of two people with a name; check the name on the phone. Add a third. Change its
    description; try renaming a group where only admins may and you are not one (refused, nothing changes).
13. **Typing**: start typing a reply in dither-chat to someone whose app you can watch: X's typing dots should show
    there; the live view's composer should be empty afterwards.
14. **Forward** a message into another conversation with a note: the phone shows it as forwarded, with the note.
15. Anything wrong: the account's log lines for that command, `lastCommand`, `dropped`, and `diagnostics.json`.

## Facts for dither-chat's tables (`packages/protocol`)

From the bundle's own code and its SQLite schema, for XChat; legacy DMs may differ where noted:

- **Reactions: several per person, not one.** The reaction table's key is `(entry_sequence_number, attachment_id,
  added_by_user, emoji)`, with a unique index on `(entry_sequence_number, added_by_user, emoji)` for message-level
  reactions, and the picker keeps a *set* of your selected reactions. So `REACTION_RULES.x.exclusive` should be
  `false`. Legacy DMs (the old API) allowed one reaction per person; unverified for legacy conversations in this client.
- **Any emoji**: the picker offers the whole Unicode emoji set (`getAllEmojis()`, plus quick reactions), stored as
  text. Not free text in the UI. `freeText: false` is right. Reactions can also be on one attachment of a message.
- **Attachments per message: 1** by default (`xchat_max_attachments_per_message`, default 1, a feature switch the
  server can raise; the composer also reports `maxAttachments`). `files: 1` is right. No per-file byte limit is in the
  client (forwarded media up to 100 MB: `xchat_forward_media_max_size_mb`); 25 MB (the hub's own) stays.
- **Group settings**: a name (`customTitle`, up to 32 characters on Edit Group), a **description**
  (`customDescription`, up to 500: `xchat_max_group_description_length`) and a picture (`customAvatarUrl`), each
  editable by everyone unless `adminOnlyEditGroupInfo`; also disappearing messages (`defaultTtl`), screenshot
  blocking, admin-only adding members, sending, calls. `ABOUT_RULES.x` has `name`, `avatar` and `topic` with
  `nameMax: 32`, `topicMax: 500`. Groups hold up to 200 people (`xchat_max_group_size`).
- **Making a group** (`GROUP_RULES.x`, dither-chat #147): New message → Create a group, at least one other person
  (Next is off with none), a name optional (X names it after its people), the picked from its search where
  `canBeAddedToGroup`.
- Message length: the composer reports `maxMessageLengthBytes` (a server value, not in the bundle).

## Tests

- `extractors/x/test/*.test.ts`: validation (`validate.test.ts`), mapping (`map.test.ts`), diffs (`ingest.test.ts`),
  status and capabilities (`status.test.ts`), pacing (`pace.test.ts`), the feed and profiles (`feed.test.ts`, with X's
  GraphQL built by `feed-fixtures.ts`), requests, About and the facts of what is made from here (`gaps.test.ts`).
- `test/x-browser.test.ts`: the extractor in its real sandbox against the fake (`test/fake-x.ts`), skipped without
  Xvfb, chromium and x11vnc.
- `bun scripts/verify-x.ts [--keep]`: the same end to end with a throwaway manager process (port 18575), as the page
  and dither-chat use it (the page's API signed in with that manager's CLI token).
