# Substack: the `substack` kind

`extractors/substack` holds one Substack account's reading: the **Inbox** (newest posts from the publications you
subscribe to), **Notes** (Home's For you tab), your **Activity** (likes, restacks, comments, replies, mentions, new
followers and subscribers) as one read-only conversation, anyone's profile with their recent notes and posts, and any
post's or note's thread with its comments. When asked, it likes and unlikes, restacks and undoes a restack, writes a
note, a reply to a note or comment, or a comment on a post, and deletes a note or comment of yours. It answers the
`chat` interface (docs/chat.md) for dither-chat's Feed page (dither-chat's docs/feed.md).

Substack has no public API. The kind runs substack.com signed in in a sandboxed browser (packages/browser: Xvfb,
Chromium with our extension, x11vnc for the live view, as for X, Google and Proton), and every read and write is a
call Substack's own reader makes, from inside its page with its session, built the way the reader builds it.

## Adding it, and what you do

On the accounts page, **Add → Substack** (no fields). Its extractor starts a sandbox and the account says **Sign in to
Substack in the live view**. Open the live view and sign in as on your desktop: the emailed link or code, or your
password, and any check Substack shows (those are yours; nothing here answers them). The browser opens on
substack.com/settings, a page that shows no feed; it goes online once the reader says you are signed in.

Leave it on Settings. The reader's own pages mark what they show: opening the Inbox marks it seen
(`POST /api/v1/inbox/seen`), the Activity page clears the bell (`POST /api/v1/activity/unread`), Notes report the notes
that scrolled past. The extractor never calls those, but a page you open in the live view will.

## What substack.com is (read from its bundles as of November 2026, signed out)

Signed in or not, substack.com is the reader, "reader2": webpack 5 (the runtime is `reactReader2.<hash>.js` on
`substackcdn.com/bundle/static/js/`, its lazy chunks under `static/js/async/<name>.<hash>.js`), React, a Redux-like
store per page. Everything it shows comes from JSON calls under `/api/v1` on substack.com, made with the session
cookie by one fetch helper: `fetch(url, { cache: 'no-cache', method, body: JSON.stringify(json), headers:
{ 'Content-Type': 'application/json' } })`, the query built from an object (undefined left out, arrays as `key[]`).
A few older parts use superagent (XHR) for the same calls. `window._preloads` (from `<script id="preloads-json">`)
carries the page's state, and `user` (id, name, handle, photo_url) when you are signed in.

### The calls this kind makes

| what | call | read from |
|---|---|---|
| Activity (the bell's list) | `GET /api/v1/activity-feed-web?filter=all[&after=<ISO>]`; `after` is the oldest `updated_at` shown, less 1 ms | `reader2-ActivityRoute` / the activity list module: `pathname:"/api/v1/activity-feed-web"`, `getPageInit` with `after` |
| Inbox | `GET /api/v1/reader/posts?inboxType=inbox&limit=20[&cursor=]` → `{ posts, publications, inboxItems, cursor, more }` | the Inbox route (`pathname: …"/api/v1/reader/posts"`, `query:{inboxType, surface, limit:20}`, next page by `result.cursor`) |
| Notes, For you | `GET /api/v1/reader/feed?tab=for-you[&cursor=]` → `{ items, nextCursor }` | Home's feed hook (`pathname:"home"===a?"/api/v1/reader/feed":…`, `query:{userId, tab, type,…}`); the tab ids `ForYou="for-you"` |
| a note's page | `GET /api/v1/reader/comment/<id>` → `{ item: { comment, parentComments, post, publication } }` | the note page (`(0,ex.x6)(\`/api/v1/reader/comment/${e}\`)` → `item_load`) |
| a note's replies | `GET /api/v1/reader/comment/<id>/replies?comment_id=<id>[&cursor=]` → `{ commentBranches, nextCursor }` | the replies list (`pathname: r ? \`/api/v1/reader/comment/${r}/replies\` : \`/api/v1/reader/post/${id}/replies\``) |
| a post's page | `GET /api/v1/posts/by-id/<id>` → `{ post, publication }`, the post with its whole `body_html` | the post viewer (`/api/v1/posts/by-id/${e}`) |
| a post's comments | `GET /api/v1/reader/post/<id>/replies?publication_id=<pub>[&cursor=]` | the same replies list, with `publication_id` |
| a profile | `GET /api/v1/user/<handle>/public_profile` | profile pages and hover cards |
| a profile's feed | `GET /api/v1/reader/feed/profile/<user id>[&cursor=]` → `{ items, nextCursor }` | the profile's Activity tab |
| the heart | `POST /api/v1/post/<id>/reaction {reaction:"❤"}`, `DELETE` with `{}`; on a note or comment `/api/v1/comment/<id>/reaction` with `publication_id` too (null for a note) | the like button: `` `/api/v1/${t?"comment":"post"}/${e.id}/reaction` ``, `a=t?{publication_id:e.publication_id}:{}`, `.post(s).send({reaction:"❤",...a})` / `.delete(s).send(a)` |
| Restack | `POST /api/v1/restack/feed {postId, commentId, tabId, surface}`; undo `DELETE` with `{postId, commentId, tabId}` | the restack hook: `G.refetch({method:"POST",json:{postId:m?null:r?.id,commentId:m?.id||null,…,tabId:y,surface:A}})` |
| a note, or a reply to a note | `POST /api/v1/comment/feed {bodyJson, parent_id?, tabId, surface, replyMinimumRole}` | `note_composer-NoteComposer`: `create` → `pathname:a?\`/api/v1/post/${a}/comment\`:"/api/v1/comment/feed"` |
| a comment on a post, or a reply under one | `POST /api/v1/post/<id>/comment {bodyJson, parent_id?, publication_id}` | the same `create`, with `parentPostId` |
| delete a note or comment | `DELETE /api/v1/comment/<id> {publication_id}` | the item menu's Delete (`method:"DELETE",json:{publication_id:i}`) |
| a picture | `GET` on substackcdn.com or substack-post-media.s3.amazonaws.com, without cookies, as an `<img>` loads it | |

`bodyJson` is the composer's ProseMirror document: `{ type: 'doc', attrs: { schemaVersion: 'v1', title: null },
content: [{ type: 'paragraph', content: [{ type: 'text', text }] }, …] }`, a paragraph per typed line. Pictures on a
note (`attachmentIds` from `POST /api/v1/comment/attachment`) are not sent from here yet.

Not verified on a signed-in account yet: the `tabId` and `surface` the composer and Restack send from the For you tab
(`for-you`, `feed` here; they look like tracking hints), `replyMinimumRole: 'everyone'` on a new note, the exact shape
of the composer's answer (a comment, bare or under `comment`; both are read), and whether a signed-in comment carries
`reaction` (your heart) as posts do. The first live trial should check these against the reader's own requests.

### Never called

What marks something seen or read: `POST /api/v1/inbox/seen`, `POST /api/v1/activity/unread` (`{after: now}` clears
the bell), `POST /api/v1/reader/feed/<key>/seen`, `/api/v1/posts/<id>/seen` and `/progress`, and the analytics
endpoints (`/api/v1/firehose`).

## The shapes it reads

- **Posts**: `id`, `publication_id`, `title`, `subtitle`, `description`, `truncated_body_text`, `canonical_url`,
  `post_date`, `audience` (`everyone`, `only_paid`, `founding`), `cover_image`, `reaction_count`, `reaction` (`❤` when
  you liked it), `comment_count`, `restacks`, `restacked`, `publishedBylines[]` (id, name, handle, photo_url).
- **Notes and comments** are one kind of thing to Substack (one table, one id space): `id`, `body`, `body_json`,
  `user_id`, `name`, `handle`, `photo_url`, `post_id` (none on a note), `publication_id`, `date`, `ancestor_path`
  (`"1.2.3"`, the thread's first first), `reaction_count`, `restacks`, `restacked`, `children_count`,
  `attachments[]` (`image` with `imageUrl`; `post` with the post and publication it quotes; `comment`).
- **Feed items** (Notes, a profile's feed): `{ entity_key, type: 'comment' | 'post' | …, comment, post, publication,
  parentComments[], context: { type: 'note' | 'comment_restack' | 'post_restack' | 'comment_like' | 'note_reply' |
  'post_comment' | …, users[], timestamp } }`, with `trackingParameters` the hook drops. Other item types (user
  suggestions, publication recommendations) are left out and counted.
- **Comment branches**: `{ commentBranches: [{ comment, descendantComments: [{ type: 'comment', comment }] }],
  moreBranches, nextCursor }`.
- **Activity**: `{ activityItems: [{ type, item_key, updated_at, recent_sender_ids[], publication_id, target_post_id,
  comment_id, target_comment_id, target_user_id, mention_id }], pubs, posts, drafts, users, comments, mentions,
  feedItemComments, more }`. One item gathers several people (`recent_sender_ids`); `updated_at` moves with the newest.

## How it maps

Ids are Substack's own entity keys: **`p-<id>`** for a newsletter post and **`c-<id>`** for a note or comment, so a
post and a note never share one. A person is their user id; Substack's own notices are from `substack`.

- A **post** is a PostFact with `title`, the subtitle and preview as `text`, its publication as `place` (id, name, its
  `<sub>.substack.com` or custom domain), the cover as `media`, counts (likes = hearts, replies = comments, reposts =
  restacks), `viewer` (liked, restacked), and `warning` **Paid subscribers only** (or Founding members only) when its
  audience is not everyone, with the free preview as the words. Its author is its first byline, else the
  publication's author.
- A post's **whole body** comes only with its page, so only a post's thread has it: `body_html` as Markdown in
  `article` (chat-protocol's `htmlToMarkdown`: headings, emphasis, links, pictures with their captions, quotes, lists,
  code, tables; an embedded video as a link). The reader's furniture inside it goes: subscribe boxes, buttons, a
  heading's anchor, a picture's expand button. The hook drops `body_html` from every other answer (the Inbox brings
  it too), so a card carries the subtitle and preview only. A paid post you don't pay for has only its free part.
- A **note** is a PostFact without a title; a **comment** is one with `replyTo` (the comment above it, or the post) and
  `root` (the thread's first); a note restacking a post with words has it as `quoteOf`.
- **home**: `following` is the Inbox (newest first), `foryou` is Notes' For you; a restack or a like in a note's
  context line is its `reason`, the notes above a reply its `above`. Cursors are Substack's, passed through.
- **post**: a post's page (with the whole post as `article`, below) and its comments, or a note's page (the post it is on first, then the comments above it)
  and its replies, each branch a reply chain. `cursor` asks for more.
- **profile**: name, handle, bio, followers, whether you follow them and they you, what they write and its link, and
  their own notes and posts from their profile's feed (restacks of others left out).
- **Activity** messages go to the conversation `feed` (variant `feed`, read-only), one per person, as FeedItems:
  `post_like`, `note_like`, `comment_like` → like (`like:<post or note>:<user>`); `restack`, `naked_restack_reaction`
  → repost; `post_reply`, `note_reply`, `comment_reply` → reply (`reply:<their comment>`, with what it answers);
  `comment_mention`, `post_mention` → mention; `restack_quote` → quote; `follow` → follow (`follow:<user>`); new free,
  paid, pledged, referred or recommended subscriptions → follow ("subscribed to ACME Notes",
  `follow:<user>:<type>:<pub>`); anything else in a sentence of its own → other. Lives, chats, polls and milestones
  are left out and counted. The first read of a fresh account goes back a week (two pages) and notifies nothing; later
  reads look at the newest page every 4-8 minutes and page back while a whole page is new.

## Pace and what it never does

Reads wait 1.5-4 s after the one before; writes 1.2-2 s, one at a time. The Activity list is the only read on a
timer; everything else happens only when the Feed page asks. A read the page has not said it has after 3 s is sent
again (packages/browser's bridge); a write never is. It never marks anything seen, never subscribes or follows, and
never makes a call outside the table above: the hook holds the list, and checks every id and cursor it is given.

## Status

Layers: display, browser, extension, signed in (`as @handle`), activity (items announced, last read; a failed read is
this layer's only). Signed out it asks for a sign-in (attention `login`, with the live view). The details list the
page's state, the hook's version, counts and the last command. Its state file, `substack-state.json`, keeps the newest
Activity time and the ids announced lately: no words or names.

## Tests

`extractors/substack/test/map.test.ts` maps invented answers (`test/fixtures.ts`). `test/substack-browser.test.ts`
runs the kind end to end, a real manager, Chromium and the extension against `test/fake-substack.ts` (a reader page
with its preloads and the calls above), and checks each request's method, path, query and body against the reader's,
that the page's session went with them, that nothing called a "seen" endpoint, and the sign-in flow. It skips where
Xvfb, Chromium or x11vnc are missing.
