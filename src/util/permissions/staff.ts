import { BitField, userFlags } from "@mutualzz/bitfield";
import { HttpException, HttpStatusCode, type APIPrivateUser } from "@mutualzz/types";

export const isFounder = (user: APIPrivateUser) =>
    BitField.fromString(userFlags, user.flags.toString()).has("Founder");

// Founders are implicitly staff — they can do everything Staff can, plus
// grant/revoke flags (see requireFounder).
export const isStaff = (user: APIPrivateUser) =>
    BitField.fromString(userFlags, user.flags.toString()).has("Staff") ||
    isFounder(user);

export const requireStaff = (user?: APIPrivateUser | null) => {
    if (!user)
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");

    if (!isStaff(user))
        throw new HttpException(HttpStatusCode.Forbidden, "Missing access");

    return user;
};

export const requireFounder = (user?: APIPrivateUser | null) => {
    if (!user)
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");

    if (!isFounder(user))
        throw new HttpException(HttpStatusCode.Forbidden, "Missing access");

    return user;
};
