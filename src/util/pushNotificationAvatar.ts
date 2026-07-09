import { CDNRoutes, ImageFormat } from "@mutualzz/types";

export interface PushAuthorAvatar {
  id: string;
  avatar?: string | null;
  defaultAvatar: {
    type: number;
  };
}

export function buildAuthorAvatarUrl(
  author: PushAuthorAvatar,
): string | undefined {
  const cdnBase = process.env.CDN_URL?.trim();
  if (!cdnBase) return undefined;

  const path = author.avatar
    ? CDNRoutes.userAvatar(
        author.id,
        author.avatar,
        ImageFormat.PNG,
        128,
        false,
      )
    : CDNRoutes.defaultUserAvatar(
        author.defaultAvatar.type,
        "light",
        128,
        ImageFormat.PNG,
      );

  const base = cdnBase.replace(/\/+$/, "");
  const normalizedPath = path.replace(/^\/+/, "");
  return `${base}/${normalizedPath}`;
}
