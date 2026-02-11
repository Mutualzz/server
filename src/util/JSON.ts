export const JSONReplacer = function (
    this: Record<string, unknown>,
    key: string,
    value: unknown,
) {
    if (key === "hash") return undefined;

    // Date → ISO string
    if (value instanceof Date) {
        return value.toISOString().replace("Z", "+00:00");
    }

    // Handle objects with custom .toJSON
    // erlpack doesn't use JSON.stringify so force it manually
    // @ts-expect-error doesnt exist on certain but can exist
    if (value?.toJSON) {
        //@ts-expect-error doesnt exist on certain but can exist
        return value.toJSON();
    }

    return value;
};

export const normalizeJSON = <T>(obj: T): T => {
    if (obj === null || obj === undefined) return obj as any;
    return JSON.parse(JSON.stringify(obj, JSONReplacer));
};
