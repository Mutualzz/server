import { HttpsProxyAgent } from "https-proxy-agent";
import { fetch as undiciFetch, ProxyAgent } from "undici";

const proxyUrl = process.env.LINK_PREVIEW_PROXY;

// For url-metadata (node-fetch): tunnels both http and https via CONNECT.
export const linkPreviewAgent = proxyUrl
  ? new HttpsProxyAgent(proxyUrl)
  : undefined;

const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

interface LinkPreviewInit {
  method?: string;
  redirect?: "follow" | "manual" | "error";
}

// For plain fetches of user-posted URLs (HEAD checks).
export const linkPreviewFetch = (url: string, init: LinkPreviewInit = {}) =>
  dispatcher ? undiciFetch(url, { ...init, dispatcher }) : fetch(url, init);
