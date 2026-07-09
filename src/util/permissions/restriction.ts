import { HttpException, HttpStatusCode, type APIPrivateUser } from "@mutualzz/types";

export const isRestricted = (user: APIPrivateUser) =>
    !!user.restrictedUntil && new Date(user.restrictedUntil) > new Date();

export const requireNotRestricted = (user: APIPrivateUser) => {
    if (isRestricted(user))
        throw new HttpException(
            HttpStatusCode.Forbidden,
            `You're temporarily restricted from posting until ${new Date(
                user.restrictedUntil as Date,
            ).toLocaleString()}`,
        );
};
