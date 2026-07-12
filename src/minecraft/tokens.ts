import { createHash, randomBytes } from "node:crypto";

const TOKEN_PREFIX = "mz_bridge_";
const DEFAULT_MC_BRIDGE_PORT = process.env.MC_BRIDGE_PORT || 3015;

/** Production Mutualzz Minecraft bridge. */
export const MINECRAFT_BRIDGE_HUB_URL = "wss://bridge.mutualzz.com";

export const hashBridgeToken = (plaintext: string) =>
  createHash("sha256").update(plaintext).digest("hex");

/** Create a plaintext plugin token. Store only the hash in the DB. */
export const generateBridgeToken = () => {
  const secret = randomBytes(24).toString("base64url");
  const plaintext = `${TOKEN_PREFIX}${secret}`;
  return {
    plaintext,
    tokenHash: hashBridgeToken(plaintext),
    tokenPrefix: plaintext.slice(0, 16),
  };
};

export const generateLinkCode = (length = 6) => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length);
  let code = "";
  for (let i = 0; i < length; i++) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return code;
};

export const getMinecraftBridgeHubUrl = () => {
  if (process.env.MC_BRIDGE_HUB_URL?.trim())
    return process.env.MC_BRIDGE_HUB_URL.trim().replace(/\/$/, "");

  // Local unless explicitly production (covers nodemon + bare `pnpm start` without NODE_ENV)
  if (process.env.NODE_ENV !== "production") {
    const port = process.env.MC_BRIDGE_PORT || DEFAULT_MC_BRIDGE_PORT;
    return `ws://127.0.0.1:${port}`;
  }
  return MINECRAFT_BRIDGE_HUB_URL;
};

export const buildPluginConfig = (token: string, serverId?: string) => ({
  hubUrl: getMinecraftBridgeHubUrl(),
  token,
  serverId: serverId || "<yourServerId>",
});
