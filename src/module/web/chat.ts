import { getHarness } from "../../../command/harness.js";
import { db, schema } from "../../common/db/index.js";
import { lookupMedia, cleanMediaTitle } from "../../common/tmdb/client.js";
import { parseToolCall, KNOWN_TOOLS } from "./tool-parser.js";
import { executeTool, SYSTEM_PROMPT, clearWorkflow, type ToolResult } from "./tools.js";

// ─── AGENT MEMORY (PostgreSQL) ───

async function saveMemory(sessionId: string, role: string, content: string) {
    try {
        await db.insert(schema.agentMemory).values({ sessionId, role, content });
    } catch (err: any) {
        console.error(`[MEMORY] Write error: ${err.message}`);
    }
}

// ─── CHAT HANDLER ───

export async function handleChat(
    userMessage: string,
    history: { role: string; content: string }[],
    sessionId: string
): Promise<{ reply: string; toolCalls: { tool: string; args: any; result: ToolResult }[] }> {
    const harness = getHarness();
    const toolCalls: { tool: string; args: any; result: ToolResult }[] = [];

    const lowerMsg = userMessage.toLowerCase().trim();
    const isSingleNumber = /^\d+$/.test(lowerMsg);
    if (!isSingleNumber && (/^(hi|hello|hey|start|reset|clear|new|help|\?)/.test(lowerMsg) || (lowerMsg.length < 3 && !/^[1-9]$/.test(lowerMsg)))) {
        clearWorkflow(sessionId);
    }

    await saveMemory(sessionId, "user", userMessage);

    // Pre-fetch verified TMDB metadata to inject ground-truth context and prevent AI hallucinations
    let tmdbGroundTruth = "";
    try {
        const { title: cleanT } = cleanMediaTitle(userMessage);
        if (cleanT && cleanT.length > 2 && !/^(hi|hello|hey|help|status|reconnect)/i.test(cleanT)) {
            const mediaFacts = await lookupMedia(cleanT);
            if (mediaFacts && mediaFacts.found) {
                if (mediaFacts.type === "series") {
                    tmdbGroundTruth = `\n\n[NOTICE FOR "${mediaFacts.title}"]: This title is a TV Series. TV Series & TV Shows are strictly NOT supported. Inform the user politely that TV series/shows are not supported, and that only Movies are available for download.`;
                } else if (mediaFacts.type === "movie") {
                    const collInfo = mediaFacts.collection ? `Franchise: "${mediaFacts.collection.name}" (${mediaFacts.collection.partsCount} released parts: ${mediaFacts.collection.parts.map(p => `${p.title} [${p.year}]`).join(", ")})` : "Standalone Movie";
                    tmdbGroundTruth = `\n\n[VERIFIED TMDB GROUND TRUTH FOR "${mediaFacts.title}"]:\n- Type: Movie\n- Release Year: ${mediaFacts.year}\n- ${collInfo}\n- Overview: ${mediaFacts.overview}\nCRITICAL: USE THIS EXACT VERIFIED TMDB DATA IN YOUR RESPONSE.`;
                }
            }
        }
    } catch { }

    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
        { role: "system", content: SYSTEM_PROMPT + tmdbGroundTruth },
        ...history.map(m => ({ role: m.role as "system" | "user" | "assistant", content: m.content })),
        { role: "user", content: userMessage },
    ];

    const MAX_ITERATIONS = 8;

    try {
        for (let i = 0; i < MAX_ITERATIONS; i++) {
            harness.logActivity(`[CHAT] AI iteration ${i + 1}`);

            let response = "";
            try {
                response = await harness.chat(messages);
            } catch (chatErr: any) {
                harness.logError(`[CHAT] harness.chat error: ${chatErr.message}`);
            }

            harness.logActivity(`[CHAT] AI output: ${(response || "").substring(0, 200)}`);

            const parsed = parseToolCall(response);

            if (parsed) {
                harness.logActivity(`[CHAT] Executing parsed tool: "${parsed.tool}" with args: ${JSON.stringify(parsed.args)}`);

                const result = await executeTool(parsed.tool, parsed.args, sessionId);
                toolCalls.push({ tool: parsed.tool, args: parsed.args, result });

                messages.push({ role: "assistant", content: response });
                messages.push({
                    role: "user",
                    content: `Tool "${parsed.tool}" executed.\nResult message: ${result.message}\nData: ${JSON.stringify(result.data || {})}\n\nNow respond to the user in conversational, friendly Markdown. NEVER display raw JSON in your reply.`
                });
                continue;
            }

            // Fallback extraction if model output raw tool JSON
            if (response.includes('"tool"') || response.includes('"function"')) {
                const fallbackTool = response.match(/["'](?:tool|function)["']\s*:\s*["']([a-z_]+)["']/i);
                if (fallbackTool && KNOWN_TOOLS.includes(fallbackTool[1])) {
                    const tool = fallbackTool[1];
                    const queryMatch = response.match(/["'](?:query|title)["']\s*:\s*["']([^"'\n]+)/i);
                    const args: Record<string, any> = {};
                    if (queryMatch) {
                        args[tool === "web_search" || tool === "tmdb_search" ? "query" : "title"] = queryMatch[1].trim();
                    }
                    const result = await executeTool(tool, args, sessionId);
                    toolCalls.push({ tool, args, result });
                    messages.push({ role: "assistant", content: response });
                    messages.push({
                        role: "user",
                        content: `Tool "${tool}" executed.\nResult message: ${result.message}\nData: ${JSON.stringify(result.data || {})}\n\nNow respond to the user in conversational, friendly Markdown. NEVER display raw JSON in your reply.`
                    });
                    continue;
                }
            }

            let finalReply = (response || "").trim();
            if (!finalReply) {
                if (toolCalls.length > 0) {
                    const lastTool = toolCalls[toolCalls.length - 1];
                    if (lastTool.result.data?.queuedEpisodes?.length > 0) {
                        finalReply = `🎬 Found and queued **${lastTool.result.data.queuedEpisodes.length} episodes** for **${lastTool.result.data.title || "series"}** into the download queue!`;
                    } else if (lastTool.result.message) {
                        finalReply = `✅ ${lastTool.result.message}`;
                    } else {
                        finalReply = `Done processing your request!`;
                    }
                } else {
                    finalReply = `I'm ready to search and download movies or series. What would you like to find?`;
                }
            }

            await saveMemory(sessionId, "ai", finalReply.substring(0, 500));
            return { reply: finalReply, toolCalls };
        }

        const fallbackReply = toolCalls.length > 0
            ? `🎬 Request completed: ${toolCalls.map(t => t.result.message).join("; ")}`
            : "Done processing your request!";
        return { reply: fallbackReply, toolCalls };
    } catch (err: any) {
        harness.logError(`[CHAT] handleChat unexpected error: ${err.message}`);
        const fallbackReply = toolCalls.length > 0
            ? `🎬 Processed request: ${toolCalls.map(t => t.result.message).join("; ")}`
            : `⚠️ Sorry, there was an issue processing your request (${err.message}). Please try again!`;
        return { reply: fallbackReply, toolCalls };
    }
}
