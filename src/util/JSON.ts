export const JSONReplacer = function (
    this: Record<string, unknown>,
    key: string,
    value: unknown,
) {
    if (key === "hash") return undefined;

    // Date → ISO string
    if (this[key] instanceof Date) {
        return this[key].toISOString().replace("Z", "+00:00");
    }

    if (typeof this[key] === "bigint") {
        return this[key].toString();
    }

    if (this[key] === "null") return null;
    if (this[key] === "false") return false;
    if (this[key] === "true") return true;

    // Handle objects with custom .toJSON
    // erlpack doesn't use JSON.stringify so force it manually
    //@ts-ignore
    if (this[key]?.toJSON) this[key] = this[key].toJSON();

    return value;
};

export const normalizeJSON = <T>(obj: T): T => {
    if (obj === null || obj === undefined) return obj as any;
    return JSON.parse(JSON.stringify(obj, JSONReplacer));
};
