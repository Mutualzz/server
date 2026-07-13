import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(root, ".env") });

const DISCORD_DETECTABLE_URL =
  "https://discord.com/api/v10/applications/detectable";
const catalogPath = join(root, "data/game-catalog.json");
const assetsDir = join(root, "assets/app-icons");

const args = new Set(process.argv.slice(2));
const withIcons = args.has("--icons");
const forceIcons = args.has("--force-icons");
const dryRun = args.has("--dry-run");

function basenameExe(raw) {
  const name = String(raw || "")
    .split(/[/\\]/)
    .pop()
    ?.trim()
    .toLowerCase();
  if (!name || !name.endsWith(".exe")) return null;
  if (name.startsWith(">") || name.startsWith("<")) return null;
  return name;
}

function buildCatalog(apps) {
  const claimed = new Map();
  const games = [];

  for (const app of apps) {
    const id = app?.id != null ? String(app.id) : "";
    const name = typeof app?.name === "string" ? app.name.trim() : "";
    if (!id || !name) continue;

    const iconHash =
      (typeof app.icon_hash === "string" && app.icon_hash) ||
      (typeof app.icon === "string" && app.icon) ||
      null;

    const exes = [];
    for (const exe of app.executables || []) {
      if (exe?.is_launcher) continue;
      if (exe?.os && exe.os !== "win32") continue;
      const key = basenameExe(exe?.name);
      if (!key) continue;
      if (claimed.has(key)) continue;
      claimed.set(key, id);
      exes.push(key);
    }

    if (!exes.length) continue;

    games.push({
      id,
      name,
      exes,
      ...(iconHash ? { iconHash } : {})
    });
  }

  games.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return {
    updatedAt: Date.now(),
    source: "discord:applications/detectable",
    games
  };
}

const s3Enabled = Boolean(
  process.env.AWS_BUCKET &&
    process.env.AWS_ACCESS_KEY &&
    process.env.AWS_ACCESS_SECRET
);

const s3Client = s3Enabled
  ? new S3Client({
      region: "auto",
      credentials: {
        accountId: process.env.AWS_ACCOUNT_ID,
        accessKeyId: process.env.AWS_ACCESS_KEY,
        secretAccessKey: process.env.AWS_ACCESS_SECRET
      },
      endpoint: process.env.AWS_ENDPOINT
    })
  : null;

async function s3ObjectExists(key) {
  if (!s3Client || !process.env.AWS_BUCKET) return false;
  try {
    await s3Client.send(
      new HeadObjectCommand({
        Bucket: process.env.AWS_BUCKET,
        Key: key
      })
    );
    return true;
  } catch {
    return false;
  }
}

async function uploadIcon(id, iconHash) {
  const key = `app-icons/${id}.png`;
  if (!forceIcons && (await s3ObjectExists(key))) {
    return "skipped";
  }

  const url = `https://cdn.discordapp.com/app-icons/${id}/${iconHash}.png?size=128`;
  const res = await fetch(url);
  if (!res.ok) return `failed:${res.status}`;

  const buffer = Buffer.from(await res.arrayBuffer());
  await mkdir(assetsDir, { recursive: true });
  await writeFile(join(assetsDir, `${id}.png`), buffer);

  if (s3Client && process.env.AWS_BUCKET) {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: "image/png",
        CacheControl: "public, max-age=31536000, immutable"
      })
    );
  }

  return "uploaded";
}

const res = await fetch(DISCORD_DETECTABLE_URL);
if (!res.ok) throw new Error(`discord detectable failed: ${res.status}`);
const apps = await res.json();
if (!Array.isArray(apps)) throw new Error("discord detectable returned non-array");

const catalog = buildCatalog(apps);
console.log(
  `catalog: ${catalog.games.length} games (${apps.length} discord apps)`
);

if (!dryRun) {
  await mkdir(dirname(catalogPath), { recursive: true });
  await writeFile(catalogPath, `${JSON.stringify(catalog)}\n`);
  console.log(`wrote ${catalogPath}`);
} else {
  console.log("dry-run: skipped writing catalog");
}

if (!withIcons) {
  console.log("icons skipped (pass --icons to download/upload)");
  process.exit(0);
}

if (!s3Enabled) {
  console.warn("AWS env not configured; icons will only be saved locally");
}

let uploaded = 0;
let skipped = 0;
let failed = 0;
const withHash = catalog.games.filter((g) => g.iconHash);

for (let i = 0; i < withHash.length; i++) {
  const game = withHash[i];
  if (dryRun) {
    skipped++;
    continue;
  }

  try {
    const result = await uploadIcon(game.id, game.iconHash);
    if (result === "uploaded") uploaded++;
    else if (result === "skipped") skipped++;
    else {
      failed++;
      console.warn(`icon ${game.id} (${game.name}): ${result}`);
    }
  } catch (err) {
    failed++;
    console.warn(`icon ${game.id} (${game.name}):`, err?.message || err);
  }

  if ((i + 1) % 250 === 0 || i === withHash.length - 1) {
    console.log(
      `icons ${i + 1}/${withHash.length} (uploaded=${uploaded} skipped=${skipped} failed=${failed})`
    );
  }
}

console.log(
  `done icons: uploaded=${uploaded} skipped=${skipped} failed=${failed}`
);
