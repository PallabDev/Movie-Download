import dotenv from "dotenv";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

dotenv.config({ quiet: true });

const envTxtPath = resolve(process.cwd(), "env.txt");
if (existsSync(envTxtPath)) {
    const lines = readFileSync(envTxtPath, "utf-8").split("\n");
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) {
            process.env[key] = value;
        }
    }
}

const envSchema = z.object({
    TG_API_ID: z.coerce.number().int().positive(),
    TG_API_HASH: z.string().min(1),
    AI_BASE_URL: z.string().url().default("https://aicredits.in/v1"),
    AI_API_KEY: z.string().min(1),
    AI_MODEL: z.string().min(1).default("xiaomi/mimo-v2.5"),
    MOVIE_BOT: z.string().default("@ProSearchM11Bot"),
    SERIES_BOT: z.string().default("@ProSearchY11Bot"),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().min(1),
    JELLYFIN_URL: z.string().default(""),
    JELLYFIN_TOKEN: z.string().default(""),
    JWT_SECRET: z.string().min(8).default("dev-secret-change-me"),
    TMDB_API_KEY: z.string().optional().default(""),
    TMDB_API_READ_ACCESS_TOKEN: z.string().optional().default(""),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
