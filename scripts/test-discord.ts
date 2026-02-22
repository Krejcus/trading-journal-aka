import { sendDiscordNotification } from '../services/discord/webhook';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function run() {
    console.log("Testing Discord Webhook to URL:", process.env.DISCORD_WEBHOOK_URL ? "SET" : "NOT SET");
    await sendDiscordNotification({
        id: "test",
        instrument: "NQ",
        direction: "Long",
        pnl: 150,
        setup: "M5 Orderblock",
        notes: "This is a test message from the Alpha Trade CLI to verify webhook connectivity."
    } as any, 'CREATE');
    console.log("Done.");
}
run();
