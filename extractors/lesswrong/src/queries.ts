/**
 * The GraphQL operations the lesswrong extractor sends, each named, with the fields it reads (docs/lesswrong.md "What
 * it asks the site"). Shapes are ForumMagnum's (github.com/ForumMagnum/ForumMagnum): its resolvers in
 * packages/lesswrong/server, its views in packages/lesswrong/lib/collections/<collection>/views.ts.
 *
 * Nothing here marks anything read or records a view: no MarkAllNotificationsAsRead, markAsReadOrUnread,
 * markPostCommentsRead, increasePostViewCount, analyticsEvent, createLWEvent, updateContinueReading,
 * createUltraFeedEvent, updateUltraFeedEvent, karmaChangesChecked or updateUser (which sets lastNotificationsCheck),
 * and no UltraFeedSubscriptions, which records each item it serves. UltraFeed is asked in incognito mode, so it records
 * nothing either.
 */

const USER = `fragment LwUser on User { _id displayName slug deleted }`;

const POST_BASE = `_id title slug pageUrl postedAt baseScore commentCount question url isEvent shortform draft currentUserVote currentUserExtendedVote user { ...LwUser }`;
/** A post as a card shows it: the start of its body only (htmlHighlight). */
const POST_CARD = `fragment LwPostCard on Post { ${POST_BASE} contents { htmlHighlight } }`;
/** A post as its thread shows it: the whole body. */
const POST_FULL = `fragment LwPostFull on Post { ${POST_BASE} contents { html } }`;
const COMMENT = `fragment LwComment on Comment {
  _id postId parentCommentId topLevelCommentId postedAt baseScore descendentCount directChildrenCount deleted shortform
  answer retracted pageUrl currentUserVote currentUserExtendedVote userId user { ...LwUser } contents { html }
  post { _id title slug pageUrl shortform userId }
}`;

const doc = (body: string, ...fragments: string[]) => [body, ...new Set([...fragments, USER])].join('\n');

export const LOGIN = `mutation Login($username: String, $password: String) { login(username: $username, password: $password) { token } }`;

export const ME = doc(`query Me { currentUser { ...LwUser ultraFeedSettings } }`);

/** A page of your notifications, newest first; `currentUser` with it says whether the token is still taken. */
export const NOTIFICATIONS = `query Notifications($userId: String, $limit: Int, $offset: Int) {
  currentUser { _id }
  notifications(selector: { userNotifications: { userId: $userId } }, limit: $limit, offset: $offset, enableTotal: false) {
    results { _id documentId documentType createdAt link message type deleted }
  }
}`;

/** The posts and comments some notifications are about, in one request. */
export const DOCS = doc(
  `query Docs($postIds: [String!], $commentIds: [String!], $postLimit: Int, $commentLimit: Int) {
  posts(selector: { default: { exactPostIds: $postIds } }, limit: $postLimit) { results { ...LwPostCard } }
  comments(selector: { default: { commentIds: $commentIds } }, limit: $commentLimit) { results { ...LwComment } }
}`,
  POST_CARD,
  COMMENT,
);

/** Posts by the people you are subscribed to (their new posts), newest first, the last 90 days: a limit, no offset. */
export const SUBSCRIBED = doc(`query Subscribed($limit: Int) { PostsBySubscribedAuthors(limit: $limit) { results { ...LwPostCard } } }`, POST_CARD);

/** The frontpage's feed (the site's "For you"), asked in incognito mode: `settings` is a JSON string, as the site sends it. */
export const ULTRAFEED = doc(
  `query UltraFeed($limit: Int, $offset: Int, $sessionId: String, $settings: JSON) {
  UltraFeed(limit: $limit, offset: $offset, sessionId: $sessionId, settings: $settings) {
    endOffset
    results {
      type
      feedPost { _id post { ...LwPostCard } }
      feedCommentThread { _id post { ...LwPostCard } comments { ...LwComment } }
      feedSpotlight { _id post { ...LwPostCard } }
    }
  }
}`,
  POST_CARD,
  COMMENT,
);

/** A post with its whole body, and a page of its comments (top first); the post is left out on later pages. */
export const POST = doc(
  `query Post($postId: String, $withPost: Boolean!, $limit: Int, $offset: Int) {
  post(selector: { _id: $postId }) @include(if: $withPost) { result { ...LwPostFull } }
  comments(selector: { postCommentsTop: { postId: $postId } }, limit: $limit, offset: $offset) { results { ...LwComment } }
}`,
  POST_FULL,
  COMMENT,
);

export const COMMENT_ONE = doc(`query Comment($commentId: String) { comment(selector: { _id: $commentId }) { result { ...LwComment } } }`, COMMENT);

/** A comment thread whole: its top-level comment and every comment under it. */
export const COMMENT_THREAD = doc(
  `query CommentThread($topLevelCommentId: String!, $limit: Int) {
  comments(selector: { repliesToCommentThreadIncludingRoot: { topLevelCommentId: $topLevelCommentId } }, limit: $limit) { results { ...LwComment } }
}`,
  COMMENT,
);

/** Your vote on a post or a comment as it is now, to keep its agreement and reactions when the karma vote changes. */
export const POST_VOTE = `query PostVote($id: String) { post(selector: { _id: $id }) { result { _id currentUserVote currentUserExtendedVote } } }`;
export const COMMENT_VOTE = `query CommentVote($id: String) { comment(selector: { _id: $id }) { result { _id currentUserVote currentUserExtendedVote } } }`;

export const VOTE_POST = `mutation VotePost($documentId: String, $voteType: String, $extendedVote: JSON) {
  performVotePost(documentId: $documentId, voteType: $voteType, extendedVote: $extendedVote) { document { _id baseScore currentUserVote } }
}`;
export const VOTE_COMMENT = `mutation VoteComment($documentId: String, $voteType: String, $extendedVote: JSON) {
  performVoteComment(documentId: $documentId, voteType: $voteType, extendedVote: $extendedVote) { document { _id baseScore currentUserVote } }
}`;

export const NEW_COMMENT = doc(`mutation NewComment($data: CreateCommentDataInput!) { createComment(data: $data) { data { ...LwComment } } }`, COMMENT);

/** What the site's own Delete does for your comment without replies (DeleteCommentDialog: not public, no reason). */
export const DELETE_COMMENT = `mutation DeleteComment($commentId: String) {
  moderateComment(commentId: $commentId, deleted: true, deletedPublic: false, deletedReason: "") { _id deleted }
}`;

export const USER_BY_SLUG = `query UserBySlug($slug: String!) { GetUserBySlug(slug: $slug) { _id } }`;

/** A person's profile, their newest posts and their newest comments. */
export const PROFILE = doc(
  `query Profile($userId: String, $limit: Int) {
  user(selector: { _id: $userId }) { result { ...LwUser createdAt karma postCount commentCount htmlBio } }
  posts(selector: { userPosts: { userId: $userId, sortedBy: "new" } }, limit: $limit) { results { ...LwPostCard } }
  comments(selector: { profileComments: { userId: $userId, sortBy: "new" } }, limit: $limit) { results { ...LwComment } }
}`,
  POST_CARD,
  COMMENT,
);

/** Every operation this extractor may send, by name: the fake server checks against it, and so does the doc. */
export const OPERATIONS = ['Login', 'Me', 'Notifications', 'Docs', 'Subscribed', 'UltraFeed', 'Post', 'Comment', 'CommentThread', 'PostVote', 'CommentVote', 'VotePost', 'VoteComment', 'NewComment', 'DeleteComment', 'UserBySlug', 'Profile'] as const;
