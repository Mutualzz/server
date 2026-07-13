import { BitField, userFlags } from "@mutualzz/bitfield";
import { HttpException, HttpStatusCode, type APIPrivateUser } from "@mutualzz/types";

type UserWithFlags = { flags: string | number | bigint };

export const isFounder = (user: UserWithFlags) =>
    BitField.fromString(userFlags, user.flags.toString()).has("Founder");

export const isDeveloper = (user: UserWithFlags) =>
    BitField.fromString(userFlags, user.flags.toString()).has("Developer") ||
    isFounder(user);

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

export const requireDeveloper = (user?: APIPrivateUser | null) => {
    if (!user)
        throw new HttpException(HttpStatusCode.Unauthorized, "Unauthorized");

    if (!isDeveloper(user))
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

export const assertNotFounderTarget = (
    actor: UserWithFlags,
    target: UserWithFlags,
) => {
    if (isFounder(target) && !isFounder(actor))
        throw new HttpException(
            HttpStatusCode.Forbidden,
            "Cannot perform this action on a founder account",
        );
};
