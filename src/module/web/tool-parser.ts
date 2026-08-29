// TOOL CALL PARSER - Robust parser for AI output formats

export const KNOWN_TOOLS = [
    "web_search", "search_movie", "search_series", "download_series", "download_movie", "download_episode",
    "download_season", "check_jellyfin", "list_downloads", "request_media", "bot_reconnect",
    "bot_auth_phone", "bot_auth_code", "bot_auth_password", "bot_auth_status",
    "tmdb_search", "get_series_seasons", "get_season_episodes"
];

export function parseToolCall(text: string): { tool: string; args: Record<string, any> } | null {
    if (!text || typeof text !== "string") return null;

    const trimmed = text.trim();

    // 1. Check for JSON in codeblocks or raw text
    const cleanedText = trimmed.replace(/^```(?:json|xml)?\s*/i, "").replace(/\s*```$/i, "");

    // Try finding JSON objects
    const jsonMatches = cleanedText.match(/\{[\s\S]*\}/g);
    if (jsonMatches) {
        for (const candidate of jsonMatches) {
            try {
                const obj = JSON.parse(candidate);
                // Check format: {"tool": "name", "args": {...}}
                if (obj.tool && KNOWN_TOOLS.includes(obj.tool)) {
                    return { tool: obj.tool, args: obj.args || {} };
                }
                // Check format: {"name": "tool_name", "parameters": {...}} or {"function": "...", "arguments": {...}}
                const toolName = obj.name || obj.function;
                if (toolName && KNOWN_TOOLS.includes(toolName)) {
                    return { tool: toolName, args: obj.parameters || obj.arguments || obj.args || {} };
                }
            } catch {
                // Regex fallback for non-strict JSON
                const looseMatch = candidate.match(/\{\s*["']?tool["']?\s*:\s*["']([^"']+)["']\s*,\s*["']?args["']?\s*:\s*(\{[\s\S]*?\})\s*\}/i);
                if (looseMatch) {
                    const tool = looseMatch[1];
                    if (KNOWN_TOOLS.includes(tool)) {
                        try {
                            const args = JSON.parse(looseMatch[2]);
                            return { tool, args };
                        } catch {}
                    }
                }
            }
        }
    }

    // 1b. Check if text starts with {"tool": "tool_name" ... even if cut off
    const toolHeaderMatch = cleanedText.match(/\{\s*["']?tool["']?\s*:\s*["']([a-z_]+)["']/i);
    if (toolHeaderMatch) {
        const tool = toolHeaderMatch[1];
        if (KNOWN_TOOLS.includes(tool)) {
            const queryArgMatch = cleanedText.match(/["']?(?:query|title)["']?\s*:\s*["']([^"'\n]+)/i);
            const args: Record<string, any> = {};
            if (queryArgMatch) {
                args[tool === "web_search" || tool === "tmdb_search" ? "query" : "title"] = queryArgMatch[1].trim();
            }
            return { tool, args };
        }
    }

    // 2. XML tool_call with function= and parameter tags
    const tcMatch = text.match(/tool_call[^>]*>([\s\S]*?)<\/tool_call/i);
    if (tcMatch) {
        const inner = tcMatch[1];
        const funcMatch = inner.match(/function=["']?([a-z_]+)["']?/i);
        if (funcMatch) {
            const tool = funcMatch[1];
            if (KNOWN_TOOLS.includes(tool)) {
                const args: Record<string, any> = {};
                const paramRegex = /parameter\s+name=["']?([^"'>\s]+)["']?[^>]*>([\s\S]*?)<\/parameter/gi;
                let m;
                while ((m = paramRegex.exec(inner)) !== null) {
                    args[m[1]] = m[2].trim();
                }
                if (Object.keys(args).length === 0) {
                    const kvRegex = /([a-z_]+)\s*=\s*["']?([^"'\s<]+)["']?/gi;
                    let kv;
                    while ((kv = kvRegex.exec(inner)) !== null) {
                        args[kv[1]] = kv[2].replace(/["']/g, "");
                    }
                }
                return { tool, args };
            }
        }
    }

    // 3. Bare function call like web_search("query") or search_series(title="...")
    for (const tool of KNOWN_TOOLS) {
        const bareRegex = new RegExp("(?:^|\\n)\\s*" + tool + "\\s*\\(([^)]*)\\)", "i");
        const bareMatch = text.match(bareRegex);
        if (bareMatch) {
            const args: Record<string, any> = {};
            const argStr = bareMatch[1].trim();
            if (argStr) {
                const kvPairs = argStr.split(",");
                for (const kv of kvPairs) {
                    const parts = kv.split("=");
                    if (parts.length === 2) {
                        args[parts[0].trim()] = parts[1].trim().replace(/^["']|["']$/g, "");
                    } else {
                        const paramNames: Record<string, string[]> = {
                            web_search: ["query"],
                            search_movie: ["title"],
                            search_series: ["title"],
                            check_jellyfin: ["title"],
                            download_movie: ["title"],
                            download_episode: ["title"],
                            download_season: ["title"],
                            bot_auth_phone: ["phone"],
                            bot_auth_code: ["code"],
                            bot_auth_password: ["password"],
                        };
                        const params = paramNames[tool];
                        if (params && params.length === 1) {
                            args[params[0]] = kv.trim().replace(/^["']|["']$/g, "");
                        }
                    }
                }
            }
            return { tool, args };
        }
    }

    return null;
}
