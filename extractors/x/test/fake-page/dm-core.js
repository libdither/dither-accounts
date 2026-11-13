/*
 * A stand-in for X's Kotlin/JS chat core (@x-clients/dm-core), shaped like the real one as read from x.com's public
 * bundle (docs/x.md): classes carry Kotlin's $metadata$ with their simple names, exported properties are getters on
 * prototypes, data classes keep readable field names next to mangled ones (`a1b_1`), Longs are BigInts, state is an
 * ExportedStateFlow ({ state, subscribe(cb) -> { cancel } }), lists are Kotlin lists (asJsReadonlyArrayView), and the
 * sealed event classes carry their subclasses as statics (DmEvent.ScrolledToTop, ChatComposerEvent.UserChangedText,
 * ConversationListEvent.RowClicked). Its exports have mangled names, as Rolldown's.
 *
 * It talks to the fake server as the real core talks to X: /__fake/api/* for its own reads and writes and an
 * EventSource for what arrives (the real one has a WebSocket). Served as its own module (dm-core-<hash>.js), which
 * the embed imports at run time.
 */
const API = '/__fake/api';

// ------------------------------------------------------------------ Kotlin-ish
function F(ctor, simpleName, parent, kind) {
  if (parent) {
    ctor.prototype = Object.create(parent.prototype);
    ctor.prototype.constructor = ctor;
  }
  ctor.$metadata$ = { kind: kind || 'class', simpleName, associatedObjectKey: undefined, suspendArity: undefined, defaultConstructor: undefined };
}
const D = (o, name, get) => Object.defineProperty(o, name, { configurable: true, get, enumerable: false });
const M = (c) => c.prototype;

function KtListImpl(a) {
  this.a1k_1 = Array.from(a);
}
F(KtListImpl, 'ArrayList');
M(KtListImpl).asJsReadonlyArrayView = function () {
  return Object.freeze(this.a1k_1.slice());
};
M(KtListImpl).r = function () {
  return this.a1k_1.length === 0;
};
function KtList() {}
F(KtList, 'List', null, 'interface');
KtList.fromJsArray = (a) => new KtListImpl(a);
const list = (a) => new KtListImpl(a || []);

function KtMapImpl(m) {
  this.b1k_1 = new Map(m);
}
F(KtMapImpl, 'LinkedHashMap');
M(KtMapImpl).asJsReadonlyMapView = function () {
  return new Map(this.b1k_1);
};

function ExportedStateFlow(v) {
  this.c1k_1 = v;
  this.d1k_1 = new Set();
}
F(ExportedStateFlow, 'ExportedStateFlow');
D(M(ExportedStateFlow), 'state', function () {
  return this.c1k_1;
});
M(ExportedStateFlow).subscribe = function (cb) {
  this.d1k_1.add(cb);
  const self = this;
  queueMicrotask(() => self.d1k_1.has(cb) && cb(self.c1k_1));
  return {
    cancel() {
      self.d1k_1.delete(cb);
    },
  };
};
M(ExportedStateFlow).e1k = function (v) {
  this.c1k_1 = v;
  for (const cb of [...this.d1k_1]) {
    try {
      cb(v);
    } catch (e) {}
  }
};

function Enum(name, ordinal) {
  this.name = name;
  this.ordinal = ordinal;
}
function makeEnum(simpleName, names) {
  function E(n, o) {
    Enum.call(this, n, o);
  }
  F(E, simpleName, Enum);
  for (const [i, n] of names.entries()) E[n] = new E(n, i);
  return E;
}
F(Enum, 'Enum');
const RightButton = makeEnum('RightButton', ['SendActive', 'SendInactive', 'VoiceNote']);
const MediaType = makeEnum('MediaType', ['Image', 'Video', 'Audio', 'File']);
const HiddenState = makeEnum('HiddenState', ['Deleted', 'Expired']);
const TrustState = makeEnum('TrustState', ['Trusted', 'RequestSent', 'RequestReceived']);
const CannotMessageReason = makeEnum('CannotMessageReason', ['NotFollowing', 'Blocked', 'NoPublicKey']);

// ------------------------------------------------------------------ ids, people, time
function UserId(s) {
  this.f1k_1 = s;
}
F(UserId, 'UserId');
D(M(UserId), 'userIdString', function () {
  return this.f1k_1;
});

function ConversationId() {}
F(ConversationId, 'XConversationId');
function OneOnOne(id) {
  this.id = id;
}
F(OneOnOne, 'OneOnOne', ConversationId);
function Group(id) {
  this.id = id;
}
F(Group, 'Group', ConversationId);
ConversationId.OneOnOne = OneOnOne;
ConversationId.Group = Group;
const convIdOf = (c) => (c.group ? new Group(c.id) : new OneOnOne(c.id));
function ConversationIdCompanion() {}
F(ConversationIdCompanion, 'Companion', null, 'object');
M(ConversationIdCompanion).fromStringRequired = function (s) {
  if (typeof s !== 'string' || !s) throw new Error('Invalid convId ' + s);
  return /^g/.test(s) ? new Group(s) : new OneOnOne(s);
};
D(ConversationId, 'Companion', () => (ConversationIdCompanion.i ||= new ConversationIdCompanion()));
/** A one-to-one XChat conversation's id: the two user ids, the lower first (XConversationId.Companion's rule). */
const oneOnOneId = (a, b) => (BigInt(a) <= BigInt(b) ? `${a}:${b}` : `${b}:${a}`);

function User(u) {
  this.userId = new UserId(u.id);
  this.screenName = u.screenName;
  this.displayName = u.displayName;
  this.avatarUrl = u.avatarUrl || null;
  this.g1k_1 = 0;
}
F(User, 'User');

function Instant(ms) {
  this.h1k_1 = BigInt(Math.floor(ms / 1000));
  this.i1k_1 = (ms % 1000) * 1e6;
}
F(Instant, 'Instant');
D(M(Instant), 'epochSeconds', function () {
  return this.h1k_1;
});
D(M(Instant), 'nanosecondsOfSecond', function () {
  return this.i1k_1;
});

// ------------------------------------------------------------------ the inbox
function ConversationAttributes(c) {
  this.customTitle = c.title || null;
  this.customDescription = c.description || null;
  this.customAvatarUrl = c.avatarUrl || null;
  this.defaultTtl = null;
  this.muted = !!c.muted;
  this.archived = false;
  this.adminOnlyAddMembers = !!c.adminOnlyAddMembers;
  this.adminOnlyEditGroupInfo = !!c.adminOnlyEditGroupInfo;
  this.adminOnlySendMessages = false;
  this.groupType = null;
}
F(ConversationAttributes, 'ConversationAttributes');
function TitleState(users) {
  this.users = list(users);
}
F(TitleState, 'TitleState');
function Participant(c, id) {
  this.conversationId = convIdOf(c);
  this.userId = new UserId(id);
  this.isAdmin = (c.admins || []).includes(id);
  this.isCurrentMember = true;
  this.lastSeenSequenceNumber = null;
}
F(Participant, 'Participant');
function ConversationMetadata(c, users, self) {
  this.conversationId = convIdOf(c);
  this.attributes = new ConversationAttributes(c);
  this.titleState = new TitleState(users);
  this.shortTitle = null;
  this.hasAttributes = true;
  this.t2k_1 = (c.members || []).map((m) => new Participant(c, m));
  this.u2k_1 = self;
}
F(ConversationMetadata, 'ConversationMetadata');
// As Kotlin's: computed getters on the prototype, over the participants it holds.
D(M(ConversationMetadata), 'sortedParticipants', function () {
  return list(this.t2k_1);
});
D(M(ConversationMetadata), 'currentParticipants', function () {
  return list(this.t2k_1.filter((p) => p.isCurrentMember));
});
D(M(ConversationMetadata), 'selfParticipantIfCurrentMember', function () {
  return this.t2k_1.find((p) => p.userId.userIdString === this.u2k_1) || null;
});
function LatestMessagePreview(m) {
  this.messageText = m ? m.text : '';
  this.sequenceNumber = m ? BigInt(m.seq) : 0n;
  this.isSent = !!m;
}
F(LatestMessagePreview, 'LatestMessagePreview');
function ConversationPreview(c, last) {
  this.conversationId = convIdOf(c);
  this.latestMessagePreview = new LatestMessagePreview(last);
  this.timestamp = new Instant(last ? last.ts : c.created);
  this.lastReadSequenceNumber = BigInt(c.readSeq || 0);
}
F(ConversationPreview, 'ConversationPreview');
/** As the real one: the row's metadata wraps the conversation's (ConversationMetadataWithKeyData.metadata). */
function ConversationMetadataWithKeyData(c, users, self) {
  this.metadata = new ConversationMetadata(c, users, self);
  this.isLegacy = !!c.legacy;
  this.isReadOnly = false;
  this.v2k_2 = true;
}
F(ConversationMetadataWithKeyData, 'ConversationMetadataWithKeyData');
function ConversationPreviewWithMetadata(c, last, users, unread, self) {
  this.preview = new ConversationPreview(c, last);
  this.metadata = new ConversationMetadataWithKeyData(c, users, self);
  this.accessibilityDescription = '';
  this.isUnreadByMe = unread > 0;
  this.unreadCount = unread;
  this.socialProof = null;
  this.actions = list([]);
  this.conversationId = convIdOf(c);
  this.isLegacy = !!c.legacy;
  this.j1k_1 = 1;
}
F(ConversationPreviewWithMetadata, 'ConversationPreviewWithMetadata');
function ConversationListState(o) {
  this.previews = list(o.previews);
  this.previewItems = list(o.previews.map((p) => new ConversationPreviewItemConversation(p)).concat(o.requests ? [new ConversationPreviewItemMessageRequests(o.requests)] : []));
  this.messageRequestsButton = null;
  this.showConnectionIndicator = null;
  this.isLoadingConversations = !!o.loading;
  this.pullFailureReason = null;
  this.hasError = false;
  this.hasLoadedConversationsFromDb = !o.loading;
  this.hasCheckedKeypairsFromDb = !o.loading;
  this.selectedCategory = null;
  this.hasMoreItemsInfo = null;
  this.typingIndicatorsByConversation = new KtMapImpl(o.typing || []);
  this.ongoingGroupCallsByConversation = new KtMapImpl([]);
  this.isInitializing = !!o.loading;
  this.k1k_1 = null;
}
F(ConversationListState, 'ConversationListState');

function ConversationPreviewItem() {}
F(ConversationPreviewItem, 'ConversationPreviewItem');
function ConversationPreviewItemConversation(p) {
  this.preview = p;
}
F(ConversationPreviewItemConversation, 'Conversation', ConversationPreviewItem);
/** The inbox's Requests row: who asked, how many, and whether you have looked since. */
function ConversationPreviewMessageRequests(o) {
  this.relevantUserNames = list(o.names);
  this.priorityCount = o.count;
  this.isUnseen = o.unseen;
}
F(ConversationPreviewMessageRequests, 'ConversationPreviewMessageRequests');
function ConversationPreviewItemMessageRequests(o) {
  this.messageRequests = new ConversationPreviewMessageRequests(o);
}
F(ConversationPreviewItemMessageRequests, 'MessageRequests', ConversationPreviewItem);
ConversationPreviewItem.Conversation = ConversationPreviewItemConversation;
ConversationPreviewItem.MessageRequests = ConversationPreviewItemMessageRequests;

// ------------------------------------------------------------------ events
function ConversationListEvent() {}
F(ConversationListEvent, 'ConversationListEvent');
function RowClicked(preview) {
  this.preview = preview;
}
F(RowClicked, 'RowClicked', ConversationListEvent);
ConversationListEvent.RowClicked = RowClicked;
function ScrolledToBottomOfConversations() {}
F(ScrolledToBottomOfConversations, 'ScrolledToBottomOfConversations', ConversationListEvent, 'object');
D(ConversationListEvent, 'ScrolledToBottomOfConversations', () => (ScrolledToBottomOfConversations.i ||= new ScrolledToBottomOfConversations()));

function DmEvent() {}
F(DmEvent, 'DmEvent');
function ScrolledToTop(info) {
  this.info = info;
}
F(ScrolledToTop, 'ScrolledToTop', DmEvent);
function VisibleReadableItemsChanged(scrolledToBottom, seqs) {
  this.scrolledToBottom = scrolledToBottom;
  this.visibleReadableSequenceNumbers = seqs;
}
F(VisibleReadableItemsChanged, 'VisibleReadableItemsChanged', DmEvent);
function ReplyToMessageClicked(message) {
  this.message = message;
}
F(ReplyToMessageClicked, 'ReplyToMessageClicked', DmEvent);
function ReactionPickerItemClick(item, message, attachmentId) {
  this.item = item;
  this.message = message;
  this.attachmentId = attachmentId === undefined ? null : attachmentId;
}
F(ReactionPickerItemClick, 'ReactionPickerItemClick', DmEvent);
function DeleteMessageForAll(message) {
  this.message = message;
}
F(DeleteMessageForAll, 'DeleteMessageForAll', DmEvent);
function DeleteMessageForMe(message) {
  this.message = message;
}
F(DeleteMessageForMe, 'DeleteMessageForMe', DmEvent);
function ResolveMediaImmediately(item) {
  this.item = item;
}
F(ResolveMediaImmediately, 'ResolveMediaImmediately', DmEvent);
function BackButtonClicked() {}
F(BackButtonClicked, 'BackButtonClicked', DmEvent, 'object');
function UiShown() {}
F(UiShown, 'UiShown', DmEvent, 'object');
function MessageActionClick(action) {
  this.action = action;
}
F(MessageActionClick, 'MessageActionClick', DmEvent);
Object.assign(DmEvent, { ScrolledToTop, VisibleReadableItemsChanged, ReplyToMessageClicked, ReactionPickerItemClick, DeleteMessageForAll, DeleteMessageForMe, ResolveMediaImmediately, MessageActionClick });
D(DmEvent, 'BackButtonClicked', () => (BackButtonClicked.i ||= new BackButtonClicked()));
D(DmEvent, 'UiShown', () => (UiShown.i ||= new UiShown()));
// A message request's bar in the conversation: Accept, or Decline / Block and then their confirmation dialogs.
for (const n of ['AcceptMessageRequest', 'DeclineMessageRequest', 'ConfirmDeclineMessageRequest', 'BlockMessageRequest', 'ConfirmBlockMessageRequest']) {
  const O = function () {};
  F(O, n, DmEvent, 'object');
  D(DmEvent, n, () => (O.i ||= new O()));
}

/** What the message's menus offer (ChatMessageAction), each the UI's MessageActionClick argument. */
function ChatMessageAction() {}
F(ChatMessageAction, 'ChatMessageAction');
function ActionForward(message, attachmentId) {
  this.message = message;
  this.attachmentId = attachmentId === undefined ? null : attachmentId;
}
F(ActionForward, 'Forward', ChatMessageAction);
function ActionReply(message) {
  this.message = message;
}
F(ActionReply, 'Reply', ChatMessageAction);
function ActionEdit(message) {
  this.message = message;
}
F(ActionEdit, 'Edit', ChatMessageAction);
function ActionDeleteForSelf(message) {
  this.message = message;
}
F(ActionDeleteForSelf, 'DeleteForSelf', ChatMessageAction);
function ActionDeleteForAll(message) {
  this.message = message;
}
F(ActionDeleteForAll, 'DeleteForAll', ChatMessageAction);
Object.assign(ChatMessageAction, { Forward: ActionForward, Reply: ActionReply, Edit: ActionEdit, DeleteForSelf: ActionDeleteForSelf, DeleteForAll: ActionDeleteForAll });

function ChatComposerEvent() {}
F(ChatComposerEvent, 'ChatComposerEvent');
function UserChangedText(text, cursorPosition) {
  this.text = text;
  this.cursorPosition = cursorPosition;
}
F(UserChangedText, 'UserChangedText', ChatComposerEvent);
function RightButtonClicked(button) {
  this.button = button;
}
F(RightButtonClicked, 'RightButtonClicked', ChatComposerEvent);
function StartEditingMessage(message) {
  this.message = message;
}
F(StartEditingMessage, 'StartEditingMessage', ChatComposerEvent);
function StartReplyingToMessage(message, attachmentId) {
  this.message = message;
  this.attachmentId = attachmentId === undefined ? null : attachmentId;
}
F(StartReplyingToMessage, 'StartReplyingToMessage', ChatComposerEvent);
function OnFileAttached(uri) {
  this.uri = uri;
}
F(OnFileAttached, 'OnFileAttached', ChatComposerEvent);
function RemoveReplyClicked() {}
F(RemoveReplyClicked, 'RemoveReplyClicked', ChatComposerEvent, 'object');
Object.assign(ChatComposerEvent, { UserChangedText, RightButtonClicked, StartEditingMessage, StartReplyingToMessage, OnFileAttached });
D(ChatComposerEvent, 'RemoveReplyClicked', () => (RemoveReplyClicked.i ||= new RemoveReplyClicked()));

function ReactionPickerItem(emoji, isSelected) {
  this.emoji = emoji;
  this.isSelected = isSelected;
}
F(ReactionPickerItem, 'ReactionPickerItem');

// ------------------------------------------------------------------ messages
function SenderInfo(u) {
  this.user = new User(u);
  this.l1k_1 = 0;
}
F(SenderInfo, 'SenderInfo');
function ReactionItem(emoji, users, mine) {
  this.reaction = emoji;
  this.participants = list(users.map((u) => new User(u)));
  this.isSelected = mine;
  this.attachmentId = null;
  this.notifiableSeqNum = null;
}
F(ReactionItem, 'ReactionItem');
function ReplyPreview(m) {
  this.sequenceNumber = BigInt(m.seq);
  this.senderId = new UserId(m.from);
  this.senderIsCurrentUser = false;
  this.previewText = m.text;
}
F(ReplyPreview, 'ReplyPreview');
function Dimensions(w, h) {
  this.width = w;
  this.height = h;
}
F(Dimensions, 'Dimensions');
function MediaAttachment(a, uri) {
  this.m1k_1 = a;
  this.n1k_1 = uri;
}
F(MediaAttachment, 'MediaAttachment');
D(M(MediaAttachment), 'mediaType', function () {
  return /^image\//.test(this.m1k_1.mime) ? MediaType.Image : /^video\//.test(this.m1k_1.mime) ? MediaType.Video : MediaType.File;
});
D(M(MediaAttachment), 'mimeType', function () {
  return this.m1k_1.mime;
});
D(M(MediaAttachment), 'originalFilename', function () {
  return this.m1k_1.name;
});
D(M(MediaAttachment), 'fileSize', function () {
  return this.m1k_1.size;
});
D(M(MediaAttachment), 'dimensions', function () {
  return this.m1k_1.width ? new Dimensions(this.m1k_1.width, this.m1k_1.height) : null;
});
D(M(MediaAttachment), 'attachmentId', function () {
  return this.m1k_1.id;
});
D(M(MediaAttachment), 'localOrRemoteUri', function () {
  return this.n1k_1;
});
function MessageInfo(edited) {
  this.readStatus = null;
  this.showTimestamp = true;
  this.showEdited = edited;
  this.timeToLive = null;
}
F(MessageInfo, 'MessageInfo');

/** The message item interface: everything is a getter over mangled fields, as Kotlin's exported interface is. */
function MessageItem() {}
F(MessageItem, 'MessageItem', null, 'interface');
function defineItem(name) {
  function C(m, ctx) {
    this.o1k_1 = m;
    this.p1k_1 = ctx;
  }
  F(C, name, MessageItem);
  const g = (k, f) => D(M(C), k, f);
  g('id', function () {
    return this.o1k_1.id;
  });
  g('created', function () {
    return new Instant(this.o1k_1.ts);
  });
  g('sequenceNumber', function () {
    return BigInt(this.o1k_1.seq);
  });
  g('sequenceNumberForReadState', function () {
    return BigInt(this.o1k_1.seq);
  });
  g('contentType', function () {
    return 'Text';
  });
  g('textContent', function () {
    return this.o1k_1.undecryptable ? null : this.o1k_1.text || null;
  });
  g('fullText', function () {
    return this.o1k_1.text || null;
  });
  g('senderInfo', function () {
    return new SenderInfo(this.p1k_1.user(this.o1k_1.from));
  });
  g('senderDisplayName', function () {
    return this.p1k_1.user(this.o1k_1.from).displayName;
  });
  g('isEncrypted', function () {
    return !this.p1k_1.legacy;
  });
  g('isUndecryptable', function () {
    return !!this.o1k_1.undecryptable;
  });
  g('reactions', function () {
    const by = new Map();
    for (const r of this.o1k_1.reactions || []) by.set(r.emoji, [...(by.get(r.emoji) || []), r.user]);
    return list([...by.entries()].map(([e, us]) => new ReactionItem(e, us.map((u) => this.p1k_1.user(u)), us.includes(this.p1k_1.self))));
  });
  g('replyPreview', function () {
    const r = this.o1k_1.replyToSeq && this.p1k_1.bySeq(this.o1k_1.replyToSeq);
    return r ? new ReplyPreview(r) : null;
  });
  g('attachments', function () {
    return list((this.o1k_1.attachments || []).map((a) => new MediaAttachment(a, this.p1k_1.media.get(a.id) || null)));
  });
  g('editHistory', function () {
    return list(this.o1k_1.edited ? [this.o1k_1.edited] : []);
  });
  g('messageInfo', function () {
    return new MessageInfo(!!this.o1k_1.edited);
  });
  g('hiddenState', function () {
    return this.o1k_1.deleted ? HiddenState.Deleted : null;
  });
  g('forwardedMessage', function () {
    return this.o1k_1.forwarded ? new ForwardedMessage(this.o1k_1) : null;
  });
  g('alignsToViewerSide', function () {
    return this.o1k_1.from === this.p1k_1.self;
  });
  return C;
}
const MessageItemReceived = defineItem('MessageItemReceived');
const MessageItemSentTextOnly = defineItem('MessageItemSentTextOnly');
function ForwardedMessage(m) {
  this.y1k_1 = m.id;
}
F(ForwardedMessage, 'ForwardedMessage');
function DateSeparatorItem(ms) {
  this.q1k_1 = ms;
}
F(DateSeparatorItem, 'DateSeparatorItem');
function OlderItemsInfo(seq) {
  this.r1k_1 = seq;
}
F(OlderItemsInfo, 'OlderItemsInfo');
function ChatItems(items, older) {
  this.items = list(items);
  this.olderItemsInfo = older;
}
F(ChatItems, 'ChatItems');
function DmState(o) {
  this.convId = o.convId;
  this.toolbarState = null;
  this.chatItems = o.chatItems;
  this.readOnlyReason = null;
  this.isLegacy = o.isLegacy;
  this.currentParticipantIds = list(o.participants.map((p) => new UserId(p)));
  this.messageRequest = new MessageRequest(o.request ? TrustState.RequestReceived : TrustState.Trusted, null);
  this.showingForwardMessageDialog = !!o.forwarding;
  this.activeBottomSheet = null;
  this.s1k_1 = 0;
}
F(DmState, 'DmState');
function MessageRequest(trustState, otherUser) {
  this.trustState = trustState;
  this.otherUser = otherUser;
}
F(MessageRequest, 'MessageRequest');
function ChatComposerState(o) {
  this.text = o.text || '';
  this.rightButton = o.text || (o.attachments && o.attachments.length && o.attachments.every((a) => a.uploaded)) ? RightButton.SendActive : RightButton.SendInactive;
  this.replyingTo = o.replyingTo || null;
  this.replyingToAttachmentId = null;
  this.isEditing = !!o.editing;
  this.attachments = list(o.attachments || []);
  this.hasEnteredAnyText = !!o.text;
  this.maxAttachments = 1;
  this.maxMessageLengthBytes = 10000;
}
F(ChatComposerState, 'ChatComposerState');

/** What may be done with a message, as the real core's MessageActionsModel: the rail and the overflow menu. */
function MessageActionsModel(item, mine) {
  this.rail = list([new ActionReply(item), new ActionForward(item, null)]);
  this.overflow = list([...(mine ? [new ActionEdit(item)] : []), new ActionDeleteForSelf(item), ...(mine ? [new ActionDeleteForAll(item)] : [])]);
  this.quickReactions = list([]);
  this.selectedReactions = list([]);
  this.message = item;
  this.attachmentId = null;
}
F(MessageActionsModel, 'MessageActionsModel');
function MessageTarget(fromAttachment) {
  this.fromAttachment = fromAttachment;
}
F(MessageTarget, 'MessageTarget');
function MessageTargetCompanion() {}
F(MessageTargetCompanion, 'Companion', null, 'object');
M(MessageTargetCompanion).forMessage = function (item) {
  return list([new MessageTarget(false)]);
};
D(MessageTarget, 'Companion', () => (MessageTargetCompanion.i ||= new MessageTargetCompanion()));

// ------------------------------------------------------------------ the core
async function api(path, body) {
  const res = await fetch(API + path, body === undefined ? { credentials: 'include' } : { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function Store(selfId) {
  this.self = selfId;
  this.users = new Map();
  this.convs = new Map();
  this.msgs = new Map(); // conv -> Map(seq -> message)
  this.media = new Map(); // attachment id -> blob: url, once loaded
  this.listeners = new Set();
}
F(Store, 'DmRepository');
Store.prototype.ctx = function (conv) {
  const s = this;
  const c = s.convs.get(conv);
  return {
    self: s.self,
    legacy: !!(c && c.legacy),
    media: s.media,
    user: (id) => s.users.get(id) || { id, screenName: 'unknown', displayName: null },
    bySeq: (seq) => (s.msgs.get(conv) || new Map()).get(String(seq)),
  };
};
Store.prototype.take = function (data) {
  for (const u of data.users || []) this.users.set(u.id, u);
  for (const c of data.conversations || []) this.convs.set(c.id, c);
  for (const m of data.messages || []) {
    const map = this.msgs.get(m.conv) || new Map();
    map.set(String(m.seq), m);
    this.msgs.set(m.conv, map);
  }
  for (const f of this.listeners) f();
};
Store.prototype.preview = function (c) {
  return new ConversationPreviewWithMetadata(c, this.last(c.id), (c.members || []).filter((u) => u !== this.self).map((u) => new User(this.users.get(u) || { id: u, screenName: 'unknown' })), c.unread || 0, this.self);
};
Store.prototype.last = function (conv) {
  const map = this.msgs.get(conv);
  if (!map || !map.size) return null;
  return [...map.values()].filter((m) => !m.deleted).sort((a, b) => b.seq - a.seq)[0] || null;
};

function DefaultConversationListComponent(graph, callbacks) {
  this.t1k_1 = graph;
  this.u1k_1 = callbacks;
  this.v1k_1 = new ExportedStateFlow(new ConversationListState({ previews: [], loading: true }));
  this.inboxCategoryDropdownComponent = { w1k_1: 0 };
  this.toasts = new ExportedStateFlow(list([]));
  this.args = null;
  const self = this;
  this.x1k_1 = () => self.y1k();
  graph.a2k_1.listeners.add(this.x1k_1);
  if (graph.b2k_1) this.y1k();
}
F(DefaultConversationListComponent, 'DefaultConversationListComponent');
D(M(DefaultConversationListComponent), 'state', function () {
  return this.v1k_1;
});
M(DefaultConversationListComponent).y1k = function () {
  const s = this.t1k_1.a2k_1;
  const previews = [...s.convs.values()]
    .filter((c) => !c.request && !c.gone)
    .map((c) => s.preview(c))
    .sort((a, b) => Number(b.preview.timestamp.epochSeconds - a.preview.timestamp.epochSeconds));
  const typing = [...this.t1k_1.c2k_1.entries()].map(([conv, user]) => [convIdOf(s.convs.get(conv) || { id: conv }), list([new User(s.users.get(user) || { id: user, screenName: 'x' })])]);
  const asks = [...s.convs.values()].filter((c) => c.request && !c.gone);
  const requests = asks.length ? { count: asks.length, unseen: asks.some((c) => c.unseen), names: asks.map((c) => (s.users.get(c.from) || {}).displayName || '') } : null;
  this.v1k_1.e1k(new ConversationListState({ previews, loading: false, typing, requests }));
};
M(DefaultConversationListComponent).onEvent = function (e) {
  if (e instanceof RowClicked) this.u1k_1.onConversationClicked(e.preview.conversationId);
};
M(DefaultConversationListComponent).observeTypingIndicator = function () {
  return new ExportedStateFlow(null);
};

function DefaultChatComposerComponent(dm) {
  this.z1k_1 = dm;
  this.a1l_1 = new ExportedStateFlow(new ChatComposerState({}));
  this.b1l_1 = {};
}
F(DefaultChatComposerComponent, 'DefaultChatComposerComponent');
D(M(DefaultChatComposerComponent), 'state', function () {
  return this.a1l_1;
});
M(DefaultChatComposerComponent).c1l = function (patch) {
  this.b1l_1 = Object.assign({}, this.b1l_1, patch);
  this.a1l_1.e1k(new ChatComposerState(this.b1l_1));
};
M(DefaultChatComposerComponent).onEvent = function (e) {
  const dm = this.z1k_1;
  if (e instanceof UserChangedText) {
    const changed = (this.b1l_1.text || '') !== e.text;
    this.c1l({ text: e.text });
    if (changed && Date.now() - (this.d1l_2 || 0) > 3000) {
      this.d1l_2 = Date.now();
      void api('/typing', { conv: dm.d1l_1 }).catch(() => {});
    }
    return;
  }
  if (e instanceof StartReplyingToMessage) return this.c1l({ replyingTo: { seq: String(e.message.sequenceNumber) } });
  if (e instanceof StartEditingMessage) return this.c1l({ editing: { id: e.message.id }, text: e.message.textContent || '' });
  if (e instanceof OnFileAttached) {
    const att = { uri: e.uri, uploaded: false };
    this.c1l({ attachments: [...(this.b1l_1.attachments || []), att] });
    const self = this;
    fetch(e.uri.blobUrl)
      .then((r) => r.arrayBuffer())
      .then((buf) => fetch(`${API}/upload?name=${encodeURIComponent(e.uri.name)}&mime=${encodeURIComponent(e.uri.mime)}`, { method: 'POST', credentials: 'include', body: buf }))
      .then((r) => r.json())
      .then((j) => {
        att.uploaded = true;
        att.mediaId = j.id;
        self.c1l({ attachments: [...self.b1l_1.attachments] });
      });
    return;
  }
  if (e instanceof RightButtonClicked) {
    if (e.button !== RightButton.SendActive) return;
    const st = this.b1l_1;
    this.b1l_1 = {};
    this.a1l_1.e1k(new ChatComposerState({}));
    if (st.editing) return void api('/edit', { conv: dm.d1l_1, id: st.editing.id, text: st.text });
    return void api('/send', {
      conv: dm.d1l_1,
      text: st.text || '',
      replyToSeq: st.replyingTo ? st.replyingTo.seq : null,
      media: (st.attachments || []).map((a) => a.mediaId),
    });
  }
  if (e === RemoveReplyClicked.i) return this.c1l({ replyingTo: null });
};

function DefaultDmComponent(container, callbacks) {
  this.d1l_1 = container.convId;
  this.e1l_1 = container.graph;
  this.f1l_1 = callbacks;
  this.g1l_1 = 20;
  this.h1l_1 = new ExportedStateFlow(this.j1l());
  this.composer = new DefaultChatComposerComponent(this);
  this.forwardComponent = new DefaultForwardMessageComponent(this);
  this.hoverSession = null;
  this.w1l_1 = false;
  const self = this;
  this.i1l_1 = () => self.h1l_1.e1k(self.j1l());
  this.e1l_1.a2k_1.listeners.add(this.i1l_1);
  void this.k1l();
}
F(DefaultDmComponent, 'DefaultDmComponent');
D(M(DefaultDmComponent), 'state', function () {
  return this.h1l_1;
});
M(DefaultDmComponent).k1l = async function () {
  const data = await api(`/messages?conv=${encodeURIComponent(this.d1l_1)}&limit=${this.g1l_1}`);
  this.e1l_1.a2k_1.take(data);
};
M(DefaultDmComponent).j1l = function () {
  const s = this.e1l_1.a2k_1;
  const c = s.convs.get(this.d1l_1) || { id: this.d1l_1, members: [], legacy: false };
  const all = [...(s.msgs.get(this.d1l_1) || new Map()).values()].sort((a, b) => a.seq - b.seq);
  const shown = all.slice(-this.g1l_1);
  const ctx = s.ctx(this.d1l_1);
  const items = [];
  let day = null;
  for (const m of shown) {
    const d = new Date(m.ts).toDateString();
    if (d !== day) items.push(new DateSeparatorItem(m.ts));
    day = d;
    items.push(m.from === s.self ? new MessageItemSentTextOnly(m, ctx) : new MessageItemReceived(m, ctx));
  }
  const older = all.length > shown.length || (c.total || 0) > all.length ? new OlderItemsInfo(shown[0] ? shown[0].seq : 0) : null;
  return new DmState({ convId: convIdOf(c), chatItems: new ChatItems(items, older), isLegacy: !!c.legacy, participants: c.members || [], request: !!c.request, forwarding: this.w1l_1 });
};
M(DefaultDmComponent).onEvent = function (e) {
  const s = this.e1l_1.a2k_1;
  if (e instanceof ScrolledToTop) {
    this.g1l_1 += 20;
    const self = this;
    return void api(`/messages?conv=${encodeURIComponent(this.d1l_1)}&limit=${this.g1l_1}`).then((d) => s.take(d)).then(() => self.h1l_1.e1k(self.j1l()));
  }
  if (e instanceof VisibleReadableItemsChanged) {
    const seqs = e.visibleReadableSequenceNumbers.asJsReadonlyArrayView().map(Number);
    if (seqs.length) return void api('/read', { conv: this.d1l_1, seq: Math.max(...seqs) });
    return;
  }
  if (e instanceof ReactionPickerItemClick) return void api('/react', { conv: this.d1l_1, id: e.message.id, emoji: e.item.emoji, remove: e.item.isSelected });
  if (e instanceof DeleteMessageForAll) return void api('/unsend', { conv: this.d1l_1, id: e.message.id });
  if (e instanceof ReplyToMessageClicked) return this.composer.onEvent(new StartReplyingToMessage(e.message, null));
  if (e instanceof ResolveMediaImmediately) {
    for (const a of e.item.attachments.asJsReadonlyArrayView()) {
      const id = a.attachmentId;
      if (s.media.has(id)) continue;
      void fetch(`/__fake/media/${encodeURIComponent(id)}`, { credentials: 'include' })
        .then((r) => r.blob())
        .then((b) => {
          s.media.set(id, URL.createObjectURL(b));
          s.take({});
        });
    }
    return;
  }
  if (e === BackButtonClicked.i) return this.f1l_1.onFinished();
  // A message request, answered from its own bar: Accept at once, Decline and Block after their dialogs.
  const self = this;
  const after = () => s.take({});
  if (e === DmEvent.AcceptMessageRequest) return void api('/acceptRequest', { conv: this.d1l_1 }).then((d) => s.take(d));
  if (e === DmEvent.ConfirmDeclineMessageRequest) return void api('/deleteRequest', { conv: this.d1l_1 }).then((d) => (s.take(d), self.f1l_1.onFinished()));
  if (e === DmEvent.ConfirmBlockMessageRequest) return void api('/blockRequest', { conv: this.d1l_1 }).then((d) => (s.take(d), self.f1l_1.onFinished()));
  if (e === DmEvent.DeclineMessageRequest || e === DmEvent.BlockMessageRequest) return void after();
  if (e instanceof MessageActionClick) {
    if (e.action instanceof ActionForward) {
      this.forwardComponent.z2k(e.action.message);
      this.w1l_1 = true;
      this.h1l_1.e1k(this.j1l());
    }
    return;
  }
};
M(DefaultDmComponent).messageActions = function (item, target) {
  return new MessageActionsModel(item, item.alignsToViewerSide);
};
M(DefaultDmComponent).dispose = function () {
  this.e1l_1.a2k_1.listeners.delete(this.i1l_1);
};

function WebConvComponentContainer(graph, convId) {
  this.graph = graph;
  this.convId = convId;
  this.l1l_1 = null;
}
F(WebConvComponentContainer, 'WebConvComponentContainer');
M(WebConvComponentContainer).dmComponent = function (callbacks, cancellation, conversation) {
  return (this.l1l_1 ||= new DefaultDmComponent(this, callbacks));
};
M(WebConvComponentContainer).participantListComponent = function () {
  return null;
};
M(WebConvComponentContainer).addGroupParticipantsComponent = function (cancellation, convId, callbacks) {
  return cancelled(cancellation, new DefaultAddGroupParticipantsComponent(this.graph, convId, callbacks));
};
M(WebConvComponentContainer).editGroupMetadataComponent = function (cancellation, convId, callbacks) {
  return cancelled(cancellation, new DefaultEditGroupMetadataComponent(this.graph, convId, callbacks));
};
M(WebConvComponentContainer).dispose = function () {
  this.l1l_1 && this.l1l_1.dispose();
};

function WebDmObjectGraph(userId) {
  this.m1l_1 = new UserId(userId);
  this.a2k_1 = new Store(userId);
  this.b2k_1 = false;
  this.c2k_1 = new Map(); // typing: conv -> user
  this.n1l_1 = new ExportedStateFlow(null);
  this.o1l_1 = new ExportedStateFlow(0);
  void this.p1l();
}
F(WebDmObjectGraph, 'WebDmObjectGraph');
D(M(WebDmObjectGraph), 'ownerUser', function () {
  return this.n1l_1;
});
D(M(WebDmObjectGraph), 'unreadMessageCount', function () {
  return this.o1l_1;
});
M(WebDmObjectGraph).p1l = async function () {
  const data = await api('/inbox');
  this.b2k_1 = true;
  this.a2k_1.take(data);
  const es = new EventSource(`${API}/events`);
  const self = this;
  es.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.typing) {
      if (d.typing.stop) self.c2k_1.delete(d.typing.conv);
      else self.c2k_1.set(d.typing.conv, d.typing.user);
    }
    self.a2k_1.take(d);
  };
};
M(WebDmObjectGraph).conversationListComponent = function (callbacks, cancellation, flag) {
  return new DefaultConversationListComponent(this, callbacks);
};
M(WebDmObjectGraph).convComponentContainer = function (convId) {
  return new WebConvComponentContainer(this, convId);
};
M(WebDmObjectGraph).messageRequestsComponent = function (callbacks, cancellation, other) {
  return cancelled(cancellation, new DefaultMessageRequestsComponent(this, callbacks, !!other));
};
M(WebDmObjectGraph).newDmComponent = function (cancellation, a, b, onBack, onOpen) {
  return cancelled(cancellation, new DefaultNewDmComponent(this, onBack, onOpen));
};
M(WebDmObjectGraph).dmPinEntryComponent = function () {
  return { q1l_1: 0 };
};
M(WebDmObjectGraph).clearOnLogout = function () {
  return Promise.resolve();
};
M(WebDmObjectGraph).getAllEmojis = function () {
  return Promise.resolve(list([]));
};

function DefaultDmPinEntryComponent() {
  this.r1l_1 = new ExportedStateFlow({ showForgotPin: true });
}
F(DefaultDmPinEntryComponent, 'DefaultDmPinEntryComponent');
D(M(DefaultDmPinEntryComponent), 'state', function () {
  return this.r1l_1;
});
M(DefaultDmPinEntryComponent).onEvent = function () {};


// ------------------------------------------------------------------ requests, new chats, groups, forwarding
// The components the UI makes for the Requests page, New message (and Create a group), Add people, Edit Group and
// the forward dialog, shaped as the real core's: sealed events with their subclasses as statics, state flows,
// `onEvent` on the first two and `handleEvent` on the others (as the embed calls them), callbacks the UI passes in,
// and a Cancellation whose subscribe gets the dispose.
function cancelled(cancellation, component) {
  try {
    if (cancellation && typeof cancellation.subscribe === 'function') cancellation.subscribe(() => component.dispose && component.dispose());
  } catch (e) {}
  return component;
}
function sealed(parent, name, fields) {
  // Kotlin's constructors take their fields as declared parameters (their arity shows in the diagnostics).
  const set = (self, a) => fields.forEach((f, i) => (self[f] = a[i] === undefined ? null : a[i]));
  const C =
    fields.length === 1
      ? function (a) {
          set(this, [a]);
        }
      : function (a, b) {
          set(this, [a, b]);
        };
  F(C, name, parent);
  parent[name] = C;
  return C;
}
function object(parent, name) {
  const O = function () {};
  F(O, name, parent, 'object');
  D(parent, name, () => (O.i ||= new O()));
  return O;
}
function KtMap(entries) {
  return new KtMapImpl(entries);
}

/** Someone the search offers: whether you may message them, or put them in a group (XChatUserImpl). */
function XChatUserImpl(u) {
  this.v2k_1 = u;
}
F(XChatUserImpl, 'XChatUserImpl');
D(M(XChatUserImpl), 'id', function () {
  return new UserId(this.v2k_1.id);
});
D(M(XChatUserImpl), 'screenName', function () {
  return this.v2k_1.screenName;
});
D(M(XChatUserImpl), 'name', function () {
  return this.v2k_1.displayName;
});
D(M(XChatUserImpl), 'profileImageUrl', function () {
  return this.v2k_1.avatarUrl || null;
});
D(M(XChatUserImpl), 'canSendMessage', function () {
  return this.v2k_1.canSendMessage !== false;
});
D(M(XChatUserImpl), 'cannotMessageReason', function () {
  return this.v2k_1.canSendMessage === false ? CannotMessageReason.NotFollowing : null;
});
D(M(XChatUserImpl), 'canBeAddedToGroup', function () {
  return this.v2k_1.canBeAddedToGroup !== false;
});
D(M(XChatUserImpl), 'cannotBeAddedToGroupReason', function () {
  return this.v2k_1.canBeAddedToGroup === false ? CannotMessageReason.NotFollowing : null;
});
async function searchUsers(q) {
  const d = await api(`/search?q=${encodeURIComponent(q)}`);
  return d.users.map((u) => new XChatUserImpl(u));
}

// --- the Requests page
function MessageRequestsTab(name, ordinal) {
  Enum.call(this, name, ordinal);
}
F(MessageRequestsTab, 'MessageRequestsTab', Enum);
MessageRequestsTab.Priority = new MessageRequestsTab('Priority', 0);
MessageRequestsTab.Hidden = new MessageRequestsTab('Hidden', 1);
function MessageRequestsState(o) {
  this.selectedTab = o.tab;
  this.previews = list(o.previews || []);
  this.isLoading = !!o.loading;
  this.hasMoreItemsInfo = null;
  this.showActionsDialog = null;
  this.confirmDeleteConvId = o.confirmDelete || null;
  this.confirmBlockConvId = o.confirmBlock || null;
  this.didFetchFail = !!o.failed;
  this.isHiddenOnly = o.tab === MessageRequestsTab.Hidden;
}
F(MessageRequestsState, 'MessageRequestsState');
function MessageRequestsEvent() {}
F(MessageRequestsEvent, 'MessageRequestsEvent');
sealed(MessageRequestsEvent, 'TabSelected', ['tab']);
sealed(MessageRequestsEvent, 'RowClicked', ['conversationId', 'lastReadSequenceNumber']);
sealed(MessageRequestsEvent, 'AcceptRequestClicked', ['conversationId']);
sealed(MessageRequestsEvent, 'DeleteRequestClicked', ['conversationId']);
sealed(MessageRequestsEvent, 'BlockRequestClicked', ['conversationId']);
for (const n of ['ScrolledToBottom', 'ConfirmBlock', 'DismissBlockDialog', 'ConfirmDelete', 'DismissDeleteDialog', 'RetryFetch']) object(MessageRequestsEvent, n);

function DefaultMessageRequestsComponent(graph, callbacks, other) {
  this.a2l_1 = graph;
  this.b2l_1 = callbacks;
  this.c2l_1 = { tab: other ? MessageRequestsTab.Hidden : MessageRequestsTab.Priority, loading: true };
  this.d2l_1 = new ExportedStateFlow(new MessageRequestsState(this.c2l_1));
  this.toasts = new ExportedStateFlow(list([]));
  const self = this;
  this.e2l_1 = () => self.f2l();
  graph.a2k_1.listeners.add(this.e2l_1);
  void this.g2l();
}
F(DefaultMessageRequestsComponent, 'DefaultMessageRequestsComponent');
D(M(DefaultMessageRequestsComponent), 'state', function () {
  return this.d2l_1;
});
/** The first page from the server, as the real repo fetches it (which also marks the priority requests seen). */
M(DefaultMessageRequestsComponent).g2l = async function () {
  try {
    const d = await api(`/requests?tab=${this.c2l_1.tab.name}`);
    this.c2l_1.loading = false;
    this.a2l_1.a2k_1.take(d);
  } catch (e) {
    this.c2l_1 = Object.assign({}, this.c2l_1, { loading: false, failed: true });
    this.f2l();
  }
};
M(DefaultMessageRequestsComponent).f2l = function () {
  const s = this.a2l_1.a2k_1;
  const previews = this.c2l_1.loading ? [] : [...s.convs.values()].filter((c) => c.request && !c.gone).map((c) => s.preview(c));
  this.d2l_1.e1k(new MessageRequestsState(Object.assign({}, this.c2l_1, { previews })));
};
M(DefaultMessageRequestsComponent).h2l = function (patch) {
  this.c2l_1 = Object.assign({}, this.c2l_1, patch);
  this.f2l();
};
M(DefaultMessageRequestsComponent).onEvent = function (e) {
  const E = MessageRequestsEvent;
  const s = this.a2l_1.a2k_1;
  const take = (d) => s.take(d);
  // As the real one: the list's buttons answer one-to-one requests only.
  const one = (id) => id instanceof OneOnOne;
  if (e instanceof E.RowClicked) return this.b2l_1.onConversationCtaActivated(e.conversationId, e.lastReadSequenceNumber, this.c2l_1.tab);
  if (e instanceof E.AcceptRequestClicked) return one(e.conversationId) ? void api('/acceptRequest', { conv: e.conversationId.id }).then(take) : undefined;
  if (e instanceof E.DeleteRequestClicked) return one(e.conversationId) ? this.h2l({ confirmDelete: e.conversationId }) : undefined;
  if (e instanceof E.BlockRequestClicked) return one(e.conversationId) ? this.h2l({ confirmBlock: e.conversationId }) : undefined;
  if (e === E.ConfirmDelete) {
    const id = this.c2l_1.confirmDelete;
    this.h2l({ confirmDelete: null });
    return id ? void api('/deleteRequest', { conv: id.id }).then(take) : undefined;
  }
  if (e === E.ConfirmBlock) {
    const id = this.c2l_1.confirmBlock;
    this.h2l({ confirmBlock: null });
    return id ? void api('/blockRequest', { conv: id.id }).then(take) : undefined;
  }
  if (e === E.DismissDeleteDialog) return this.h2l({ confirmDelete: null });
  if (e === E.DismissBlockDialog) return this.h2l({ confirmBlock: null });
  if (e === E.RetryFetch) return void this.g2l();
};
M(DefaultMessageRequestsComponent).dispose = function () {
  this.a2l_1.a2k_1.listeners.delete(this.e2l_1);
};

// --- New message, and Create a group
function NewDmSuggestion(user) {
  this.user = user;
  this.w2k_1 = user.v2k_1.id;
}
F(NewDmSuggestion, 'NewDmSuggestion');
D(M(NewDmSuggestion), 'id', function () {
  return this.w2k_1;
});
function NewDmState(o) {
  this.suggestions = list(o.suggestions || []);
  this.isCreateGroupMode = !!o.group;
  this.selectedGroupUsers = KtMap((o.selected || []).map((u) => [u.id, u]));
  this.groupTitle = o.title || '';
  this.isCreateConversationCallInProgress = !!o.creating;
  this.showCannotMessageDialogForUser = o.cannot || null;
  this.query = o.query || '';
}
F(NewDmState, 'NewDmState');
const NewDmToast = makeEnum('NewDmToast', ['CreateGroupFailed', 'GroupTooLarge', 'XNumberFailed']);
function NewDmEvent() {}
F(NewDmEvent, 'NewDmEvent');
sealed(NewDmEvent, 'QueryChanged', ['query']);
sealed(NewDmEvent, 'GroupTitleChanged', ['title']);
sealed(NewDmEvent, 'SuggestionClicked', ['suggestion']);
sealed(NewDmEvent, 'DeleteSelectedGroupUser', ['userId']);
for (const n of ['CreateAGroupItemClicked', 'CreateButtonClicked', 'BackButtonClicked', 'DismissCannotMessageDialog']) object(NewDmEvent, n);

function DefaultNewDmComponent(graph, onBack, onOpen) {
  this.a2m_1 = graph;
  this.b2m_1 = onBack;
  this.c2m_1 = onOpen;
  this.d2m_1 = {};
  this.e2m_1 = new ExportedStateFlow(new NewDmState({}));
  this.toasts = new ExportedStateFlow(null);
  this.f2m_1 = 0;
}
F(DefaultNewDmComponent, 'DefaultNewDmComponent');
D(M(DefaultNewDmComponent), 'state', function () {
  return this.e2m_1;
});
M(DefaultNewDmComponent).g2m = function (patch) {
  this.d2m_1 = Object.assign({}, this.d2m_1, patch);
  this.e2m_1.e1k(new NewDmState(this.d2m_1));
};
M(DefaultNewDmComponent).onEvent = function (e) {
  const E = NewDmEvent;
  const self = this;
  if (e instanceof E.QueryChanged) {
    const n = ++this.f2m_1;
    this.g2m({ query: e.query });
    if (!e.query) return this.g2m({ suggestions: [] });
    return void searchUsers(e.query).then((users) => n === self.f2m_1 && self.g2m({ suggestions: users.map((u) => new NewDmSuggestion(u)) }));
  }
  if (e instanceof E.GroupTitleChanged) return this.g2m({ title: e.title });
  if (e === E.CreateAGroupItemClicked) return this.g2m({ group: true });
  if (e === E.DismissCannotMessageDialog) return this.g2m({ cannot: null });
  if (e === E.BackButtonClicked) return this.b2m_1();
  if (e instanceof E.SuggestionClicked) {
    const u = e.suggestion.user;
    const self_ = this.a2m_1.a2k_1.self;
    if (this.d2m_1.group) {
      if (!u.canBeAddedToGroup) return this.g2m({ cannot: u });
      const sel = this.d2m_1.selected || [];
      const has = sel.some((x) => x.id.userIdString === u.id.userIdString);
      return this.g2m({ selected: has ? sel.filter((x) => x.id.userIdString !== u.id.userIdString) : [...sel, u] });
    }
    if (!u.canSendMessage) return this.g2m({ cannot: u });
    return void queueMicrotask(() => self.c2m_1(new OneOnOne(oneOnOneId(self_, u.id.userIdString))));
  }
  if (e === E.CreateButtonClicked) {
    const sel = this.d2m_1.selected || [];
    if (!sel.length) return;
    this.g2m({ creating: true });
    return void api('/createGroup', { members: sel.map((u) => u.id.userIdString), title: this.d2m_1.title || null })
      .then((d) => {
        self.a2m_1.a2k_1.take(d);
        self.g2m({ creating: false });
        self.c2m_1(new Group(d.conv));
      })
      .catch(() => {
        self.g2m({ creating: false });
        self.toasts.e1k(NewDmToast.CreateGroupFailed);
      });
  }
};
M(DefaultNewDmComponent).dispose = function () {};

// --- Add people to a group
function AddParticipantSuggestion(user, already, selected) {
  this.user = user;
  this.alreadyParticipant = already;
  this.isSelected = selected;
  this.matchedXNumberLabel = null;
}
F(AddParticipantSuggestion, 'AddParticipantSuggestion');
function AddGroupParticipantsState(o) {
  this.query = o.query || '';
  this.suggestions = list(o.suggestions || []);
  this.selectedUserIds = KtMap((o.selected || []).map((u) => [u.id, u]));
  this.isCallingApi = !!o.calling;
  this.showCannotMessageDialogForUser = o.cannot || null;
}
F(AddGroupParticipantsState, 'AddGroupParticipantsState');
const AddGroupParticipantsToastType = makeEnum('AddGroupParticipantsToastType', ['AddFailed', 'GroupFull']);
function AddGroupParticipantsEvent() {}
F(AddGroupParticipantsEvent, 'AddGroupParticipantsEvent');
sealed(AddGroupParticipantsEvent, 'UserRowClicked', ['suggestion']);
sealed(AddGroupParticipantsEvent, 'QueryChanged', ['query']);
sealed(AddGroupParticipantsEvent, 'DeleteSelectedGroupUser', ['userId']);
for (const n of ['DoneClicked', 'BackButtonClicked', 'DismissCannotMessageDialog']) object(AddGroupParticipantsEvent, n);

function DefaultAddGroupParticipantsComponent(graph, convId, callbacks) {
  this.a2n_1 = graph;
  this.b2n_1 = convId;
  this.c2n_1 = callbacks;
  this.d2n_1 = {};
  this.e2n_1 = new ExportedStateFlow(new AddGroupParticipantsState({}));
  this.toasts = new ExportedStateFlow(null);
  this.f2n_1 = 0;
}
F(DefaultAddGroupParticipantsComponent, 'DefaultAddGroupParticipantsComponent');
D(M(DefaultAddGroupParticipantsComponent), 'state', function () {
  return this.e2n_1;
});
M(DefaultAddGroupParticipantsComponent).g2n = function (patch) {
  this.d2n_1 = Object.assign({}, this.d2n_1, patch);
  const sel = this.d2n_1.selected || [];
  this.e2n_1.e1k(new AddGroupParticipantsState(Object.assign({}, this.d2n_1, { suggestions: (this.d2n_1.users || []).map((u) => new AddParticipantSuggestion(u, this.h2n().includes(u.id.userIdString), sel.some((x) => x.id.userIdString === u.id.userIdString))) })));
};
M(DefaultAddGroupParticipantsComponent).h2n = function () {
  const c = this.a2n_1.a2k_1.convs.get(this.b2n_1.id);
  return (c && c.members) || [];
};
M(DefaultAddGroupParticipantsComponent).handleEvent = function (e) {
  const E = AddGroupParticipantsEvent;
  const self = this;
  if (e instanceof E.QueryChanged) {
    const n = ++this.f2n_1;
    this.g2n({ query: e.query });
    return void searchUsers(e.query).then((users) => n === self.f2n_1 && self.g2n({ users }));
  }
  if (e instanceof E.UserRowClicked) {
    const s = e.suggestion;
    if (s.alreadyParticipant) return;
    if (!s.user.canBeAddedToGroup) return this.g2n({ cannot: s.user });
    const sel = this.d2n_1.selected || [];
    const id = s.user.id.userIdString;
    return this.g2n({ selected: sel.some((x) => x.id.userIdString === id) ? sel.filter((x) => x.id.userIdString !== id) : [...sel, s.user] });
  }
  if (e === E.DismissCannotMessageDialog) return this.g2n({ cannot: null });
  if (e === E.BackButtonClicked) return this.c2n_1.onFinished();
  if (e === E.DoneClicked) {
    const sel = this.d2n_1.selected || [];
    if (!sel.length) return this.c2n_1.onFinished();
    this.g2n({ calling: true });
    return void api('/addMembers', { conv: this.b2n_1.id, members: sel.map((u) => u.id.userIdString) })
      .then((d) => {
        self.a2n_1.a2k_1.take(d);
        self.g2n({ calling: false, selected: [] });
        self.c2n_1.onFinished();
      })
      .catch(() => {
        self.g2n({ calling: false });
        self.toasts.e1k(AddGroupParticipantsToastType.AddFailed);
      });
  }
};
M(DefaultAddGroupParticipantsComponent).dispose = function () {};

// --- Edit Group: name and description
function EditGroupMetadataState(o) {
  this.metadata = o.metadata || null;
  this.currentTitle = o.title == null ? '' : o.title;
  this.currentDescription = o.description == null ? null : o.description;
  this.descriptionCharactersRemaining = 500 - (o.description || '').length;
  this.saveButtonEnabled = !!o.dirty && !o.saving && this.descriptionCharactersRemaining >= 0;
  this.groupDescriptionsEnabled = true;
  this.isSaving = !!o.saving;
}
F(EditGroupMetadataState, 'EditGroupMetadataState');
const EditGroupMetadataToast = makeEnum('EditGroupMetadataToast', ['UpdateFailed']);
function EditGroupMetadataEvent() {}
F(EditGroupMetadataEvent, 'EditGroupMetadataEvent');
sealed(EditGroupMetadataEvent, 'TitleTextUpdated', ['text']);
sealed(EditGroupMetadataEvent, 'DescriptionTextUpdated', ['text']);
sealed(EditGroupMetadataEvent, 'NewAvatarSelected', ['avatar']);
for (const n of ['SaveButtonClicked', 'BackButtonClicked']) object(EditGroupMetadataEvent, n);

function DefaultEditGroupMetadataComponent(graph, convId, callbacks) {
  this.a2o_1 = graph;
  this.b2o_1 = convId;
  this.c2o_1 = callbacks;
  const c = graph.a2k_1.convs.get(convId.id) || { id: convId.id, members: [] };
  this.d2o_1 = { title: c.title || '', description: c.description || null, metadata: graph.a2k_1.preview(c).metadata.metadata };
  this.e2o_1 = new ExportedStateFlow(new EditGroupMetadataState(this.d2o_1));
  this.toasts = new ExportedStateFlow(null);
}
F(DefaultEditGroupMetadataComponent, 'DefaultEditGroupMetadataComponent');
D(M(DefaultEditGroupMetadataComponent), 'state', function () {
  return this.e2o_1;
});
M(DefaultEditGroupMetadataComponent).f2o = function (patch) {
  this.d2o_1 = Object.assign({}, this.d2o_1, patch);
  this.e2o_1.e1k(new EditGroupMetadataState(this.d2o_1));
};
M(DefaultEditGroupMetadataComponent).handleEvent = function (e) {
  const E = EditGroupMetadataEvent;
  const self = this;
  if (e instanceof E.TitleTextUpdated) return this.f2o({ title: e.text, dirty: true, titleChanged: true });
  if (e instanceof E.DescriptionTextUpdated) return this.f2o({ description: e.text, dirty: true, descriptionChanged: true });
  if (e === E.BackButtonClicked) return this.c2o_1.onFinished();
  if (e === E.SaveButtonClicked) {
    if (!this.d2o_1.dirty) return;
    this.f2o({ saving: true });
    const body = { conv: this.b2o_1.id };
    if (this.d2o_1.titleChanged) body.title = this.d2o_1.title;
    if (this.d2o_1.descriptionChanged) body.description = this.d2o_1.description;
    return void api('/editGroup', body)
      .then((d) => {
        self.a2o_1.a2k_1.take(d);
        self.f2o({ saving: false, dirty: false });
        self.c2o_1.onFinished();
      })
      .catch(() => {
        self.f2o({ saving: false });
        self.toasts.e1k(EditGroupMetadataToast.UpdateFailed);
      });
  }
};
M(DefaultEditGroupMetadataComponent).dispose = function () {};

// --- Forwarding: the dialog the conversation opens for its Forward action
function ConversationSearchResult() {}
F(ConversationSearchResult, 'ConversationSearchResult');
function ExistingConversation(inboxItem) {
  this.inboxItem = inboxItem;
}
F(ExistingConversation, 'ExistingConversation', ConversationSearchResult);
function ShareSheetSuggestion() {}
F(ShareSheetSuggestion, 'ShareSheetSuggestion');
function ShareSheetConversation(result) {
  this.result = result;
  this.x2k_1 = result.inboxItem.conversationId.id;
}
F(ShareSheetConversation, 'Conversation', ShareSheetSuggestion);
D(M(ShareSheetConversation), 'id', function () {
  return this.x2k_1;
});
ShareSheetSuggestion.Conversation = ShareSheetConversation;
function ForwardMessageState(o) {
  this.suggestions = list(o.suggestions || []);
  this.selectedSuggestions = list(o.selected || []);
  this.messageText = o.text || null;
  this.forwardedMessage = o.message || null;
  this.forwardedAttachmentId = null;
  this.searchQuery = o.query || '';
  this.isLoading = false;
}
F(ForwardMessageState, 'ForwardMessageState');
function ForwardMessageEvent() {}
F(ForwardMessageEvent, 'ForwardMessageEvent');
sealed(ForwardMessageEvent, 'SelectSuggestion', ['suggestion']);
sealed(ForwardMessageEvent, 'UserChangedText', ['text', 'cursorPosition']);
sealed(ForwardMessageEvent, 'QueryChanged', ['query']);
for (const n of ['SendButtonClicked', 'BackButtonClicked']) object(ForwardMessageEvent, n);

function DefaultForwardMessageComponent(dm) {
  this.a2p_1 = dm;
  this.b2p_1 = {};
  this.c2p_1 = new ExportedStateFlow(new ForwardMessageState({}));
}
F(DefaultForwardMessageComponent, 'DefaultForwardMessageComponent');
D(M(DefaultForwardMessageComponent), 'state', function () {
  return this.c2p_1;
});
M(DefaultForwardMessageComponent).d2p = function (patch) {
  this.b2p_1 = Object.assign({}, this.b2p_1, patch);
  const s = this.a2p_1.e1l_1.a2k_1;
  const q = (this.b2p_1.query || '').toLowerCase();
  const name = (c) => (c.title || (c.members || []).filter((m) => m !== s.self).map((m) => (s.users.get(m) || {}).screenName || '').join(' ')).toLowerCase();
  // Recent conversations first, as the real dialog offers them; a query narrows them by name.
  const convs = [...s.convs.values()].filter((c) => !c.request && !c.gone && (!q || name(c).includes(q)));
  this.b2p_1.suggestions = convs.map((c) => new ShareSheetConversation(new ExistingConversation(s.preview(c))));
  this.c2p_1.e1k(new ForwardMessageState(this.b2p_1));
};
/** The dialog opens with the message to forward. */
M(DefaultForwardMessageComponent).z2k = function (message) {
  this.b2p_1 = {};
  this.d2p({ message });
};
M(DefaultForwardMessageComponent).e2p = function () {
  this.a2p_1.w1l_1 = false;
  this.a2p_1.h1l_1.e1k(this.a2p_1.j1l());
};
M(DefaultForwardMessageComponent).handleEvent = function (e) {
  const E = ForwardMessageEvent;
  const self = this;
  if (e instanceof E.QueryChanged) return this.d2p({ query: e.query });
  if (e instanceof E.UserChangedText) return this.d2p({ text: e.text });
  if (e instanceof E.SelectSuggestion) {
    const sel = this.b2p_1.selected || [];
    const has = sel.some((x) => x.id === e.suggestion.id);
    return this.d2p({ selected: has ? sel.filter((x) => x.id !== e.suggestion.id) : [...sel, e.suggestion] });
  }
  if (e === E.BackButtonClicked) return this.e2p();
  if (e === E.SendButtonClicked) {
    const st = this.b2p_1;
    if (!st.message || !(st.selected || []).length) return;
    const dm = this.a2p_1;
    return void api('/forward', { from: dm.d1l_1, id: st.message.id, to: st.selected.map((x) => x.id), note: st.text || null })
      .then((d) => dm.e1l_1.a2k_1.take(d))
      .finally(() => self.e2p());
  }
};

// Rolldown-style exports: short, meaningless names.
export {
  WebDmObjectGraph as a,
  DmEvent as b,
  ChatComposerEvent as c,
  ConversationListEvent as d,
  KtList as e,
  ReactionPickerItem as f,
  MessageTarget as g,
  RightButton as h,
  ConversationId as i,
  DefaultDmPinEntryComponent as j,
  ExportedStateFlow as k,
  MessageRequestsEvent as l,
  NewDmEvent as m,
  AddGroupParticipantsEvent as n,
  EditGroupMetadataEvent as o,
  ForwardMessageEvent as p,
  ChatMessageAction as q,
  ShareSheetSuggestion as r,
};
