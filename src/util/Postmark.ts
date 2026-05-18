import { ServerClient } from "postmark";

if (!process.env.POSTMARK_API_KEY)
    throw new Error("No postmark API key configured");

export const postmark = new ServerClient(process.env.POSTMARK_API_KEY);
