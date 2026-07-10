import {
  db,
  supportMessagesTable,
  supportTicketsTable,
} from "@mutualzz/database";
import type {
  APISupportMessage,
  APISupportTicket,
  APISupportTicketDetail,
} from "@mutualzz/types";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import {
  execNormalizedMany,
  postmark,
  sendSupportReplyPush,
  Snowflake,
} from "@mutualzz/util";
import {
  validateCreateSupportMessageBody,
  validateCreateSupportTicketBody,
  validateSupportTicketParams,
  validateSupportTicketsQuery,
} from "@mutualzz/validators";
import { and, asc, desc, eq, lt } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

const supportUserColumns = {
  id: true,
  username: true,
  globalName: true,
  avatar: true,
} as const;

const loadTicketDetail = async (
  ticketId: string,
): Promise<APISupportTicketDetail | null> => {
  const tickets = await execNormalizedMany<APISupportTicket>(
    db.query.supportTicketsTable.findMany({
      where: eq(supportTicketsTable.id, BigInt(ticketId)),
      limit: 1,
      with: {
        user: { columns: supportUserColumns },
        assignedTo: { columns: supportUserColumns },
      },
    }),
  );

  const ticket = tickets[0];
  if (!ticket) return null;

  const messages = await execNormalizedMany<APISupportMessage>(
    db.query.supportMessagesTable.findMany({
      where: eq(supportMessagesTable.ticketId, BigInt(ticketId)),
      orderBy: asc(supportMessagesTable.createdAt),
      with: {
        author: { columns: supportUserColumns },
      },
    }),
  );

  return { ...ticket, messages };
};

const getSupportTicketUrl = (ticketId: string) => {
  const supportDomain =
    process.env.NODE_ENV === "development"
      ? process.env.FRONTEND_URL
      : "https://mutualzz.com";
  return `${supportDomain}/support/tickets/${ticketId}`;
};

const notifyUserOfStaffReply = async (
  userId: string,
  email: string,
  ticketId: string,
  subject: string,
  messagePreview: string,
) => {
  const ticketUrl = getSupportTicketUrl(ticketId);

  void postmark
    .sendEmail({
      From: "support@mutualzz.com",
      To: email,
      Subject: `Re: ${subject}`,
      TextBody: `Support replied to your ticket "${subject}".\n\n${messagePreview}\n\nView your ticket: ${ticketUrl}`,
      MessageStream: "outbound",
    })
    .catch(() => undefined);

  void sendSupportReplyPush(userId, ticketId, subject);
};

export default class SupportController {
  static async list(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { status, before, limit } = validateSupportTicketsQuery.parse(
        req.query,
      );

      const conditions = [eq(supportTicketsTable.userId, BigInt(user.id))];
      if (status) conditions.push(eq(supportTicketsTable.status, status));
      if (before) conditions.push(lt(supportTicketsTable.id, BigInt(before)));

      const tickets = await execNormalizedMany<APISupportTicket>(
        db.query.supportTicketsTable.findMany({
          where: and(...conditions),
          orderBy: desc(supportTicketsTable.lastMessageAt),
          limit,
          with: {
            user: { columns: supportUserColumns },
            assignedTo: { columns: supportUserColumns },
          },
        }),
      );

      res.status(HttpStatusCode.Success).json(tickets);
    } catch (err) {
      next(err);
    }
  }

  static async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { category, subject, message, platform, appVersion } =
        validateCreateSupportTicketBody.parse(req.body);

      const ticketId = BigInt(Snowflake.generate());
      const messageId = BigInt(Snowflake.generate());
      const now = new Date();

      await db.transaction(async (tx) => {
        await tx.insert(supportTicketsTable).values({
          id: ticketId,
          userId: BigInt(user.id),
          category,
          subject,
          platform: platform ?? null,
          appVersion: appVersion ?? null,
          lastMessageAt: now,
        });

        await tx.insert(supportMessagesTable).values({
          id: messageId,
          ticketId,
          authorId: BigInt(user.id),
          body: message,
          isStaff: false,
        });
      });

      const ticket = await loadTicketDetail(ticketId.toString());
      if (!ticket)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to create support ticket",
        );

      res.status(HttpStatusCode.Success).json(ticket);
    } catch (err) {
      next(err);
    }
  }

  static async get(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { ticketId } = validateSupportTicketParams.parse(req.params);

      const owned = await db.query.supportTicketsTable.findFirst({
        where: and(
          eq(supportTicketsTable.id, BigInt(ticketId)),
          eq(supportTicketsTable.userId, BigInt(user.id)),
        ),
        columns: { id: true },
      });

      if (!owned)
        throw new HttpException(HttpStatusCode.NotFound, "Ticket not found");

      const ticket = await loadTicketDetail(ticketId);
      if (!ticket)
        throw new HttpException(HttpStatusCode.NotFound, "Ticket not found");

      res.status(HttpStatusCode.Success).json(ticket);
    } catch (err) {
      next(err);
    }
  }

  static async reply(req: Request, res: Response, next: NextFunction) {
    try {
      const { user } = req;

      const { ticketId } = validateSupportTicketParams.parse(req.params);
      const { message } = validateCreateSupportMessageBody.parse(req.body);

      const ticket = await db.query.supportTicketsTable.findFirst({
        where: eq(supportTicketsTable.id, BigInt(ticketId)),
      });

      if (!ticket || ticket.userId.toString() !== user.id)
        throw new HttpException(HttpStatusCode.NotFound, "Ticket not found");

      if (ticket.status === "closed" || ticket.status === "resolved")
        throw new HttpException(
          HttpStatusCode.BadRequest,
          "This ticket is closed",
        );

      const now = new Date();

      await db.transaction(async (tx) => {
        await tx.insert(supportMessagesTable).values({
          id: BigInt(Snowflake.generate()),
          ticketId: BigInt(ticketId),
          authorId: BigInt(user.id),
          body: message,
          isStaff: false,
        });

        await tx
          .update(supportTicketsTable)
          .set({
            status: "open",
            lastMessageAt: now,
            closedAt: null,
          })
          .where(eq(supportTicketsTable.id, BigInt(ticketId)));
      });

      const updated = await loadTicketDetail(ticketId);
      if (!updated)
        throw new HttpException(
          HttpStatusCode.InternalServerError,
          "Failed to update ticket",
        );

      res.status(HttpStatusCode.Success).json(updated);
    } catch (err) {
      next(err);
    }
  }
}

export { loadTicketDetail, notifyUserOfStaffReply, supportUserColumns };
