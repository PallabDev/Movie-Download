import client from "./module/bot/bot.js";
import { createInterface } from "node:readline/promises";

const rl = createInterface({ input: process.stdin, output: process.stdout });

await client.start({
    phoneNumber: () => rl.question("Phone: "),
    phoneCode: () => rl.question("Code from Telegram: "),
    password: () => rl.question("2FA password (if set): "),
    onError: async (err: Error) => {
        console.error(err);
        return false;
    },
});

const me = await client.getMe();
console.log("Signed in as", me.username ?? me.firstName ?? me.id);

const to = await rl.question(
    'Send to username/chat/phone, or "me" for Saved Messages: ',
);
const message = await rl.question("Message: ");

rl.close();

const sentMessage = await client.sendMessage(to.trim(), {
    message: message.trim(),
});

console.log(`Message sent. Telegram message id: ${sentMessage.id}`);
await client.disconnect();
