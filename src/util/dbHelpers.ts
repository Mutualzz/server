import { normalizeJSON } from "@mutualzz/util";

export async function execNormalized<T = any>(
    promise: Promise<any>,
): Promise<T | null> {
    const result = await promise.catch((err) => {
        console.error(err);
        return null;
    });
    return normalizeJSON(result) as T | null;
}

export async function execNormalizedMany<T = any>(
    promise: Promise<any>,
): Promise<T[]> {
    const result = await promise.catch((err) => {
        console.error(err);
        return null;
    });
    return (result ? normalizeJSON(result) : []) as T[];
}
