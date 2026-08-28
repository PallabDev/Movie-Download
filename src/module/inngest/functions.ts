import { inngest } from "./client.js";
import { webSearch, pickBestResult, groupByEpisode } from "../ai/brain.js";
import { checkMovieExists, checkSeriesExists } from "../../common/jellyfin/client.js";
import { isBotConnected } from "../bot/bot.js";
import { db, schema } from "../../common/db/index.js";
import { downloadQueue } from "../queue/queue.js";
import { getHarness } from "../../../command/harness.js";
import { eq } from "drizzle-orm";

function extractSizeMB(text: string): number {
    const match = text.match(/\[([\d.]+)\s*(GB|MB|KB)\]/i);
    if (!match) return 0;
    const val = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    if (unit === "GB") return val * 1024;
    if (unit === "MB") return val;
    return val / 1024;
}

// ─── MOVIE WORKFLOW ───

export const movieSearchWorkflow = inngest.createFunction(
    { id: "movie-search", triggers: [{ event: "movie.search" }] } as any,
    async ({ event, step }: any) => {
        const data = event.data as any;
        const title: string = data.title;
        const year: string = data.year || "";
        const sessionId: string = data.sessionId;
        const harness = getHarness();

        const webResults = await step.run("web-search", async () => {
            harness.logActivity(`[INNGEST] Stage 1: Web search for "${title}"`);
            const query = `${title} ${year} movie`.trim();
            return await webSearch(query);
        });

        const jfResult = await step.run("check-jellyfin", async () => {
            harness.logActivity(`[INNGEST] Stage 2: Checking Jellyfin for "${title}"`);
            return await checkMovieExists(title, year);
        });

        if (jfResult.exists) {
            return { status: "already_in_jellyfin", title, jellyfin: jfResult };
        }

        const telegramResults = await step.run("search-telegram", async () => {
            harness.logActivity(`[INNGEST] Stage 3: Searching Telegram for "${title}"`);
            if (!isBotConnected()) return { error: "BOT_DISCONNECTED", results: [] as any[] };

            const botClient = (await import("../bot/bot.js")).default;
            const query = `${title} ${year}`.trim();
            const sent = await botClient.sendMessage("ProSearchM11Bot", { message: query });
            await new Promise(r => setTimeout(r, 4000));

            let btnMsg: any = null;
            let messages = await botClient.getMessages("ProSearchM11Bot", { limit: 10 });
            for (const msg of messages) {
                if (msg.id === sent.id) continue;
                const buttons = await msg.getButtons();
                if (buttons && buttons.length > 0) { btnMsg = msg; break; }
            }

            if (!btnMsg) {
                await new Promise(r => setTimeout(r, 3000));
                messages = await botClient.getMessages("ProSearchM11Bot", { limit: 10 });
                for (const msg of messages) {
                    if (msg.id === sent.id) continue;
                    const buttons = await msg.getButtons();
                    if (buttons && buttons.length > 0) { btnMsg = msg; break; }
                }
            }

            if (!btnMsg) return { results: [] as any[], btnMsgId: null, bot: "" };

            const buttons = (await btnMsg.getButtons())!;
            const results: { text: string; sizeMB: number }[] = [];
            for (const row of buttons) {
                for (const btn of row) {
                    const text = (btn as any).text || "";
                    if (!text) continue;
                    const lower = text.toLowerCase();
                    if (lower.includes("srt") || lower.includes("sub")) continue;
                    const sizeMB = extractSizeMB(text);
                    if (sizeMB < 10 && !lower.includes("mp4") && !lower.includes("mkv")) continue;
                    results.push({ text, sizeMB });
                }
            }

            return { results, btnMsgId: btnMsg.id, bot: "ProSearchM11Bot" };
        });

        if (!telegramResults.results || telegramResults.results.length === 0) {
            return { status: "no_results", title, webResults };
        }

        const bestPick = await step.run("pick-best", async () => {
            harness.logActivity(`[INNGEST] Stage 4: Picking best result for "${title}"`);
            return await pickBestResult(title, "movie", telegramResults.results as any);
        });

        const sessionKey = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        return {
            status: "results_found",
            title, year, webResults,
            results: telegramResults.results,
            bestPick, sessionKey, sessionId,
        };
    }
);

// ─── SERIES WORKFLOW ───

export const seriesSearchWorkflow = inngest.createFunction(
    { id: "series-search", triggers: [{ event: "series.search" }] } as any,
    async ({ event, step }: any) => {
        const data = event.data as any;
        const title: string = data.title;
        const sessionId: string = data.sessionId;
        const harness = getHarness();

        const webResults = await step.run("web-search", async () => {
            harness.logActivity(`[INNGEST] Stage 1: Web search for "${title}"`);
            return await webSearch(`${title} series`);
        });

        const jfResult = await step.run("check-jellyfin", async () => {
            harness.logActivity(`[INNGEST] Stage 2: Checking Jellyfin for "${title}"`);
            return await checkSeriesExists(title);
        });

        if (jfResult.exists) {
            return { status: "already_in_jellyfin", title, jellyfin: jfResult };
        }

        const telegramResults = await step.run("search-telegram", async () => {
            harness.logActivity(`[INNGEST] Stage 3: Searching Telegram for "${title}"`);
            if (!isBotConnected()) return { error: "BOT_DISCONNECTED", results: [] as any[] };

            const botClient = (await import("../bot/bot.js")).default;
            const sent = await botClient.sendMessage("ProSearchY11Bot", { message: title });
            await new Promise(r => setTimeout(r, 4000));

            let btnMsg: any = null;
            let messages = await botClient.getMessages("ProSearchY11Bot", { limit: 10 });
            for (const msg of messages) {
                if (msg.id === sent.id) continue;
                const buttons = await msg.getButtons();
                if (buttons && buttons.length > 0) { btnMsg = msg; break; }
            }

            if (!btnMsg) {
                await new Promise(r => setTimeout(r, 3000));
                messages = await botClient.getMessages("ProSearchY11Bot", { limit: 10 });
                for (const msg of messages) {
                    if (msg.id === sent.id) continue;
                    const buttons = await msg.getButtons();
                    if (buttons && buttons.length > 0) { btnMsg = msg; break; }
                }
            }

            if (!btnMsg) return { results: [] as any[], btnMsgId: null, bot: "" };

            const buttons = (await btnMsg.getButtons())!;
            const results: { text: string; sizeMB: number }[] = [];
            for (const row of buttons) {
                for (const btn of row) {
                    const text = (btn as any).text || "";
                    if (!text) continue;
                    const lower = text.toLowerCase();
                    if (lower.includes("srt") || lower.includes("sub")) continue;
                    const sizeMB = extractSizeMB(text);
                    if (sizeMB < 10 && !lower.includes("mp4") && !lower.includes("mkv")) continue;
                    results.push({ text, sizeMB });
                }
            }

            return { results, btnMsgId: btnMsg.id, bot: "ProSearchY11Bot" };
        });

        if (!telegramResults.results || telegramResults.results.length === 0) {
            return { status: "no_results", title, webResults };
        }

        const grouped = await step.run("group-episodes", async () => {
            harness.logActivity(`[INNGEST] Stage 4: Grouping episodes for "${title}"`);
            const g = groupByEpisode(telegramResults.results as any);
            const seasons = [...new Set(g.map(e => e.season))].sort((a, b) => a - b);
            const seasonSummary = seasons.map(s => {
                const eps = g.filter(e => e.season === s);
                return { season: s, count: eps.length, episodes: eps };
            });
            return { grouped: g, seasons: seasonSummary };
        });

        const sessionKey = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        return {
            status: "results_found",
            title, webResults,
            grouped: grouped.grouped,
            seasons: grouped.seasons,
            totalEpisodes: grouped.grouped.length,
            sessionKey, sessionId,
        };
    }
);

// ─── DOWNLOAD WORKFLOW ───

export const downloadWorkflow = inngest.createFunction(
    { id: "download", triggers: [{ event: "download.start" }] } as any,
    async ({ event, step }: any) => {
        const data = event.data as any;
        const requestId: string = data.requestId;
        const title: string = data.title;
        const type: string = data.type;
        const buttonText: string = data.buttonText;
        const bot: string = data.bot;
        const btnMsgId: number = data.btnMsgId;
        const year: string = data.year || "";
        const harness = getHarness();

        await step.run("click-button", async () => {
            harness.logActivity(`[INNGEST] Download: Clicking "${buttonText.substring(0, 50)}"`);
            const botClient = (await import("../bot/bot.js")).default;
            const messages = await botClient.getMessages(bot, { limit: 5 });
            const btnMsg = messages.find((m: any) => m.id === btnMsgId);
            if (btnMsg) await btnMsg.click({ text: buttonText });
        });

        await step.run("wait-for-file", async () => {
            harness.logActivity(`[INNGEST] Download: Waiting for file "${title}"`);
            await new Promise(r => setTimeout(r, 5000));
        });

        await step.run("update-db", async () => {
            const sizeMatch = buttonText.match(/\[([\d.]+)\s*(GB|MB)\]/i);
            const fileSize = sizeMatch ? sizeMatch[1] + " " + sizeMatch[2].toUpperCase() : null;

            await db.update(schema.downloads)
                .set({ status: "downloading", fileSize, updatedAt: new Date() })
                .where(eq(schema.downloads.requestId, requestId));

            downloadQueue.addJob({
                requestId, bot, btnMsgId, type: type as "movie" | "series", title, year, fileSize: fileSize || undefined,
            });
        });

        return { status: "download_started", requestId, title };
    }
);
