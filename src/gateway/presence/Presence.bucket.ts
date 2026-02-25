import type { WebSocket } from "../util/WebSocket.ts";

export class PresenceBucket {
    private static sockets = new Set<WebSocket>();

    static add(socket: WebSocket) {
        this.sockets.add(socket);
    }

    static remove(socket: WebSocket) {
        this.sockets.delete(socket);
    }

    static authenticatedSockets(): WebSocket[] {
        const out: WebSocket[] = [];
        for (const ws of this.sockets) {
            if (ws.userId) out.push(ws);
        }
        return out;
    }

    static socketsByUserId(userId: string): WebSocket[] {
        const out: WebSocket[] = [];
        for (const ws of this.sockets) {
            if (ws.userId === userId) out.push(ws);
        }
        return out;
    }

    static hasAnyAuthenticatedSocket(userId: string): boolean {
        for (const ws of this.sockets) {
            if (ws.userId === userId) return true;
        }
        return false;
    }

    static socketsSeeingUser(userId: string): WebSocket[] {
        const out: WebSocket[] = [];
        for (const ws of this.sockets) {
            if (!ws.userId) continue;
            const visibility = ws.presences;
            if (!visibility) continue;

            for (const set of visibility.values()) {
                if (set.has(userId)) {
                    out.push(ws);
                    break;
                }
            }
        }
        return out;
    }
}
