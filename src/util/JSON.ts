export const JSONReplacer = function (
    this: Record<string, unknown>,
    key: string,
    value: unknown,
) {
    if (this[key] instanceof Date) {
        return this[key].toISOString().replace("Z", "+00:00");
    }

    if (typeof this[key] === "bigint") {
        return this[key].toString();
    }

    // erlpack encoding doesn't call json.stringify,
    // so our toJSON functions don't get called.
    // manually call it here
    //@ts-ignore
    if (this[key]?.toJSON)
        //@ts-ignore
        this[key] = this[key].toJSON();

    return value;
};
