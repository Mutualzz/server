import type { User } from "@mutualzz/types";

declare global {
    namespace Express {
        interface Request {
            user?: Partial<User> & { token: string };
        }
    }
}
