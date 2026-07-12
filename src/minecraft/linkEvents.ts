import { emitEvent, fireAndForget } from "@mutualzz/util";

export type MinecraftLinkEventPayload = {
  minecraftUuid: string;
  minecraftName: string;
  discordId: string | null;
  createdAt: Date | string;
} | null;

export const emitMinecraftLinkUpdate = (
  userId: string | bigint,
  link: MinecraftLinkEventPayload,
) => {
  fireAndForget(() =>
    emitEvent({
      event: "MinecraftLinkUpdate",
      user_id: userId.toString(),
      data: link,
    }),
  );
};
