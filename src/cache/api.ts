import type {
    APIChannel,
    APIInvite,
    APIMessage,
    APIPrivateUser,
    APISpace,
    APISpaceMember,
    APITheme,
    APIUser,
    APIUserSettings,
} from "@mutualzz/types";
import { LRUCache } from "lru-cache";

// [START] Auth User Caches
export const authUserLRU = new LRUCache<string, APIPrivateUser>({
    max: 1000,
    ttl: 1000 * 60 * 5,
    forEach: (value: any) => {
        delete value.hash;
    },
});
// [END] Auth User Caches

// [START] Channel Caches
export const channelsLRU = new LRUCache<string, APIChannel[]>({
    max: 1000,
    ttl: 1000 * 60,
});

export const channelLRU = new LRUCache<string, APIChannel>({
    max: 1000,
    ttl: 1000 * 60,
});
// [END] Channel Caches

// [START] Space Caches
export const spaceLRU = new LRUCache<string, APISpace>({
    max: 1000,
    ttl: 1000 * 60 * 5,
});

export const spacesLRU = new LRUCache<string, APISpace[]>({
    max: 500,
    ttl: 1000 * 60 * 5,
});

export const spaceMembersLRU = new LRUCache<string, APISpaceMember[]>({
    max: 1000,
    ttl: 1000 * 60,
});

export const spaceMemberLRU = new LRUCache<string, APISpaceMember>({
    max: 1000,
    ttl: 1000 * 60,
});

// [END] Space Caches

// [START] Invite Caches
export const invitesLRU = new LRUCache<string, APIInvite[]>({
    max: 1000,
    ttl: 1000 * 60,
});

export const inviteLRU = new LRUCache<string, APIInvite>({
    max: 2000,
    ttl: 1000 * 30,
});

export const inviteEditLRU = new LRUCache<string, Pick<APIInvite, "inviterId">>(
    {
        max: 500,
        ttl: 1000 * 60 * 5,
    },
);

// [END] Invite Caches

// [START] Message Caches
export const messagesLRU = new LRUCache<string, APIMessage[]>({
    max: 2000,
    ttl: 1000 * 30,
});

export const messageLRU = new LRUCache<string, APIMessage>({
    max: 4000,
    ttl: 1000 * 60,
});
// [END] Message Caches

// [START] User Caches
export const userLRU = new LRUCache<string, APIUser>({
    max: 1000,
    ttl: 1000 * 60 * 5,
    forEach: (value: any) => {
        delete value.hash;
    },
});

export const usersLRU = new LRUCache<string, APIUser[]>({
    max: 500,
    ttl: 1000 * 60 * 5,
    forEach: (value: any) => {
        value.forEach((v: any) => {
            delete v.hash;
        });
    },
});

export const userSettingsLRU = new LRUCache<string, APIUserSettings>({
    max: 1000,
    ttl: 1000 * 60 * 5,
});

// [END] User Caches

// [START] Theme Caches
export const themeLRU = new LRUCache<string, APITheme>({
    max: 500,
    ttl: 1000 * 60 * 10,
});

export const themesLRU = new LRUCache<string, APITheme[]>({
    max: 200,
    ttl: 1000 * 60 * 10,
});
// [END] Theme Caches
