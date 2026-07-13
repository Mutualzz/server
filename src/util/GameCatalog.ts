import { readFile } from "node:fs/promises";
import path from "node:path";

export interface GameCatalogEntry {
  id: string;
  name: string;
  exes: string[];
  iconHash?: string;
}

export interface GameCatalogFile {
  updatedAt: number;
  source?: string;
  games: GameCatalogEntry[];
}

const EMPTY: GameCatalogFile = {
  updatedAt: 0,
  source: "empty",
  games: [],
};

let cached: GameCatalogFile | null = null;
let etag: string | null = null;

const catalogPath = path.join(
  import.meta.dirname,
  "../../../data/game-catalog.json",
);

function computeEtag(catalog: GameCatalogFile) {
  return `"${catalog.updatedAt}-${catalog.games.length}"`;
}

function parseCatalog(raw: unknown): GameCatalogFile | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (!Array.isArray(data.games)) return null;

  const games: GameCatalogEntry[] = [];
  for (const row of data.games) {
    if (!row || typeof row !== "object") continue;
    const game = row as Record<string, unknown>;
    if (typeof game.id !== "string" || typeof game.name !== "string") continue;
    if (!Array.isArray(game.exes) || game.exes.length === 0) continue;

    const exes = game.exes
      .filter((exe): exe is string => typeof exe === "string")
      .map((exe) => exe.trim().toLowerCase())
      .filter(Boolean);
    if (!exes.length) continue;

    games.push({
      id: game.id,
      name: game.name,
      exes,
      ...(typeof game.iconHash === "string" ? { iconHash: game.iconHash } : {}),
    });
  }

  return {
    updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : Date.now(),
    source:
      typeof data.source === "string" ? data.source : "game-catalog.json",
    games,
  };
}

export async function loadGameCatalog(force = false): Promise<GameCatalogFile> {
  if (cached && !force) return cached;

  try {
    const raw = await readFile(catalogPath, "utf8");
    const parsed = parseCatalog(JSON.parse(raw));
    cached = parsed ?? EMPTY;
    etag = computeEtag(cached);
    return cached;
  } catch {
    cached = EMPTY;
    etag = computeEtag(EMPTY);
    return cached;
  }
}

export function getGameCatalogEtag() {
  return etag;
}

export function getGameCatalogPublic(catalog: GameCatalogFile) {
  return {
    updatedAt: catalog.updatedAt,
    games: catalog.games.map(({ id, name, exes }) => ({ id, name, exes })),
  };
}

export async function findGameByName(name: string): Promise<GameCatalogEntry | null> {
  const catalog = await loadGameCatalog();
  const key = name.trim().toLowerCase();
  if (!key) return null;
  return (
    catalog.games.find((game) => game.name.trim().toLowerCase() === key) ?? null
  );
}
