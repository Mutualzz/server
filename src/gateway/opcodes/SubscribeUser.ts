import { listenEvent } from "@mutualzz/util";
import { GatewayOpcodes, type GatewayPayload } from "@mutualzz/types";
import type { WebSocket } from "../util/WebSocket";
import { consume } from "../Listener";

export async function onSubscribeUser(
    this: WebSocket,
    { d }: GatewayPayload,
) {
    const userId = String(d?.userId ?? "");
    if (!userId) return;

    this.userSubscriptions = this.userSubscriptions ?? {};

    if (this.userSubscriptions[userId]) return;

    // The connection already listens on the authenticated user's exchange.
    if (this.events?.[userId]) return;

    if (!this.listenOptions?.channel) {
        return;
    }

    this.userSubscriptions[userId] = await listenEvent(
        userId,
        consume.bind(this),
        this.listenOptions,
    );
}

export async function onUnsubscribeUser(
    this: WebSocket,
    { d }: GatewayPayload,
) {
    const userId = String(d?.userId ?? "");
    if (!userId) return;

    this.userSubscriptions?.[userId]?.();
    delete this.userSubscriptions?.[userId];
}

export const subscribeUserOpcode = GatewayOpcodes.SubscribeUser;
export const unsubscribeUserOpcode = GatewayOpcodes.UnsubscribeUser;
