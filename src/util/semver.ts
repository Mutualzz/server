export const parseSemver = (
  version: string,
): [number, number, number] | null => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

export const semverGte = (a: string, b: string): boolean => {
  const parsedA = parseSemver(a);
  const parsedB = parseSemver(b);
  if (!parsedA || !parsedB) return false;

  for (let i = 0; i < 3; i++) {
    if (parsedA[i]! > parsedB[i]!) return true;
    if (parsedA[i]! < parsedB[i]!) return false;
  }

  return true;
};
