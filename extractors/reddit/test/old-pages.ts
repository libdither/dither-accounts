/**
 * Old reddit's pages, drawn from the same invented data as its `.json` (fixtures.ts), the way old.reddit.com draws
 * them: a listing's `#siteTable` of `.thing.link` rows with their facts in data- attributes and a "next" link, and a
 * comments page's post with its text and `.commentarea` of nested `.thing.comment`s, "load more comments" and
 * "continue this thread". The fake serves them when a test has Reddit refuse the `.json`.
 */
type Thing = { kind: string; data: Record<string, any> };
type Listing = { kind: 'Listing'; data: { children: Thing[]; after: string | null } };

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
/** Markdown as old reddit renders it, enough for the fixtures: paragraphs, **bold**, [links](…). */
const md = (text: string) =>
  `<div class="md">${text
    .split(/\n{2,}/)
    .filter(Boolean)
    .map(
      (p) =>
        `<p>${esc(p)
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')}</p>`,
    )
    .join('\n')}</div>`;
const iso = (s: number) => new Date(s * 1000).toISOString().replace('.000Z', '+00:00');
const vote = (likes: unknown) => (likes === true ? 'likes' : likes === false ? 'dislikes' : 'unvoted');
/** The score without your vote: old reddit draws it three ways (down, none, up) and shows the one that is yours. */
const base = (d: Record<string, any>) => d.score - (d.likes === true ? 1 : d.likes === false ? -1 : 0);

function linkRow(d: Record<string, any>, i: number, withText: boolean): string {
  const self = d.is_self === true;
  const url = self ? d.permalink : (d.url_overridden_by_dest ?? d.url);
  const domain = self ? `self.${d.subreddit}` : new URL(url).hostname;
  const pic = d.preview?.images?.[0]?.source?.url as string | undefined;
  const v = vote(d.likes);
  const cls = ['thing', `id-${d.name}`, i % 2 ? 'even' : 'odd', 'link', self ? 'self' : '', d.over_18 ? 'over18' : '', d.spoiler ? 'spoiler' : '', d.stickied ? 'stickied' : '']
    .filter(Boolean)
    .join(' ');
  return `<div class=" ${cls} " id="thing_${d.name}" onclick="click_thing(this)" data-fullname="${d.name}" data-type="link" data-gildings="0" data-whitelist-status="all_ads" data-is-gallery="${!!d.is_gallery}" data-author="${esc(d.author)}" data-author-fullname="${esc(d.author_fullname)}" data-subreddit="${esc(d.subreddit)}" data-subreddit-prefixed="r/${esc(d.subreddit)}" data-subreddit-fullname="${esc(d.subreddit_id)}" data-subreddit-type="public" data-timestamp="${Math.round(d.created_utc * 1000)}" data-url="${esc(url)}" data-permalink="${esc(d.permalink)}" data-domain="${esc(domain)}" data-rank="${i + 1}" data-comments-count="${d.num_comments}" data-score="${d.score}" data-promoted="${!!d.promoted}" data-nsfw="${!!d.over_18}" data-spoiler="${!!d.spoiler}" data-oc="false" data-num-crossposts="0" data-context="listing">
  <p class="parent"></p><span class="rank">${i + 1}</span>
  <div class="midcol ${v}"><div class="arrow up" role="button" aria-label="upvote" tabindex="0"></div><div class="score dislikes" title="${base(d) - 1}">${base(d) - 1}</div><div class="score unvoted" title="${base(d)}">${base(d)}</div><div class="score likes" title="${base(d) + 1}">${base(d) + 1}</div><div class="arrow down" role="button" aria-label="downvote" tabindex="0"></div></div>
  ${pic ? `<a class="thumbnail invisible-when-pinned may-blank outbound" href="${esc(url)}"><img src="${esc(pic)}" width="70" height="52" alt=""></a>` : self ? '<a class="thumbnail invisible-when-pinned self may-blank" href="' + esc(d.permalink) + '"></a>' : ''}
  <div class="entry ${v}"><div class="top-matter"><p class="title"><a class="title may-blank" data-event-action="title" href="${esc(url)}" tabindex="1">${esc(d.title)}</a> <span class="domain">(<a href="/domain/${esc(domain)}/">${esc(domain)}</a>)</span></p>
  <p class="tagline">submitted <time title="${new Date(d.created_utc * 1000).toUTCString()}" datetime="${iso(d.created_utc)}" class="live-timestamp">a while ago</time> by <a href="https://old.reddit.com/user/${esc(d.author)}" class="author may-blank id-t2_abc">${esc(d.author)}</a><span class="userattrs"></span> to <a href="https://old.reddit.com/r/${esc(d.subreddit)}/" class="subreddit hover may-blank">r/${esc(d.subreddit)}</a></p>
  <ul class="flat-list buttons"><li class="first"><a href="${esc(d.permalink)}" data-event-action="comments" class="bylink comments may-blank" rel="nofollow">${d.num_comments} comments</a></li><li class="share"><a class="post-sharing-button" href="javascript: void 0;">share</a></li></ul></div>
  ${withText && self && d.selftext ? `<div class="expando"><form action="#" class="usertext warn-on-unload" onsubmit="return post_form(this, 'editusertext')" id="form-${d.name}"><input type="hidden" name="thing_id" value="${d.name}"><div class="usertext-body may-blank-within md-container ">${md(d.selftext)}</div></form></div>` : '<div class="expando expando-uninitialized" style="display: none"><span class="error">loading...</span></div>'}
  </div><div class="child"></div><div class="clearleft"></div></div><div class="clearleft"></div>`;
}

function commentThing(t: Thing, link: string): string {
  const d = t.data;
  if (t.kind === 'more') {
    if (d.id === '_') return `<div class=" thing noncollapsed morerecursion " data-type="morerecursion"><div class="entry unvoted"><span class="deepthread"><a href="/r/x/comments/${link.slice(3)}/a_title/${String(d.parent_id).slice(3)}/" data-event-action="permalink">continue this thread</a></span></div></div><div class="clearleft"></div>`;
    return `<div class=" thing id-t1_${d.id} morechildren " id="thing_t1_${d.id}" data-type="morechildren"><div class="entry unvoted"><span class="morecomments"><a style="font-size: smaller; font-weight: bold" class="button" id="more_t1_${d.id}" href="javascript:void(0)" onclick="return morechildren(this, '${link}', 'confidence', '${d.children.join(',')}', 'False')">load more comments</a><span class="gray">&nbsp;(${d.count} ${d.count === 1 ? 'reply' : 'replies'})</span></span></div></div><div class="clearleft"></div>`;
  }
  const v = vote(d.likes);
  const kids = d.replies && d.replies.data ? (d.replies.data.children as Thing[]) : [];
  return `<div class=" thing id-${d.name} noncollapsed   comment ${d.stickied ? 'stickied' : ''}" id="thing_${d.name}" onclick="click_thing(this)" data-fullname="${d.name}" data-type="comment" data-gildings="0" data-subreddit="${esc(d.subreddit)}" data-subreddit-prefixed="r/${esc(d.subreddit)}" data-subreddit-fullname="${esc(d.subreddit_id)}" data-subreddit-type="public" data-author="${esc(d.author)}" data-author-fullname="t2_abc" data-replies="${kids.length}" data-permalink="${esc(d.permalink)}">
  <p class="parent"><a name="${d.id}"></a></p>
  <div class="midcol ${v}"><div class="arrow up" role="button" aria-label="upvote" tabindex="0"></div><div class="arrow down" role="button" aria-label="downvote" tabindex="0"></div></div>
  <div class="entry ${v}"><p class="tagline"><a href="javascript:void(0)" class="expand" onclick="return togglecomment(this)">[–]</a><a href="https://old.reddit.com/user/${esc(d.author)}" class="author may-blank id-t2_abc">${esc(d.author)}</a><span class="userattrs"></span> <span class="score dislikes" title="${base(d) - 1}">${base(d) - 1} points</span><span class="score unvoted" title="${base(d)}">${base(d)} points</span><span class="score likes" title="${base(d) + 1}">${base(d) + 1} points</span> <time title="${new Date(d.created_utc * 1000).toUTCString()}" datetime="${iso(d.created_utc)}" class="live-timestamp">a while ago</time>&#32;<a href="javascript:void(0)" class="numchildren" onclick="return togglecomment(this)">(${kids.length} children)</a></p>
  <form action="#" class="usertext warn-on-unload" onsubmit="return post_form(this, 'editusertext')" id="form-${d.name}"><input type="hidden" name="thing_id" value="${d.name}"><div class="usertext-body may-blank-within md-container ">${md(d.body)}</div></form>
  <ul class="flat-list buttons"><li class="first"><a href="${esc(d.permalink)}" data-event-action="permalink" class="bylink" rel="nofollow">permalink</a></li><li><a class="reply-button" href="javascript: void 0;">reply</a></li></ul></div>
  <div class="child">${kids.length ? `<div id="siteTable_${d.name}" class="sitetable listing">${kids.map((k) => commentThing(k, link)).join('\n')}</div>` : ''}</div><div class="clearleft"></div></div><div class="clearleft"></div>`;
}

const shell = (body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>reddit: the front page of the internet</title><script>var r = { config: {} };</script></head><body class="listing-page">
<div id="header"><div id="header-bottom-left"><a href="/" id="header-img" class="default-header">reddit.com</a><ul class="tabmenu"><li><a href="/best/" class="choice">best</a></li><li class="selected"><a href="/new/" class="choice">new</a></li></ul></div></div>
<div class="side"><div class="spacer"><form action="/search" id="search" role="search"><input type="text" name="q" placeholder="search"></form></div></div>
<a name="content"></a><div class="content" role="main">${body}</div>
<div class="footer-parent"><div class="footer rounded">a footer</div></div></body></html>`;

/** A front page (`/new/`, `/best/`): its rows, and a "next" link (`nextHref`) when there is more. */
export function oldListingPage(l: Listing, nextHref: string | null): string {
  const rows = l.data.children.map((c, i) => linkRow(c.data, i, false)).join('\n');
  const nav = nextHref ? `<div class="nav-buttons"><span class="nextprev">view more:&#32;<span class="next-button"><a href="${esc(nextHref)}" rel="nofollow next">next &rsaquo;</a></span></span></div>` : '';
  return shell(`<div class="spacer"><div id="siteTable" class="sitetable linklisting">${rows}${nav}</div></div>`);
}

/** A comments page: the post (with its text) and its comments, as `/comments/<id>/` draws `[post, comments]`. */
export function oldCommentsPage([post, comments]: [Listing, Listing]): string {
  const p = post.data.children[0]!.data;
  return shell(
    `<div class="sitetable linklisting" id="siteTable_${p.name}">${linkRow(p, 0, true)}</div>
<div class="commentarea"><div class="panestack-title"><span class="title">all ${p.num_comments} comments</span></div>
<div class="usertext cloneable"><textarea name="text"></textarea></div>
<div id="siteTable_${p.name}" class="sitetable nestedlisting">${comments.data.children.map((c) => commentThing(c, p.name)).join('\n')}</div></div>`,
  );
}
