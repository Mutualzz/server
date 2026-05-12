import type { LRUCache } from "lru-cache";
import {
    authUserLRU,
    channelLRU,
    channelOverwritesLRU,
    channelsLRU,
    everyoneRoleLRU,
    expressionLRU,
    inviteEditLRU,
    inviteLRU,
    invitesLRU,
    memberRolesLRU,
    messageLRU,
    messagesLRU,
    roleLRU,
    rolesLRU,
    spaceHydratedLRU,
    spaceLRU,
    spaceMemberLRU,
    spaceMembersLRU,
    spacesLRU,
    themeLRU,
    themesLRU,
    turnCredentialsLRU,
    userLRU,
    userSettingsLRU,
    usersLRU,
} from "./api";
import {
    avatarCache,
    channelIconCache,
    defaultAvatarCache,
    expressionsCache,
    spaceIconCache,
} from "./cdn";

export const caches = {
    // CDN
    avatar: avatarCache,
    defaultAvatar: defaultAvatarCache,
    spaceIcon: spaceIconCache,
    channelIcon: channelIconCache,
    expressions: expressionsCache,

    // REST
    authUser: authUserLRU,
    channels: channelsLRU,
    channel: channelLRU,
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
    theme: themeLRU,
    themes: themesLRU,

    // Permission related
    memberRoles: memberRolesLRU,
    everyoneRole: everyoneRoleLRU,
    channelOverwrites: channelOverwritesLRU,

    // Cloudflare
    turnCredentials: turnCredentialsLRU,
};

export type CacheName = keyof typeof caches;
export type CacheValue<T extends CacheName> =
    (typeof caches)[T] extends LRUCache<any, infer V> ? V : never;
