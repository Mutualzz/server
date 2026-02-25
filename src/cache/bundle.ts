import type { LRUCache } from "lru-cache";
import {
    authUserLRU,
    channelLRU,
    channelsLRU,
    inviteEditLRU,
    inviteLRU,
    invitesLRU,
    messageLRU,
    messagesLRU,
    spaceHydratedLRU,
    spaceLRU,
    spaceMemberLRU,
    spaceMembersLRU,
    spacesLRU,
    themeLRU,
    themesLRU,
    userLRU,
    userSettingsLRU,
    usersLRU,
} from "./api";
import {
    avatarCache,
    channelIconCache,
    defaultAvatarCache,
    spaceIconCache,
} from "./cdn";

export const caches = {
    // CDN
    avatar: avatarCache,
    defaultAvatar: defaultAvatarCache,
    spaceIcon: spaceIconCache,
    channelIcon: channelIconCache,

    // REST
    authUser: authUserLRU,
    channels: channelsLRU,
    channel: channelLRU,
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
    user: userLRU,
    users: usersLRU,
    userSettings: userSettingsLRU,
    theme: themeLRU,
    themes: themesLRU,
};

export type CacheName = keyof typeof caches;
export type CacheValue<T extends CacheName> =
    (typeof caches)[T] extends LRUCache<any, infer V> ? V : never;
