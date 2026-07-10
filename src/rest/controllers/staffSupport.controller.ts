import {
    db,
    supportMessagesTable,
    supportTicketsTable,
} from "@mutualzz/database";
import type { APISupportTicket } from "@mutualzz/types";
import { HttpException, HttpStatusCode } from "@mutualzz/types";
import {
    execNormalizedMany,
    getUser,
    isStaff,
    requireStaff,
    Snowflake,
} from "@mutualzz/util";
import {
    validateCreateSupportMessageBody,
    validateStaffSupportTicketUpdateBody,
    validateStaffSupportTicketsQuery,
    validateSupportTicketParams,
} from "@mutualzz/validators";
import { and, desc, eq, lt } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import {
    loadTicketDetail,
    notifyUserOfStaffReply,
    supportUserColumns,
} from "./support.controller.ts";

export default class StaffSupportController {
    static async list(req: Request, res: Response, next: NextFunction) {
        try {
            requireStaff(req.user);

            const { status, category, before, limit } =
                validateStaffSupportTicketsQuery.parse(req.query);

            const conditions = [];
            if (status) conditions.push(eq(supportTicketsTable.status, status));
            if (category)
                conditions.push(eq(supportTicketsTable.category, category));
            if (before) conditions.push(lt(supportTicketsTable.id, BigInt(before)));

            const tickets = await execNormalizedMany<APISupportTicket>(
                db.query.supportTicketsTable.findMany({
                    where: conditions.length ? and(...conditions) : undefined,
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

    static async get(req: Request, res: Response, next: NextFunction) {
        try {
            requireStaff(req.user);

            const { ticketId } = validateSupportTicketParams.parse(req.params);
            const ticket = await loadTicketDetail(ticketId);

            if (!ticket)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Ticket not found",
                );

            res.status(HttpStatusCode.Success).json(ticket);
        } catch (err) {
            next(err);
        }
    }

    static async update(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = requireStaff(req.user);
            const { ticketId } = validateSupportTicketParams.parse(req.params);
            const { status, assignedToId } =
                validateStaffSupportTicketUpdateBody.parse(req.body);

            const existing = await db.query.supportTicketsTable.findFirst({
                where: eq(supportTicketsTable.id, BigInt(ticketId)),
            });

            if (!existing)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Ticket not found",
                );

            if (assignedToId !== undefined && assignedToId !== null) {
                const assignee = await getUser(assignedToId, true);
                if (!assignee || !isStaff(assignee))
                    throw new HttpException(
                        HttpStatusCode.BadRequest,
                        "Assigned user must be staff",
                    );
            }

            const closedAt =
                status === "closed" || status === "resolved"
                    ? new Date()
                    : status
                      ? null
                      : undefined;

            await db
                .update(supportTicketsTable)
                .set({
                    ...(status ? { status } : {}),
                    ...(assignedToId !== undefined
                        ? {
                              assignedToId: assignedToId
                                  ? BigInt(assignedToId)
                                  : null,
                          }
                        : {}),
                    ...(closedAt !== undefined ? { closedAt } : {}),
                })
                .where(eq(supportTicketsTable.id, BigInt(ticketId)));

            const ticket = await loadTicketDetail(ticketId);
            if (!ticket)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Ticket not found",
                );

            res.status(HttpStatusCode.Success).json(ticket);
        } catch (err) {
            next(err);
        }
    }

    static async reply(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = requireStaff(req.user);
            const { ticketId } = validateSupportTicketParams.parse(req.params);
            const { message } = validateCreateSupportMessageBody.parse(req.body);

            const ticket = await db.query.supportTicketsTable.findFirst({
                where: eq(supportTicketsTable.id, BigInt(ticketId)),
                with: {
                    user: {
                        columns: {
                            id: true,
                            email: true,
                        },
                    },
                },
            });

            if (!ticket)
                throw new HttpException(
                    HttpStatusCode.NotFound,
                    "Ticket not found",
                );

            const now = new Date();

            await db.transaction(async (tx) => {
                await tx.insert(supportMessagesTable).values({
                    id: BigInt(Snowflake.generate()),
                    ticketId: BigInt(ticketId),
                    authorId: BigInt(actor.id),
                    body: message,
                    isStaff: true,
                });

                await tx
                    .update(supportTicketsTable)
                    .set({
                        status: "awaiting_reply",
                        assignedToId: BigInt(actor.id),
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

            void notifyUserOfStaffReply(
                ticket.userId.toString(),
                ticket.user.email,
                ticketId,
                ticket.subject,
                message,
            );

            res.status(HttpStatusCode.Success).json(updated);
        } catch (err) {
            next(err);
        }
    }
}
