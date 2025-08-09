export const JSONReplacer = function (
    this: Record<string, unknown>,
    key: string,
    value: unknown,
) {
    if (this[key] instanceof Date) {
        return this[key].toISOString().replace("Z", "+00:00");
    }

    // erlpack encoding doesn't call json.stringify,
    // so our toJSON functions don't get called.
    // manually call it here
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    //@ts-ignore
    if (this[key]?.toJSON)
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        //@ts-ignore
        this[key] = this[key].toJSON();

    return value;
};
