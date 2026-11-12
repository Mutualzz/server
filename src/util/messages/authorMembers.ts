import { db, spaceMembersTable } from "@mutualzz/database";
import type { APIMessage, APISpaceMember, Snowflake } from "@mutualzz/types";
import { and, eq, inArray } from "drizzle-orm";
import { execNormalizedMany } from "../dbHelpers";
import { publicUserColumns } from "../Helpers";

type MessageWithReply = Pick<
  APIMessage,
  "spaceId" | "authorId" | "member" | "repliedTo"
>;

function collectAuthors(
  message: MessageWithReply,
  authorsBySpace: Map<Snowflake, Set<Snowflake>>,
) {
  if (message.spaceId && message.authorId) {
    const spaceId = String(message.spaceId);
    const authors = authorsBySpace.get(spaceId) ?? new Set<Snowflake>();
    authors.add(String(message.authorId));
    authorsBySpace.set(spaceId, authors);
  }

  if (message.repliedTo) collectAuthors(message.repliedTo, authorsBySpace);
}

function withMember<T extends MessageWithReply>(
  message: T,
  membersBySpace: Map<Snowflake, Map<Snowflake, APISpaceMember>>,
): T {
  const member =
    message.spaceId && message.authorId
      ? membersBySpace
          .get(String(message.spaceId))
          ?.get(String(message.authorId))
      : undefined;

  return {
    ...message,
    member: member ?? message.member ?? null,
    repliedTo: message.repliedTo
      ? withMember(message.repliedTo, membersBySpace)
      : message.repliedTo,
  };
}

export async function attachAuthorMembers<T extends MessageWithReply>(
  messages: T[],
): Promise<T[]> {
  const authorsBySpace = new Map<Snowflake, Set<Snowflake>>();
  for (const message of messages) collectAuthors(message, authorsBySpace);
  if (!authorsBySpace.size) return messages;

  const membersBySpace = new Map<Snowflake, Map<Snowflake, APISpaceMember>>();

  await Promise.all(
    [...authorsBySpace].map(async ([spaceId, authorIds]) => {
      const members = await execNormalizedMany<APISpaceMember>(
        db.query.spaceMembersTable.findMany({
          where: and(
            eq(spaceMembersTable.spaceId, BigInt(spaceId)),
            inArray(spaceMembersTable.userId, [...authorIds].map(BigInt)),
          ),
          with: {
            user: { columns: publicUserColumns },
            roles: true,
          },
        }),
      );

      membersBySpace.set(
        spaceId,
        new Map(
          (members ?? []).map((member) => [String(member.userId), member]),
        ),
      );
    }),
  );

  return messages.map((message) => withMember(message, membersBySpace));
}
