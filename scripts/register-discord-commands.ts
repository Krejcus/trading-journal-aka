import fetch from 'node-fetch';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const APP_ID = process.env.DISCORD_APP_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!APP_ID || !BOT_TOKEN) {
    console.error("Missing DISCORD_APP_ID or DISCORD_BOT_TOKEN in .env.local");
    process.exit(1);
}

const commands = [
    {
        name: 'mentor',
        description: 'Zeptej se svého Alpha Mentora na radu nebo analýzu',
        options: [
            {
                name: 'dotaz',
                description: 'Co máš na srdci?',
                type: 3, // STRING
                required: true,
            }
        ]
    }
];

async function registerCommands() {
    console.log(`Registering slash commands for App ID: ${APP_ID}...`);
    try {
        const response = await fetch(`https://discord.com/api/v10/applications/${APP_ID}/commands`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bot ${BOT_TOKEN}`
            },
            body: JSON.stringify(commands)
        });

        if (!response.ok) {
            const data = await response.json();
            console.error("Failed to register commands:", JSON.stringify(data, null, 2));
        } else {
            console.log("Successfully registered slash commands!");
        }
    } catch (error) {
        console.error("Error registering commands:", error);
    }
}

registerCommands();
