import { inngest } from "./client.js";
import { lookupMedia, getSeriesSeasonsAndEpisodes, getSeasonEpisodesList, cleanMediaTitle } from "../../common/tmdb/client.js";
import { webSearch, pickBestResult, groupByEpisode, getSeriesInfo } from "../ai/brain.js";
import { checkMovieExists, checkSeriesExists } from "../../common/jellyfin/client.js";
import { isBotConnected } from "../bot/bot.js";
import { db, schema } from "../../common/db/index.js";
import { downloadQueue } from "../queue/queue.js";
import { getHarness } from "../../../command/harness.js";
import { broadcastNewDownload } from "../web/ws.js";
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

// ─── UNIFIED MEDIA REQUEST WORKFLOW (STEP 0 - STEP 3) ───

export const mediaRequestWorkflow = inngest.createFunction(
    { id: "media-request", triggers: [{ event: "media.request" }, { event: "media.search" }] } as any,
    async ({ event, step }: any) => {
        const data = event.data as any;
        const rawTitle: string = data.title;
        const requestedYear: string = data.year || "";
        const cleaned = cleanMediaTitle(rawTitle);
        const requestedSeasons: number[] = Array.isArray(data.seasons) && data.seasons.length > 0 
            ? data.seasons 
            : (cleaned.season ? [cleaned.season] : []);
        const sessionId: string = data.sessionId || `session_${Date.now()}`;
        const harness = getHarness();

        // ── STEP 0: User Request ──
        harness.logActivity(`[INNGEST STEP 0] User request received: "${rawTitle}" (session: ${sessionId})`);

        // ── STEP 1: Process User Request with TMDB to find whether it is Movie or Series ──
        const tmdbMeta = await step.run("step-1-tmdb-classify", async () => {
            harness.logActivity(`[INNGEST STEP 1] TMDB lookup & classification for: "${rawTitle}"`);
            const meta = await lookupMedia(rawTitle, requestedYear || cleaned.year);
            return meta;
        });

        const canonicalTitle = tmdbMeta?.found ? tmdbMeta.title : rawTitle;
        const mediaType = tmdbMeta?.found ? tmdbMeta.type : (data.type || "movie");
        const releaseYear = tmdbMeta?.found ? (tmdbMeta.year || requestedYear) : requestedYear;

        harness.logActivity(`[INNGEST STEP 1] Classified "${canonicalTitle}" as ${mediaType.toUpperCase()} (${releaseYear})`);

        // ── STEP 2: If Movie -> Follow Movie Download Process ──
        if (mediaType === "movie") {
            const jfCheck = await step.run("step-2-movie-check-jellyfin", async () => {
                return await checkMovieExists(canonicalTitle, releaseYear);
            });

            if (jfCheck.exists) {
                harness.logActivity(`[INNGEST STEP 2] Movie "${canonicalTitle}" already exists in Jellyfin`);
                return { status: "already_in_jellyfin", type: "movie", title: canonicalTitle, jellyfin: jfCheck };
            }

            const movieDownload = await step.run("step-2-movie-search-click-download", async () => {
                harness.logActivity(`[INNGEST STEP 2] Searching Telegram @ProSearchM11Bot for movie: "${canonicalTitle} ${releaseYear}"`);
                if (!isBotConnected()) return { error: "BOT_DISCONNECTED", queued: false };

                const botClient = (await import("../bot/bot.js")).default;
                const query = `${canonicalTitle} ${releaseYear}`.trim();
                const sent = await botClient.sendMessage("ProSearchM11Bot", { message: query });

                let btnMsg: any = null;
                for (let attempt = 0; attempt < 4; attempt++) {
                    await new Promise(r => setTimeout(r, 1500));
                    const msgs = await botClient.getMessages("ProSearchM11Bot", { limit: 10 });
                    for (const msg of msgs) {
                        if (msg.id <= sent.id) continue;
                        const buttons = await msg.getButtons();
                        if (buttons && buttons.length > 0) { btnMsg = msg; break; }
                        const text = msg.message || "";
                        if (text.toLowerCase().includes("no results found") || text.toLowerCase().includes("not found")) {
                            return { error: "NO_RESULTS", queued: false };
                        }
                    }
                    if (btnMsg) break;
                }

                if (!btnMsg) return { error: "NO_BUTTONS_RETURNED", queued: false };

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

                // Pick best option prioritizing Hindi language
                const bestResult = await pickBestResult(canonicalTitle, "movie", results);
                const bestOption = results[bestResult.index] || results[0];

                // Click button on Telegram to initiate download
                await btnMsg.click({ text: bestOption.text });

                const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                const sizeMatch = bestOption.text.match(/\[([\d.]+)\s*(GB|MB)\]/i);
                const fileSize = sizeMatch ? sizeMatch[1] + " " + sizeMatch[2].toUpperCase() : (bestOption.sizeMB > 0 ? `${bestOption.sizeMB.toFixed(0)} MB` : "1 GB");

                await db.insert(schema.downloads).values({
                    requestId,
                    title: canonicalTitle,
                    type: "movie",
                    status: "queued",
                    year: releaseYear,
                    fileSize,
                });

                downloadQueue.addJob({
                    requestId,
                    bot: "ProSearchM11Bot",
                    btnMsgId: btnMsg.id,
                    type: "movie",
                    title: canonicalTitle,
                    year: releaseYear,
                    fileSize,
                    buttonText: bestOption.text,
                });

                try { broadcastNewDownload({ jobId: requestId, title: canonicalTitle, type: "movie", requestedBy: "inngest" }); } catch {}
                harness.logActivity(`[INNGEST STEP 2] Movie "${canonicalTitle}" selected (${bestOption.text}) & queued!`);

                return { queued: true, requestId, title: canonicalTitle, selectedOption: bestOption.text, fileSize };
            });

            return { status: "completed", type: "movie", result: movieDownload };
        }

        // ── STEP 3: If Series -> Search TMDB for All Seasons & Episodes, then Search & Download Episode-by-Episode ──
        const seriesInfo = await step.run("step-3-tmdb-series-episodes", async () => {
            harness.logActivity(`[INNGEST STEP 3] Fetching TMDB seasons and episode counts for: "${canonicalTitle}"`);
            const info = await getSeriesSeasonsAndEpisodes(canonicalTitle);
            return info;
        });

        const totalSeasons = seriesInfo?.found ? seriesInfo.totalSeasons : (tmdbMeta?.totalSeasons || 1);
        const episodesPerSeason = seriesInfo?.found ? seriesInfo.episodesPerSeason : [10];

        // Determine target seasons
        const targetSeasons = requestedSeasons.length > 0
            ? requestedSeasons
            : Array.from({ length: totalSeasons }, (_, i) => i + 1);

        harness.logActivity(`[INNGEST STEP 3] "${canonicalTitle}" (${totalSeasons} seasons). Processing target seasons: [${targetSeasons.join(", ")}]`);

        const queuedEpisodesList: any[] = [];

        // Sequential search-click-download loop for each season & episode
        for (const s of targetSeasons) {
            const epCount = episodesPerSeason[s - 1] || 10;
            const seasonTag = `S${String(s).padStart(2, "0")}`;
            const seasonPackKey = `step-3-season-pack-${seasonTag}`;

            // Check for COMBINED season pack first
            const seasonPackRes = await step.run(seasonPackKey, async () => {
                const seasonQuery = `${canonicalTitle} ${seasonTag}`;
                harness.logActivity(`[INNGEST STEP 3] Checking COMBINED pack for: "${seasonQuery}" on @ProSearchY11Bot`);
                if (!isBotConnected()) return { found: false };

                const botClient = (await import("../bot/bot.js")).default;
                const sent = await botClient.sendMessage("ProSearchY11Bot", { message: seasonQuery });

                let btnMsg: any = null;
                for (let attempt = 0; attempt < 4; attempt++) {
                    await new Promise(r => setTimeout(r, 1500));
                    const msgs = await botClient.getMessages("ProSearchY11Bot", { limit: 10 });
                    for (const msg of msgs) {
                        if (msg.id <= sent.id) continue;
                        const buttons = await msg.getButtons();
                        if (buttons && buttons.length > 0) { btnMsg = msg; break; }
                    }
                    if (btnMsg) break;
                }

                if (!btnMsg) return { found: false };

                const buttons = (await btnMsg.getButtons())!;
                const options: { text: string; sizeMB: number }[] = [];
                for (const row of buttons) {
                    for (const btn of row) {
                        const text = (btn as any).text || "";
                        if (!text) continue;
                        const lower = text.toLowerCase();
                        if (lower.includes("srt") || lower.includes("sub")) continue;
                        if (lower.includes("combined") || (lower.includes(seasonTag.toLowerCase()) && !/e\d{1,2}/i.test(lower))) {
                            options.push({ text, sizeMB: extractSizeMB(text) });
                        }
                    }
                }

                if (options.length === 0) return { found: false };

                const prefer1080 = options.find(r => r.text.toLowerCase().includes("1080p"));
                const prefer720 = options.find(r => r.text.toLowerCase().includes("720p"));
                const bestOption = prefer1080 || prefer720 || options[0];

                await new Promise(r => setTimeout(r, 2500));
                await btnMsg.click({ text: bestOption.text });

                const packLabel = `${canonicalTitle} ${seasonTag} (COMBINED)`;
                const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                const sizeMatch = bestOption.text.match(/\[([\d.]+)\s*(GB|MB)\]/i);
                const fileSize = sizeMatch ? sizeMatch[1] + " " + sizeMatch[2].toUpperCase() : (bestOption.sizeMB > 0 ? `${bestOption.sizeMB.toFixed(0)} MB` : "1.5 GB");

                await db.insert(schema.downloads).values({
                    requestId,
                    title: packLabel,
                    type: "series",
                    status: "queued",
                    season: s,
                    fileSize,
                });

                downloadQueue.addJob({
                    requestId,
                    bot: "ProSearchY11Bot",
                    btnMsgId: btnMsg.id,
                    type: "series",
                    title: packLabel,
                    season: s,
                    fileSize,
                    buttonText: bestOption.text,
                });

                try { broadcastNewDownload({ jobId: requestId, title: packLabel, type: "series", requestedBy: "inngest" }); } catch {}
                harness.logActivity(`[INNGEST STEP 3] "${packLabel}" COMBINED pack selected (${bestOption.text}) & queued!`);

                return { episode: seasonTag, found: true, isCombined: true, queued: true, requestId, selectedOption: bestOption.text, fileSize };
            });

            if (seasonPackRes?.queued && seasonPackRes?.isCombined) {
                queuedEpisodesList.push(seasonPackRes);
                await new Promise(r => setTimeout(r, 4000));
                continue; // Skip individual episodes!
            }

            for (let e = 1; e <= epCount; e++) {
                const sTag = `${seasonTag}E${String(e).padStart(2, "0")}`;
                const queryText = `${canonicalTitle} ${sTag}`;
                const stepKey = `step-3-episode-${sTag}`;

                const epResult = await step.run(stepKey, async () => {
                    harness.logActivity(`[INNGEST STEP 3] Querying: "${queryText}" on @ProSearchY11Bot`);
                    if (!isBotConnected()) return { error: "BOT_DISCONNECTED", episode: sTag, queued: false };

                    const botClient = (await import("../bot/bot.js")).default;
                    const sent = await botClient.sendMessage("ProSearchY11Bot", { message: queryText });

                    let btnMsg: any = null;
                    for (let attempt = 0; attempt < 4; attempt++) {
                        await new Promise(r => setTimeout(r, 1500));
                        const msgs = await botClient.getMessages("ProSearchY11Bot", { limit: 10 });
                        for (const msg of msgs) {
                            if (msg.id <= sent.id) continue;
                            const buttons = await msg.getButtons();
                            if (buttons && buttons.length > 0) { btnMsg = msg; break; }
                            const text = msg.message || "";
                            if (text.toLowerCase().includes("no results found") || text.toLowerCase().includes("not found")) {
                                harness.logActivity(`[INNGEST STEP 3] "${queryText}": No results found on Telegram`);
                                return { episode: sTag, found: false, queued: false };
                            }
                        }
                        if (btnMsg) break;
                    }

                    if (!btnMsg) return { episode: sTag, found: false, queued: false };

                    const buttons = (await btnMsg.getButtons())!;
                    const options: { text: string; sizeMB: number }[] = [];
                    for (const row of buttons) {
                        for (const btn of row) {
                            const text = (btn as any).text || "";
                            if (!text) continue;
                            const lower = text.toLowerCase();
                            if (lower.includes("srt") || lower.includes("sub")) continue;
                            const sizeMB = extractSizeMB(text);
                            if (sizeMB < 10 && !lower.includes("mp4") && !lower.includes("mkv")) continue;
                            options.push({ text, sizeMB });
                        }
                    }

                    if (options.length === 0) return { episode: sTag, found: false, queued: false };

                    // Pick best video option
                    const prefer720 = options.find(r => r.text.toLowerCase().includes("720p") && !r.text.toLowerCase().includes("srt"));
                    const prefer1080 = options.find(r => r.text.toLowerCase().includes("1080p") && !r.text.toLowerCase().includes("srt"));
                    const bestOption = prefer1080 || prefer720 || options[0];

                    // Pacing delay: wait 2.5s after bot response before clicking button
                    await new Promise(r => setTimeout(r, 2500));

                    // Click option button on Telegram
                    await btnMsg.click({ text: bestOption.text });

                    const epLabel = `${canonicalTitle} ${sTag}`;
                    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                    const sizeMatch = bestOption.text.match(/\[([\d.]+)\s*(GB|MB)\]/i);
                    const fileSize = sizeMatch ? sizeMatch[1] + " " + sizeMatch[2].toUpperCase() : (bestOption.sizeMB > 0 ? `${bestOption.sizeMB.toFixed(0)} MB` : "500 MB");

                    await db.insert(schema.downloads).values({
                        requestId,
                        title: epLabel,
                        type: "series",
                        status: "queued",
                        season: s,
                        episode: e,
                        fileSize,
                    });

                    downloadQueue.addJob({
                        requestId,
                        bot: "ProSearchY11Bot",
                        btnMsgId: btnMsg.id,
                        type: "series",
                        title: epLabel,
                        fileSize,
                        buttonText: bestOption.text,
                    });

                    try { broadcastNewDownload({ jobId: requestId, title: epLabel, type: "series", requestedBy: "inngest" }); } catch {}
                    harness.logActivity(`[INNGEST STEP 3] "${epLabel}" selected (${bestOption.text}) & queued for download!`);

                    return { episode: sTag, found: true, queued: true, requestId, selectedOption: bestOption.text, fileSize };
                });

                if (epResult.queued) {
                    queuedEpisodesList.push(epResult);
                }

                // Pacing delay: wait 4s before searching next episode
                await new Promise(r => setTimeout(r, 4000));
            }
        }

        return {
            status: "completed",
            type: "series",
            title: canonicalTitle,
            totalSeasons,
            queuedCount: queuedEpisodesList.length,
            queuedEpisodes: queuedEpisodesList,
        };
    }
);

// ─── LEGACY EVENT WRAPPERS (FOR BACKWARD COMPATIBILITY) ───

export const movieSearchWorkflow = inngest.createFunction(
    { id: "movie-search", triggers: [{ event: "movie.search" }] } as any,
    async ({ event, step }: any) => {
        return await inngest.send({ name: "media.request", data: { ...event.data, type: "movie" } });
    }
);

export const seriesSearchWorkflow = inngest.createFunction(
    { id: "series-search", triggers: [{ event: "series.search" }] } as any,
    async ({ event, step }: any) => {
        return await inngest.send({ name: "media.request", data: { ...event.data, type: "series" } });
    }
);

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

