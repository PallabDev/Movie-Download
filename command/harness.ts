import OpenAI from "openai";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");

export interface HarnessConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

function readMd(name: string): string {
    const p = resolve(ROOT, name);
    if (!existsSync(p)) return "";
    return readFileSync(p, "utf-8");
}

function writeMd(name: string, content: string) {
    writeFileSync(resolve(ROOT, name), content, "utf-8");
}

function appendMd(name: string, content: string) {
    appendFileSync(resolve(ROOT, name), content, "utf-8");
}

export class Harness {
    private client: OpenAI;
    private model: string;

    constructor(config: HarnessConfig) {
        this.client = new OpenAI({
            baseURL: config.baseUrl,
            apiKey: config.apiKey,
        });
        this.model = config.model;
    }

    getMemory(): string {
        return readMd("memory.md");
    }

    getErrors(): string {
        return readMd("error.md");
    }

    getLogs(): string {
        return readMd("logs.md");
    }

    getMovieInfo(): string {
        return readMd("movie.md");
    }

    updateMemory(content: string) {
        writeMd("memory.md", content);
    }

    appendMemory(entry: string) {
        appendMd("memory.md", `\n${entry}`);
    }

    logError(entry: string) {
        appendMd("error.md", `\n## Error [${new Date().toISOString()}]\n${entry}\n`);
    }

    logActivity(entry: string) {
        appendMd("logs.md", `\n[${new Date().toISOString()}] ${entry}`);
    }

    updateMovieInfo(content: string) {
        writeMd("movie.md", content);
    }

    appendMovieInfo(entry: string) {
        appendMd("movie.md", `\n${entry}`);
    }

    async chat(messages: ChatMessage[]): Promise<string> {
        const memory = this.getMemory();
        const errors = this.getErrors();
        const movieInfo = this.getMovieInfo();

        const systemMessage: ChatMessage = {
            role: "system",
            content: `You are an AI automation tool for downloading movies and series via Telegram bots.

MEMORY:
${memory}

RECENT ERRORS:
${errors.slice(-500)}

MOVIE INFO:
${movieInfo}

You have access to:
- @ProSearchM11Bot for movies
- @ProSearchY11Bot for series

When a user requests a movie/series:
1. Determine if it's a movie or series
2. Clean the name to Title Case with year (e.g., "Bahubali 2 2017")
3. For series, determine how many seasons/episodes exist
4. Generate the correct search queries
5. Always prefer 720p quality
6. Update memory.md and movie.md with your findings

Respond with JSON when you need actions taken, or plain text for conversational responses.
When responding with actions, use this format:
{"action": "search_movie", "query": "...", "title": "...", "year": "..."}
{"action": "search_series", "query": "...", "title": "...", "seasons": N, "episodes_per_season": [...]}
{"action": "download", "type": "movie"|"series", "title": "...", "year": "...", "season": N, "episode": N, "filename": "..."}
{"action": "done", "message": "..."}`,
        };

        const allMessages = [systemMessage, ...messages];

        const response = await Promise.race([
            this.client.chat.completions.create({
                model: this.model,
                messages: allMessages,
                temperature: 0.7,
                max_tokens: 2048,
            }),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("AI API timeout (60s)")), 60000)
            ),
        ]);

        return response.choices[0]?.message?.content ?? "";
    }

    async processRequest(input: string): Promise<string> {
        this.logActivity(`User request: ${input}`);

        const messages: ChatMessage[] = [
            { role: "user", content: input },
        ];

        const response = await this.chat(messages);
        this.logActivity(`AI response: ${response}`);

        return response;
    }
}

let harnessInstance: Harness | null = null;

export function getHarness(): Harness {
    if (!harnessInstance) {
        throw new Error("Harness not initialized. Call initHarness() first.");
    }
    return harnessInstance;
}

export function initHarness(config: HarnessConfig): Harness {
    harnessInstance = new Harness(config);
    return harnessInstance;
}
