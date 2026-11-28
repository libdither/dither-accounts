/**
 * Schema drift on Telegram (docs/manager.md, "Schema drift"). mtcute parses TL by its own layer, so a field or
 * constructor newer than that layer never reaches us; drift here is what mtcute knows and this extractor does not map:
 *
 * - `telegram.update`: an update constructor handleUpdate has no case for (adapter.ts), unless skipped on purpose here;
 * - `telegram.messageMedia`, `telegram.messageAction`: a media or service-message constructor mapping.ts shows only
 *   by its name (the `default:` of attachmentsOf and serviceText), and messageMediaUnsupported;
 * - `telegram.message`: a message field beyond layer 232's (a newer mtcute brings one).
 *
 * Names only, never values.
 */
import { known } from '@dither-accounts/manager/schema-drift';

/** Updates that reach handleUpdate's `default:` and are dropped on purpose. */
export const UPDATE_SKIPPED = known(
  'updateMessageID', 'updateDraftMessage', 'updateDialogPinned', 'updatePinnedDialogs', 'updateDialogUnreadMark', 'updateReadMessagesContents',
  'updateChannelReadMessagesContents', 'updateChannelMessageViews', 'updateChannelMessageForwards', 'updateChannelAvailableMessages', 'updateConfig',
  'updateDcOptions', 'updatePtsChanged', 'updateStickerSets', 'updateStickerSetsOrder', 'updateRecentStickers', 'updateSavedGifs', 'updateFavedStickers',
  'updateReadFeaturedStickers', 'updateReadFeaturedEmojiStickers', 'updateRecentReactions', 'updateRecentEmojiStatuses', 'updateSavedReactionTags',
  'updateUserEmojiStatus', 'updateDialogFilter', 'updateDialogFilters', 'updateDialogFilterOrder', 'updateLoginToken', 'updateNewAuthorization',
  'updatePrivacy', 'updateTheme', 'updateStory', 'updateReadStories', 'updateStoriesStealthMode', 'updateSentStoryReaction', 'updateStoryID',
  'updateWebViewResultSent', 'updateAttachMenuBots', 'updateBotCommands', 'updateBotMenuButton',
);

/** RawMessage and RawMessageService's fields at layer 232 (mtcute 0.32). */
export const MESSAGE_KEYS = known(
  '_', 'out', 'mentioned', 'mediaUnread', 'silent', 'post', 'fromScheduled', 'legacy', 'editHide', 'pinned', 'noforwards', 'invertMedia', 'offline',
  'videoProcessingPending', 'paidSuggestedPostStars', 'paidSuggestedPostTon', 'id', 'fromId', 'fromBoostsApplied', 'fromRank', 'peerId', 'savedPeerId',
  'fwdFrom', 'viaBotId', 'viaBusinessBotId', 'guestchatViaFrom', 'replyTo', 'date', 'message', 'media', 'replyMarkup', 'entities', 'views', 'forwards',
  'replies', 'editDate', 'postAuthor', 'groupedId', 'reactions', 'restrictionReason', 'ttlPeriod', 'quickReplyShortcutId', 'effect', 'factcheck',
  'reportDeliveryUntilDate', 'paidMessageStars', 'suggestedPost', 'scheduleRepeatPeriod', 'summaryFromLanguage', 'richMessage',
  'reactionsArePossible', 'action',
);
