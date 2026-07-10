import { db, invitesTable, spaceMembersTable } from "@mutualzz/database";
import type { APICodedLink, APICodedLinkInput, APIInvite } from "@mutualzz/types";
import { InviteType } from "@mutualzz/types";
import { execNormalized, publicUserColumns } from "@mutualzz/util";
import { count, eq } from "drizzle-orm";

const INVITE_CODE_PATTERN = "[A-Za-z0-9_-]{8,}";

export const inviteUrlPattern = new RegExp(
  `(?:https?:\\/\\/)?(?:www\\.)?(?:mutualzz\\.com|localhost:\\d+)\\/invite\\/(${INVITE_CODE_PATTERN})|` +
    `mutualzz:\\/\\/invite\\/(${INVITE_CODE_PATTERN})`,
  "gi",
);

export function extractInviteCodesFromContent(content: string): string[] {
  const codes = new Set<string>();

  for (const match of content.matchAll(inviteUrlPattern)) {
    const code = match[1] ?? match[2];
    if (code) codes.add(code);
  }

  return [...codes];
}

export function stripInviteUrlsFromContent(
  content: string | null | undefined,
  embeddedCodes: Iterable<string>,
): string | null {
  if (!content) return content ?? null;

  let result = content;
  for (const code of embeddedCodes) {
    const codePattern = new RegExp(
      `(?:https?:\\/\\/)?(?:www\\.)?(?:mutualzz\\.com|localhost:\\d+)\\/invite\\/${code}|` +
        `mutualzz:\\/\\/invite\\/${code}`,
      "gi",
    );
    result = result.replace(codePattern, "");
  }

  result = result.replace(/\s{2,}/g, " ").trim();
  return result.length > 0 ? result : null;
}

export async function mergeCodedLinksFromContent(
  content: string | null | undefined,
  explicitLinks: APICodedLinkInput[],
): Promise<APICodedLinkInput[]> {
  const merged = [...explicitLinks];
  const seen = new Set(explicitLinks.map((link) => link.code));

  for (const code of extractInviteCodesFromContent(content ?? "")) {
    if (seen.has(code)) continue;

    const invite = await execNormalized<APIInvite>(
      db.query.invitesTable.findFirst({
        columns: { code: true, type: true, expiresAt: true },
        where: eq(invitesTable.code, code),
      }),
    );

    if (!invite) continue;
    if (invite.expiresAt && new Date(invite.expiresAt) <= new Date()) continue;

    merged.push({
      type: invite.type as InviteType.Space | InviteType.Friend,
      code: invite.code,
    });
    seen.add(code);
  }

  return merged;
}

async function hydrateSpaceCodedLink(
  link: APICodedLinkInput,
): Promise<APICodedLink | null> {
  const invite = await execNormalized<APIInvite>(
    db.query.invitesTable.findFirst({
      with: {
        space: true,
        channel: { columns: { id: true, name: true, type: true } },
        inviter: { columns: publicUserColumns },
      },
      where: eq(invitesTable.code, link.code),
    }),
  );

  if (!invite || invite.type !== InviteType.Space) return null;
  if (invite.expiresAt && new Date(invite.expiresAt) <= new Date()) return null;

  let approximateMemberCount: number | null = null;

  if (invite.spaceId) {
    approximateMemberCount = await db
      .select({ count: count() })
      .from(spaceMembersTable)
      .where(eq(spaceMembersTable.spaceId, BigInt(invite.spaceId)))
      .then((rows) => rows[0]?.count ?? 0);
  }

  return {
    type: InviteType.Space,
    code: invite.code,
    space: invite.space
      ? {
          id: invite.space.id,
          name: invite.space.name,
          icon: invite.space.icon,
          description: invite.space.description,
        }
      : null,
    channel: invite.channel,
    inviter: invite.inviter,
    approximateMemberCount,
    approximatePresenceCount: invite.approximateActiveCount ?? null,
    expiresAt: invite.expiresAt,
  };
}

async function hydrateFriendCodedLink(
  link: APICodedLinkInput,
): Promise<APICodedLink | null> {
  const invite = await execNormalized<APIInvite>(
    db.query.invitesTable.findFirst({
      with: {
        user: { columns: publicUserColumns },
        inviter: { columns: publicUserColumns },
      },
      where: eq(invitesTable.code, link.code),
    }),
  );

  if (!invite || invite.type !== InviteType.Friend) return null;
  if (invite.expiresAt && new Date(invite.expiresAt) <= new Date()) return null;

  return {
    type: InviteType.Friend,
    code: invite.code,
    user: invite.user ?? invite.inviter,
    inviter: invite.inviter,
    expiresAt: invite.expiresAt,
  };
}

export async function hydrateCodedLinks(
  links: APICodedLinkInput[],
): Promise<APICodedLink[]> {
  const hydrated: APICodedLink[] = [];

  for (const link of links) {
    const result =
      link.type === InviteType.Space
        ? await hydrateSpaceCodedLink(link)
        : link.type === InviteType.Friend
          ? await hydrateFriendCodedLink(link)
          : null;

    if (result) hydrated.push(result);
  }

  return hydrated;
}

export async function resolveMessageCodedLinks(
  content: string | null | undefined,
  explicitLinks: APICodedLinkInput[],
): Promise<{ codedLinks: APICodedLink[]; content: string | null }> {
  const merged = await mergeCodedLinksFromContent(content, explicitLinks);
  const codedLinks = await hydrateCodedLinks(merged);
  const strippedContent = stripInviteUrlsFromContent(
    content,
    codedLinks.map((link) => link.code),
  );

  return {
    codedLinks,
    content: strippedContent,
  };
}

export function contentHasInviteLinks(content: string | null | undefined) {
  return extractInviteCodesFromContent(content ?? "").length > 0;
}
