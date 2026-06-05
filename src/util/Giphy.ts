import { GiphyFetch } from "@giphy/js-fetch-api";

if (!process.env.GIPHY_API_KEY)
    throw new Error("Missing environment variable `GIPHY_API_KEY`");

export const gf = new GiphyFetch(process.env.GIPHY_API_KEY!);
