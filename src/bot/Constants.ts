export const IDS = {
    MAIN_GUILD: "1332254930861424661",
    CHANNELS: {
        LOGS: "1344917247268884512",
        BIRTHDAYS: "1467984840677916921",
    },
    JOIN_TO_CREATE: {
        COUCH_CATEGORY: "1332254931683377207",
        CREATION_VOICE_CHANNELS: ["1465162726790795345"],
    },
};

export const EVENTS = {
    // Core
    applicationCommandPermissionsUpdate: "applicationCommandPermissionsUpdate",
    autoModerationActionExecution: "autoModerationActionExecution",
    autoModerationRuleCreate: "autoModerationRuleCreate",
    autoModerationRuleDelete: "autoModerationRuleDelete",
    autoModerationRuleUpdate: "autoModerationRuleUpdate",

    // Channels
    channelCreate: "channelCreate",
    channelDelete: "channelDelete",
    channelPinsUpdate: "channelPinsUpdate",
    channelUpdate: "channelUpdate",

    guildChannelPermissionsUpdate: "guildChannelPermissionsUpdate",
    guildChannelTopicUpdate: "guildChannelTopicUpdate",
    unhandledGuildChannelUpdate: "unhandledGuildChannelUpdate",

    // Client
    clientReady: "clientReady",
    ready: "ready",
    debug: "debug",
    error: "error",
    warn: "warn",

    // Emojis / Stickers
    emojiCreate: "emojiCreate",
    emojiDelete: "emojiDelete",
    emojiUpdate: "emojiUpdate",
    stickerCreate: "stickerCreate",
    stickerDelete: "stickerDelete",
    stickerUpdate: "stickerUpdate",

    // Entitlements / Subs
    entitlementCreate: "entitlementCreate",
    entitlementDelete: "entitlementDelete",
    entitlementUpdate: "entitlementUpdate",
    subscriptionCreate: "subscriptionCreate",
    subscriptionDelete: "subscriptionDelete",
    subscriptionUpdate: "subscriptionUpdate",

    // Guilds
    guildAuditLogEntryCreate: "guildAuditLogEntryCreate",
    guildAvailable: "guildAvailable",
    guildUnavailable: "guildUnavailable",
    guildCreate: "guildCreate",
    guildDelete: "guildDelete",
    guildUpdate: "guildUpdate",
    guildIntegrationsUpdate: "guildIntegrationsUpdate",

    guildBoostLevelUp: "guildBoostLevelUp",
    guildBoostLevelDown: "guildBoostLevelDown",
    guildBannerAdd: "guildBannerAdd",
    guildAfkChannelAdd: "guildAfkChannelAdd",
    guildVanityURLAdd: "guildVanityURLAdd",
    guildVanityURLRemove: "guildVanityURLRemove",
    guildVanityURLUpdate: "guildVanityURLUpdate",
    guildFeaturesUpdate: "guildFeaturesUpdate",
    guildAcronymUpdate: "guildAcronymUpdate",
    guildOwnerUpdate: "guildOwnerUpdate",
    guildPartnerAdd: "guildPartnerAdd",
    guildPartnerRemove: "guildPartnerRemove",
    guildVerificationAdd: "guildVerificationAdd",
    guildVerificationRemove: "guildVerificationRemove",
    unhandledGuildUpdate: "unhandledGuildUpdate",

    // Guild Members
    guildMemberAdd: "guildMemberAdd",
    guildMemberAvailable: "guildMemberAvailable",
    guildMemberRemove: "guildMemberRemove",
    guildMembersChunk: "guildMembersChunk",
    guildMemberUpdate: "guildMemberUpdate",

    guildMemberBoost: "guildMemberBoost",
    guildMemberUnboost: "guildMemberUnboost",
    guildMemberRoleAdd: "guildMemberRoleAdd",
    guildMemberRoleRemove: "guildMemberRoleRemove",
    guildMemberNicknameUpdate: "guildMemberNicknameUpdate",
    guildMemberEntered: "guildMemberEntered",
    unhandledGuildMemberUpdate: "unhandledGuildMemberUpdate",

    // Bans
    guildBanAdd: "guildBanAdd",
    guildBanRemove: "guildBanRemove",

    // Scheduled Events
    guildScheduledEventCreate: "guildScheduledEventCreate",
    guildScheduledEventDelete: "guildScheduledEventDelete",
    guildScheduledEventUpdate: "guildScheduledEventUpdate",
    guildScheduledEventUserAdd: "guildScheduledEventUserAdd",
    guildScheduledEventUserRemove: "guildScheduledEventUserRemove",

    // Soundboard
    guildSoundboardSoundCreate: "guildSoundboardSoundCreate",
    guildSoundboardSoundDelete: "guildSoundboardSoundDelete",
    guildSoundboardSoundUpdate: "guildSoundboardSoundUpdate",
    guildSoundboardSoundsUpdate: "guildSoundboardSoundsUpdate",
    soundboardSounds: "soundboardSounds",

    // Interactions / Invites
    interactionCreate: "interactionCreate",
    inviteCreate: "inviteCreate",
    inviteDelete: "inviteDelete",

    // Messages
    messageCreate: "messageCreate",
    messageDelete: "messageDelete",
    messageDeleteBulk: "messageDeleteBulk",
    messageUpdate: "messageUpdate",
    messagePollVoteAdd: "messagePollVoteAdd",
    messagePollVoteRemove: "messagePollVoteRemove",
    messageReactionAdd: "messageReactionAdd",
    messageReactionRemove: "messageReactionRemove",
    messageReactionRemoveAll: "messageReactionRemoveAll",
    messageReactionRemoveEmoji: "messageReactionRemoveEmoji",

    messagePinned: "messagePinned",
    messageContentEdited: "messageContentEdited",
    unhandledMessageUpdate: "unhandledMessageUpdate",

    // Presence
    presenceUpdate: "presenceUpdate",
    guildMemberOffline: "guildMemberOffline",
    guildMemberOnline: "guildMemberOnline",
    unhandledPresenceUpdate: "unhandledPresenceUpdate",

    // Roles
    roleCreate: "roleCreate",
    roleDelete: "roleDelete",
    roleUpdate: "roleUpdate",

    rolePositionUpdate: "rolePositionUpdate",
    rolePermissionsUpdate: "rolePermissionsUpdate",
    unhandledRoleUpdate: "unhandledRoleUpdate",

    // Threads
    threadCreate: "threadCreate",
    threadDelete: "threadDelete",
    threadUpdate: "threadUpdate",
    threadListSync: "threadListSync",
    threadMembersUpdate: "threadMembersUpdate",
    threadMemberUpdate: "threadMemberUpdate",

    threadStateUpdate: "threadStateUpdate",
    threadNameUpdate: "threadNameUpdate",
    threadLockStateUpdate: "threadLockStateUpdate",
    threadRateLimitPerUserUpdate: "threadRateLimitPerUserUpdate",
    threadAutoArchiveDurationUpdate: "threadAutoArchiveDurationUpdate",
    unhandledThreadUpdate: "unhandledThreadUpdate",

    // Typing
    typingStart: "typingStart",

    // Users
    userUpdate: "userUpdate",

    userAvatarUpdate: "userAvatarUpdate",
    userUsernameUpdate: "userUsernameUpdate",
    userDiscriminatorUpdate: "userDiscriminatorUpdate",
    userFlagsUpdate: "userFlagsUpdate",
    unhandledUserUpdate: "unhandledUserUpdate",

    // Voice
    voiceStateUpdate: "voiceStateUpdate",
    voiceChannelEffectSend: "voiceChannelEffectSend",

    voiceChannelJoin: "voiceChannelJoin",
    voiceChannelLeave: "voiceChannelLeave",
    voiceChannelSwitch: "voiceChannelSwitch",
    voiceChannelMute: "voiceChannelMute",
    voiceChannelUnmute: "voiceChannelUnmute",
    voiceChannelDeaf: "voiceChannelDeaf",
    voiceChannelUndeaf: "voiceChannelUndeaf",
    voiceStreamingStart: "voiceStreamingStart",
    voiceStreamingStop: "voiceStreamingStop",
    unhandledVoiceStateUpdate: "unhandledVoiceStateUpdate",

    // Shards
    shardDisconnect: "shardDisconnect",
    shardError: "shardError",
    shardReady: "shardReady",
    shardReconnecting: "shardReconnecting",
    shardResume: "shardResume",

    // Webhooks
    webhooksUpdate: "webhooksUpdate",
    webhookUpdate: "webhookUpdate",
} as const;

export const TIMEZONES = [
    { label: "UTC-10 (Hawaii)", value: -600 },
    { label: "UTC-9 (Alaska)", value: -540 },
    { label: "UTC-8 (Pacific)", value: -480 },
    { label: "UTC-7 (Mountain)", value: -420 },
    { label: "UTC-6 (Central)", value: -360 },
    { label: "UTC-5 (Eastern)", value: -300 },
    { label: "UTC-4 (Atlantic)", value: -240 },
    { label: "UTC-3 (Brazil)", value: -180 },
    { label: "UTC-2 (Mid-Atlantic)", value: -120 },
    { label: "UTC-1 (Cape Verde)", value: -60 },
    { label: "UTC+0 (UK)", value: 0 },
    { label: "UTC+1 (Central Europe)", value: 60 },
    { label: "UTC+2 (Eastern Europe)", value: 120 },
    { label: "UTC+3 (Moscow)", value: 180 },
    { label: "UTC+4 (UAE)", value: 240 },
    { label: "UTC+5 (Pakistan)", value: 300 },
    { label: "UTC+5:30 (India)", value: 330 },
    { label: "UTC+6 (Bangladesh)", value: 360 },
    { label: "UTC+7 (SE Asia)", value: 420 },
    { label: "UTC+8 (China)", value: 480 },
    { label: "UTC+9 (Japan)", value: 540 },
    { label: "UTC+10 (Australia East)", value: 600 },
    { label: "UTC+11 (Solomon Islands)", value: 660 },
    { label: "UTC+12 (New Zealand)", value: 720 },
    { label: "UTC+13 (Tonga)", value: 780 },
] as const;
