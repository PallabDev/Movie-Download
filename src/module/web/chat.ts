import { getHarness } from "../../../command/harness.js";
import { db, schema } from "../../common/db/index.js";
import { desc } from "drizzle-orm";
import { checkMovieExists, checkSeriesExists } from "../../common/jellyfin/client.js";
import { downloadQueue } from "../queue/queue.js";
import { isBotConnected } from "../bot/bot.js";
import { pickBestResult, groupByEpisode } from "../ai/brain.js";

interface ChatMsg {
    role: "user" | "assistant" | "tool";
    content: string;
    toolCall?: string;
    toolResult?: string;
}

interface ToolResult {
    success: boolean;
    message: string;
    data?: any;
}

// ─── TOOL DEFINITIONS ───

const TOOLS = `
You have these tools available:
1. search(title, type, year) - Search Telegram bot for a movie or series. Returns results with file options.
2. check_jellyfin(title, type, year) - Check if movie/series already exists in Jellyfin library.
3. list_downloads() - List all current and past downloads with status.
4. download_episode(title, season, episode, buttonText) - Download a specific episode by clicking a button from search results.
5. download_movie(title, year, buttonText) - Download a specific movie by clicking a button from search results.
6. get_bot_status() - Check if Telegram bot is connected and ready.
7. get_series_episodes(title) - Get grouped episode list for a series from last search.
`;

const SYSTEM_PROMPT = `You are a movie & series download assistant. You help users find and download content via Telegram bots.

You MUST respond with a JSON object for tool calls. Never try to execute tools yourself - always use tool calls.

RULES:
- Always search first before downloading
- Prefer 720p quality
- Movie size should be 600MB-1.9GB
- Episode size should be 50MB-1GB
- Check Jellyfin first - if already there, tell user
- For series: search once, bot returns all episodes
- Be conversational but efficient
- Show progress updates

TOOL CALL FORMAT (respond with ONLY this JSON, nothing else):
{"tool": "tool_name", "args": {"param1": "value1"}}

AVAILABLE TOOLS:
${TOOLS}

RESPONSE RULES:
- If user asks to search: call search tool
- If user asks to download: call search first, then download tool
- If user asks about library: call check_jellyfin
- If user asks about downloads: call list_downloads
- If you have results to present: respond with plain text (no JSON)
- If asking user for clarification: respond with plain text
- NEVER make up results - always use tools
`;

// ─── TOOL EXECUTION ───

async function executeTool(toolName: string, args: Record<string, any>): Promise<ToolResult> {
    const harness = getHarness();

    try {
        switch (toolName) {
            case "search": {
                const { title, type, year } = args;
                if (!title) return { success: false, message: "Title is required" };

                harness.logActivity(`[CHAT] Searching: "${title}" (${type || "auto"})`);

                // Check Jellyfin first
                const checkType = type || "movie";
                if (checkType === "movie") {
                    const jf = await checkMovieExists(title, year || "");
                    if (jf.exists) {
                        return { success: true, message: `"${title}" already exists in Jellyfin!`, data: { exists: true } };
                    }
                } else {
                    const jf = await checkSeriesExists(title);
                    if (jf.exists) {
                        return { success: true, message: `"${title}" already exists in Jellyfin!`, data: { exists: true } };
                    }
                }

                // Search Telegram bot
                const bot = checkType === "movie" ? "ProSearchM11Bot" : "ProSearchY11Bot";
                const botClient = (await import("../bot/bot.js")).default;

                if (!isBotConnected()) {
                    return { success: false, message: "Telegram bot is not connected. Please reconnect first." };
                }

                const searchQuery = checkType === "movie"
                    ? `${title} ${year || ""}`.trim()
                    : title;

                harness.logActivity(`[CHAT] Sending to @${bot}: ${searchQuery}`);
                const sent = await botClient.sendMessage(bot, { message: searchQuery });
                await new Promise(r => setTimeout(r, 4000));

                // Find button message
                let btnMsg: any = null;
                let messages = await botClient.getMessages(bot, { limit: 10 });
                for (const msg of messages) {
                    if (msg.id === sent.id) continue;
                    const buttons = await msg.getButtons();
                    if (buttons && buttons.length > 0) { btnMsg = msg; break; }
                }

                if (!btnMsg) {
                    await new Promise(r => setTimeout(r, 3000));
                    messages = await botClient.getMessages(bot, { limit: 10 });
                    for (const msg of messages) {
                        if (msg.id === sent.id) continue;
                        const buttons = await msg.getButtons();
                        if (buttons && buttons.length > 0) { btnMsg = msg; break; }
                    }
                }

                if (!btnMsg) {
                    return { success: true, message: `No results found for "${title}"`, data: { results: [] } };
                }

                // Extract results
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

                if (results.length === 0) {
                    return { success: true, message: `No downloadable results for "${title}"`, data: { results: [] } };
                }

                // For series, group by episode
                if (checkType === "series") {
                    const grouped = groupByEpisode(results);
                    const seasons = [...new Set(grouped.map(e => e.season))].sort((a, b) => a - b);
                    return {
                        success: true,
                        message: `Found ${results.length} results, ${grouped.length} unique episodes across ${seasons.length} season(s)`,
                        data: {
                            results,
                            grouped,
                            seasons,
                            btnMsgId: btnMsg.id,
                            bot,
                            title,
                        }
                    };
                }

                // For movie, pick best
                const best = await pickBestResult(title, "movie", results);
                return {
                    success: true,
                    message: `Found ${results.length} results for "${title}"`,
                    data: {
                        results,
                        bestIdx: best.index,
                        bestReason: best.reason,
                        btnMsgId: btnMsg.id,
                        bot,
                        title,
                    }
                };
            }

            case "check_jellyfin": {
                const { title, type, year } = args;
                if (!title) return { success: false, message: "Title is required" };
                const checkType = type || "movie";

                if (checkType === "movie") {
                    const result = await checkMovieExists(title, year || "");
                    const jfYear = result.item?.Year || year || "";
                    return {
                        success: true,
                        message: result.exists
                            ? `"${title}" IS in Jellyfin${jfYear ? ` (${jfYear})` : ""}`
                            : `"${title}" is NOT in Jellyfin`,
                        data: result
                    };
                } else {
                    const result = await checkSeriesExists(title);
                    return {
                        success: true,
                        message: result.exists
                            ? `"${title}" IS in Jellyfin`
                            : `"${title}" is NOT in Jellyfin`,
                        data: result
                    };
                }
            }

            case "list_downloads": {
                const items = await db.select().from(schema.downloads)
                    .orderBy(desc(schema.downloads.createdAt))
                    .limit(20);
                const count = items.length;
                if (count === 0) return { success: true, message: "No downloads yet", data: { items: [] } };

                const summary = items.map(d =>
                    `• ${d.title} (${d.type}) - ${d.status}${d.progress ? ` ${d.progress}%` : ""}`
                ).join("\n");
                return { success: true, message: `Recent downloads:\n${summary}`, data: { items } };
            }

            case "download_movie": {
                const { title, year, buttonText } = args;
                if (!title || !buttonText) return { success: false, message: "Title and buttonText required" };

                const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                await db.insert(schema.downloads).values({
                    requestId,
                    title: year ? `${title} (${year})` : title,
                    year: year || null,
                    type: "movie",
                    status: "queued",
                    fileSize: extractSizeMB(buttonText).toFixed(0) + " MB",
                });

                // We need the btnMsgId - store in a temp session
                harness.logActivity(`[CHAT] Queuing movie download: "${title}"`);

                return {
                    success: true,
                    message: `Queued "${title}" for download (${buttonText.substring(0, 60)}...)`,
                    data: { requestId, title }
                };
            }

            case "download_episode": {
                const { title, season, episode, buttonText } = args;
                if (!title || !buttonText) return { success: false, message: "Title and buttonText required" };

                const epLabel = `${title} S${String(season || 1).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
                const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

                await db.insert(schema.downloads).values({
                    requestId,
                    title: epLabel,
                    type: "series",
                    status: "queued",
                    season: season || 1,
                    episode: episode || 1,
                    fileSize: extractSizeMB(buttonText).toFixed(0) + " MB",
                });

                return {
                    success: true,
                    message: `Queued "${epLabel}" for download`,
                    data: { requestId, title: epLabel }
                };
            }

            case "get_bot_status": {
                const connected = isBotConnected();
                return {
                    success: true,
                    message: connected
                        ? "Telegram bot is connected and ready"
                        : "Telegram bot is disconnected. Please reconnect via the dashboard.",
                    data: { connected }
                };
            }

            case "get_series_episodes": {
                // Return last search's grouped episodes
                return {
                    success: true,
                    message: "Please search for the series first to get episode list",
                    data: {}
                };
            }

            default:
                return { success: false, message: `Unknown tool: ${toolName}` };
        }
    } catch (err: any) {
        harness.logError(`[CHAT] Tool error: ${err.message}`);
        return { success: false, message: `Error: ${err.message}` };
    }
}

function extractSizeMB(text: string): number {
    const match = text.match(/\[([\d.]+)\s*(GB|MB|KB)\]/i);
    if (!match) return 0;
    const val = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    if (unit === "GB") return val * 1024;
    if (unit === "MB") return val;
    return val / 1024;
}

// ─── CHAT HANDLER ───

export async function handleChat(
    userMessage: string,
    history: ChatMsg[]
): Promise<{ reply: string; toolCalls: { tool: string; args: any; result: ToolResult }[] }> {
    const harness = getHarness();
    const toolCalls: { tool: string; args: any; result: ToolResult }[] = [];

    // Add user message to history
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history.map(m => ({ role: (m.role === "tool" ? "assistant" : m.role) as "system" | "user" | "assistant", content: m.content })),
        { role: "user", content: userMessage },
    ];

    const MAX_ITERATIONS = 5;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
        harness.logActivity(`[CHAT] AI iteration ${i + 1}`);

        const response = await harness.chat(messages);
        harness.logActivity(`[CHAT] AI response: ${response.substring(0, 200)}`);

        // Check if AI wants to call a tool
        const toolMatch = response.match(/\{"tool"\s*:\s*"([^"]+)"\s*,\s*"args"\s*:\s*(\{[^}]+\})\s*\}/);
        if (toolMatch) {
            const toolName = toolMatch[1];
            let args: Record<string, any> = {};
            try {
                args = JSON.parse(toolMatch[2]);
            } catch { }

            harness.logActivity(`[CHAT] Tool call: ${toolName}(${JSON.stringify(args)})`);

            // Execute the tool
            const result = await executeTool(toolName, args);
            toolCalls.push({ tool: toolName, args, result });

            // Feed result back to AI
            messages.push({ role: "assistant", content: response });
            messages.push({ role: "user", content: `Tool result for ${toolName}:\n${JSON.stringify(result, null, 2)}\n\nNow respond to the user based on this result. Do NOT call another tool - just give the final answer.` });

            continue;
        }

        // No tool call - this is the final text response
        return { reply: response, toolCalls };
    }

    return { reply: "I've processed your request. Check the results above.", toolCalls };
}
