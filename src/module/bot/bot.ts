import "node:process";
import { TelegramClient } from "teleproto";
import { StoreSession } from "teleproto/sessions/index.js";
// import { NewMessage } from "teleproto/events/index.js";

import { env } from "../../common/utils/env.js";

const apiId = Number(env.TG_API_ID);
const apiHash = env.TG_API_HASH;

// Disk-backed session — persists under ./bot-session/
const session = new StoreSession("bot-session");

const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
});

export default client;
