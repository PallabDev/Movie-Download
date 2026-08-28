import { WebSocket, WebSocketServer } from "ws";
import type { Server } from "http";

interface WSClient {
    ws: WebSocket;
    userId?: number;
    role?: string;
}

const clients: Set<WSClient> = new Set();

export function setupWebSocket(server: Server) {
    const wss = new WebSocketServer({ server, path: "/ws" });

    wss.on("connection", (ws: WebSocket) => {
        const client: WSClient = { ws };
        clients.add(client);
        console.log(`[WS] Client connected (total: ${clients.size})`);

        ws.on("message", (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === "auth") {
                    client.userId = msg.userId;
                    client.role = msg.role;
                    console.log(`[WS] Client authenticated: user ${msg.userId} (${msg.role})`);
                }
            } catch { }
        });

        ws.on("close", () => {
            clients.delete(client);
            console.log(`[WS] Client disconnected (total: ${clients.size})`);
        });

        ws.on("error", () => {
            clients.delete(client);
        });

        // Send initial connection confirmation
        ws.send(JSON.stringify({ type: "connected", timestamp: Date.now() }));
    });

    console.log("[WS] WebSocket server ready on /ws");
    return wss;
}

export function broadcast(data: Record<string, unknown>) {
    const msg = JSON.stringify(data);
    for (const client of clients) {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(msg);
        }
    }
}

export function broadcastDownloadProgress(jobId: string, progress: {
    status: string;
    title: string;
    percent: number;
    speed: string;
    eta: string;
    downloaded: string;
    total: string;
}) {
    broadcast({
        type: "download_progress",
        jobId,
        ...progress,
        timestamp: Date.now(),
    });
}

export function broadcastDownloadComplete(jobId: string, data: {
    title: string;
    type: string;
    path: string;
    success: boolean;
    error?: string;
}) {
    broadcast({
        type: "download_complete",
        jobId,
        title: data.title,
        downloadType: data.type,
        path: data.path,
        success: data.success,
        error: data.error,
        timestamp: Date.now(),
    });
}

export function broadcastNewDownload(data: {
    jobId: string;
    title: string;
    type: string;
    requestedBy: string;
}) {
    broadcast({
        type: "new_download",
        jobId: data.jobId,
        title: data.title,
        downloadType: data.type,
        requestedBy: data.requestedBy,
        timestamp: Date.now(),
    });
}

export function getClientCount(): number {
    return clients.size;
}
