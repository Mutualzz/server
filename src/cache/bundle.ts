import type { LRUCache } from "lru-cache";
import {
  authUserLRU,
  channelLRU,
  channelOverwritesLRU,
  channelRecipientLRU,
  channelsLRU,
  everyoneRoleLRU,
  expressionLRU,
  gifSearchLRU,
  gifTagsLRU,
  gameIconLRU,
  inviteEditLRU,
  inviteLRU,
  invitesLRU,
  memberRolesLRU,
  messageLRU,
  messagesLRU,
  postCommentLRU,
  postCommentsLRU,
  postLRU,
  postsLRU,
  roleLRU,
  rolesLRU,
  spaceHydratedLRU,
  spaceLRU,
  spaceMemberLRU,
  spaceMembersLRU,
  spacesLRU,
  systemUserLRU,
  themeLRU,
  themesLRU,
  turnCredentialsLRU,
  userLRU,
  userSettingsLRU,
  usersLRU,
} from "./api";
import {
  appIconCache,
  avatarCache,
  channelIconCache,
  defaultAvatarCache,
  expressionsCache,
  profileImageCache,
  spaceIconCache,
  themeBackgroundCache,
} from "./cdn";

export const caches = {
  // CDN
  avatar: avatarCache,
  defaultAvatar: defaultAvatarCache,
  spaceIcon: spaceIconCache,
  channelIcon: channelIconCache,
  expressions: expressionsCache,
  profileImage: profileImageCache,
  themeBackground: themeBackgroundCache,
  appIcon: appIconCache,

  // REST
  authUser: authUserLRU,
  systemUser: systemUserLRU,
  channels: channelsLRU,
  channel: channelLRU,
  channelRecipient: channelRecipientLRU,
  expression: expressionLRU,
  space: spaceLRU,
  spaceHydrated: spaceHydratedLRU,
  spaces: spacesLRU,
  spaceMember: spaceMemberLRU,
  spaceMembers: spaceMembersLRU,
  invites: invitesLRU,
  invite: inviteLRU,
  inviteEdit: inviteEditLRU,
  messages: messagesLRU,
  message: messageLRU,
  roles: rolesLRU,
  role: roleLRU,
  user: userLRU,
  users: usersLRU,
  userSettings: userSettingsLRU,
  post: postLRU,
  posts: postsLRU,
  postComments: postCommentsLRU,
  postComment: postCommentLRU,
  theme: themeLRU,
  themes: themesLRU,

  // Permission related
  memberRoles: memberRolesLRU,
  everyoneRole: everyoneRoleLRU,
  channelOverwrites: channelOverwritesLRU,

  // Cloudflare
  turnCredentials: turnCredentialsLRU,

  // GIFs
  gifSearch: gifSearchLRU,
  gifTags: gifTagsLRU,
  gameIcon: gameIconLRU,
};

export type CacheName = keyof typeof caches;
export type CacheValue<T extends CacheName> =
  (typeof caches)[T] extends LRUCache<any, infer V> ? V : never;
