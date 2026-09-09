import "node:process";
import { TelegramClient } from "teleproto";
import { StoreSession } from "teleproto/sessions/index.js";
import { ConnectionTCPObfuscated } from "teleproto/network/connection/TCPObfuscated.js";

import { env } from "../../common/utils/env.js";

const apiId = Number(env.TG_API_ID);
const apiHash = env.TG_API_HASH;

// Disk-backed session — persists under ./bot-session/
const session = new StoreSession("bot-session");

const client = new TelegramClient(session, apiId, apiHash, {
    connection: ConnectionTCPObfuscated,
    connectionRetries: 5,
    autoReconnect: true,
});

// Patch getDC to bypass unreachable mediaOnly IPs on certain ISP routing networks (e.g. 91.108.56.114)
const _origGetDC = client.getDC.bind(client);
client.getDC = async function (dcId: number, downloadDC: boolean = false) {
    try {
        const res = await _origGetDC(dcId, downloadDC);
        if (res?.ipAddress === "91.108.56.114") {
            return await _origGetDC(dcId, false);
        }
        return res;
    } catch {
        return await _origGetDC(dcId, false);
    }
};

let _connected = false;
let _connecting = false;

export function isBotConnected(): boolean {
    return _connected && Boolean((client as any).connected);
}

export function isBotConnecting(): boolean {
    return _connecting;
}

export function setBotConnected(val: boolean) {
    _connected = val;
}

export function setBotConnecting(val: boolean) {
    _connecting = val;
}

export async function ensureBotConnected(): Promise<boolean> {
    if (isBotConnected()) return true;
    if (_connecting) {
        // Wait up to 5s if already connecting
        for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 500));
            if (isBotConnected()) return true;
            if (!_connecting) break;
        }
        return isBotConnected();
    }
    try {
        setBotConnecting(true);
        console.log("[BOT] Checking/re-establishing Telegram connection...");
        await Promise.race([
            client.connect(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Telegram connection attempt timed out")), 8000))
        ]);
        const isAuth = await client.checkAuthorization();
        if (isAuth) {
            const me = await client.getMe();
            setBotConnected(true);
            setBotConnecting(false);
            console.log(`[BOT] Connected as ${(me as any)?.username ?? (me as any)?.firstName ?? (me as any)?.id}`);
            return true;
        } else {
            console.log("[BOT] Connected to MTProto, but session is not authorized.");
            setBotConnected(false);
            return false;
        }
    } catch (err: any) {
        setBotConnected(false);
        console.log("[BOT] Auto-reconnect not successful:", err.message);
    } finally {
        setBotConnecting(false);
    }
    return isBotConnected();
}

// ─── Web-based Auth State Machine ───
// Used when bot needs re-auth from the web UI

type AuthStep = "idle" | "need_phone" | "need_code" | "need_password" | "authenticating" | "done" | "error";

let authState: {
    step: AuthStep;
    phone?: string;
    code?: string;
    password?: string;
    error?: string;
    phoneResolver?: (value: string) => void;
    codeResolver?: (value: string) => void;
    passwordResolver?: (value: string) => void;
} = { step: "idle" };

export function getAuthState() {
    return { step: authState.step, error: authState.error, phone: authState.phone };
}

export function submitPhone(phone: string): { ok: boolean; error?: string } {
    if (authState.step !== "need_phone" && !authState.phoneResolver) {
        return { ok: false, error: "Not waiting for phone" };
    }
    authState.phone = phone;
    if (authState.phoneResolver) {
        const resolver = authState.phoneResolver;
        authState.phoneResolver = undefined;
        authState.step = "authenticating";
        resolver(phone);
    }
    return { ok: true };
}

export function submitCode(code: string): { ok: boolean; error?: string } {
    if (authState.step !== "need_code" && !authState.codeResolver) {
        return { ok: false, error: "Not waiting for code" };
    }
    authState.code = code;
    if (authState.codeResolver) {
        const resolver = authState.codeResolver;
        authState.codeResolver = undefined;
        authState.step = "authenticating";
        resolver(code);
    }
    return { ok: true };
}

export function submitPassword(password: string): { ok: boolean; error?: string } {
    if (authState.step !== "need_password" && !authState.passwordResolver) {
        return { ok: false, error: "Not waiting for password" };
    }
    authState.password = password;
    if (authState.passwordResolver) {
        const resolver = authState.passwordResolver;
        authState.passwordResolver = undefined;
        authState.step = "authenticating";
        resolver(password);
    }
    return { ok: true };
}

export async function startWebAuth(): Promise<{ ok: boolean; step?: string; error?: string }> {
    if (isBotConnected()) return { ok: true, step: "done" };
    if (_connecting) return { ok: false, error: "Already connecting" };

    // Reset state
    authState = { step: "authenticating" };
    setBotConnecting(true);

    try {
        await client.start({
            phoneNumber: async () => {
                authState.step = "need_phone";
                console.log("[BOT AUTH] Waiting for phone number...");
                return new Promise<string>((resolve) => {
                    authState.phoneResolver = resolve;
                });
            },
            phoneCode: async () => {
                authState.step = "need_code";
                console.log("[BOT AUTH] Waiting for code...");
                return new Promise<string>((resolve) => {
                    authState.codeResolver = resolve;
                });
            },
            password: async () => {
                authState.step = "need_password";
                console.log("[BOT AUTH] Waiting for 2FA password...");
                return new Promise<string>((resolve) => {
                    authState.passwordResolver = resolve;
                });
            },
            onError: async (err: Error) => {
                console.error("[BOT AUTH] Error:", err.message);
                authState.step = "error";
                authState.error = err.message;
                return false;
            },
        });

        const me = await client.getMe();
        setBotConnected(true);
        setBotConnecting(false);
        authState.step = "done";
        console.log(`[BOT AUTH] Connected as ${(me as any)?.username ?? (me as any)?.firstName}`);
        return { ok: true, step: "done" };
    } catch (err: any) {
        setBotConnected(false);
        setBotConnecting(false);
        authState.step = "error";
        authState.error = err.message;
        console.error("[BOT AUTH] Failed:", err.message);
        return { ok: false, error: err.message };
    }
}

export default client;

