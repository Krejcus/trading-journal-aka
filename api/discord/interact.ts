import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { verifyKey, InteractionType, InteractionResponseType } from 'discord-interactions';
import { createClient } from '@supabase/supabase-js';
import { ALPHA_SYSTEM_PROMPT } from '../../services/discord/prompt.js';

export const config = {
    api: { bodyParser: false },
    maxDuration: 60
};

async function processAIInteractionAsync(userPrompt: string, interactionToken: string, appId: string) {
    try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            await sendDiscordFollowup(appId, interactionToken, "Chyba: Není nastaven GEMINI_API_KEY.");
            return;
        }

        const supabaseUrl = process.env.VITE_SUPABASE_URL;
        const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        let dynamicContext = "\n[SYSTÉMOVÁ DATA - PAMĚŤ]\n";

        if (supabaseServiceKey && supabaseUrl) {
            try {
                const supabase = createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } });
                const { data: recentTrades, error: tradesErr } = await supabase.from('trades')
                    .select('*')
                    .order('created_at', { ascending: false })
                    .limit(3);

                if (recentTrades && recentTrades.length > 0) {
                    const tradeText = recentTrades.map(t => {
                        const data = t.data || {};
                        const screenshots = data.screenshots && data.screenshots.length > 0 ? `Screenshot: ${data.screenshots[0]}` : '';
                        return `- Datum: ${t.created_at?.split('T')[0]}, Přístroj: ${t.instrument}, Směr: ${t.direction}, Výsledek: ${t.pnl}$, Setup: ${data.setup || 'N/A'} ${screenshots}`;
                    }).join('\n');
                    dynamicContext += `Aktuální načtené obchody (posledních 3):\n${tradeText}\n(Použij markdown pro fotky: ![Graf](url))\n`;
                } else {
                    dynamicContext += "Žádné nedávné obchody nenalezeny.\n";
                }
            } catch (e) {
                console.error("Supabase Error:", e);
                dynamicContext += "Chyba při stahování dat ze Supabase.\n";
            }
        }

        let finalContent = "Omlouvám se, dnes už na mě byla moc velká zátěž.";

        try {
            const aiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [
                        { role: 'user', parts: [{ text: ALPHA_SYSTEM_PROMPT }] },
                        { role: 'model', parts: [{ text: "Rozumím. Jsem Alpha Mentor." }] },
                        { role: 'user', parts: [{ text: dynamicContext + "\n\nTrader Filip se ptá:\n" + userPrompt }] }
                    ]
                })
            });

            if (!aiResponse.ok) {
                const errData = await aiResponse.json().catch(() => ({}));
                console.error("Gemini Native Fetch Error:", aiResponse.status, errData);
                if (aiResponse.status === 429) throw new Error("QUOTA_429");
                throw new Error("HTTP_ERROR_" + aiResponse.status);
            }

            const responseData = await aiResponse.json();
            const text = responseData.candidates?.[0]?.content?.parts?.[0]?.text || "Žádná odpověď z AI.";
            finalContent = text.length > 2000 ? text.substring(0, 1995) + '...' : text;

        } catch (apiErr: any) {
            console.error("Raw AI Fetch crash:", apiErr.message);
            if (apiErr.message === "QUOTA_429") {
                finalContent = "⚠️ **Zpráva od Mentora: Chyba připojení na AI (Kód 429)**\nOmlouvám se Filipe, narazil jsem na Rate Limit od Googlu. Přečerpal jsi bezplatnou kvótu u Gemini API!";
            } else {
                finalContent = `⚠️ Zpráva od Mentora: Neočekávaná chyba u Googlu: ${apiErr.message}`;
            }
        }

        await sendDiscordFollowup(appId, interactionToken, finalContent);

    } catch (err: any) {
        console.error("Global background error:", err);
        await sendDiscordFollowup(appId, interactionToken, "Kritický výpadek systému. Zkuste to později.");
    }
}

async function sendDiscordFollowup(appId: string, token: string, content: string) {
    const url = `https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`;
    try {
        const res = await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
        if (!res.ok) console.error("Discord Followup failed:", await res.text());
        else console.log("Discord Followup SENT successfully.");
    } catch (e) {
        console.error("Failed to cleanly update Discord message:", e);
    }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') return res.status(405).end('Method Not Allowed');

    const signature = req.headers['x-signature-ed25519'] as string;
    const timestamp = req.headers['x-signature-timestamp'] as string;
    const clientPublicKey = process.env.DISCORD_PUBLIC_KEY;

    if (!signature || !timestamp || !clientPublicKey) return res.status(401).end('Missing Signature or Public Key');

    const rawBody = await new Promise<string>((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });

    const isValidRequest = await verifyKey(rawBody, signature, timestamp, clientPublicKey);
    if (!isValidRequest) return res.status(401).end('Bad request signature');

    const interaction = JSON.parse(rawBody);

    if (interaction.type === InteractionType.PING) {
        return res.status(200).json({ type: InteractionResponseType.PONG });
    }

    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
        const { name, options } = interaction.data;

        if (name === 'mentor') {
            const userPrompt = options?.[0]?.value || '';

            waitUntil(processAIInteractionAsync(userPrompt, interaction.token, interaction.application_id));

            return res.status(200).json({
                type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
            });
        }
    }

    return res.status(400).end('Unknown Interaction Type');
}
