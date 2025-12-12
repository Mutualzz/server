import type { APIPrivateUser } from "@mutualzz/types";
declare global {
    namespace Express {
        interface Request {
            user?: APIPrivateUser;
        }
    }
}
