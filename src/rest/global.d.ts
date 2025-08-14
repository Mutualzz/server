import type { APIUser } from "@mutualzz/types";

declare global {
    namespace Express {
        interface Request {
            user?: APIUser & { token: string };
        }
    }
}
