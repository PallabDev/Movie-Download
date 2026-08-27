import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ quiet: true });

// Validate required environment variables and expose typed values.

const envSchema = z.object({
    TG_API_ID: z.coerce.number().int().positive(),
    TG_API_HASH: z.string().min(1),
});


export const env = envSchema.parse(process.env);

export type Env = z.infer<typeof envSchema>;
