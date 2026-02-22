import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyKey, InteractionType, InteractionResponseType } from 'discord-interactions';
import { createClient } from '@supabase/supabase-js';
import { ALPHA_SYSTEM_PROMPT } from '../../services/discord/prompt.js';

export const config = {
    api: { bodyParser: false },
    maxDuration: 60
};

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

            try {
                // RUNNING EVERYTHING SYNCHRONOUSLY IN UNDER 2.5 SECONDS
                const apiKey = process.env.GEMINI_API_KEY;
                if (!apiKey) throw new Error("Missing AI Key");

                const supabaseUrl = process.env.VITE_SUPABASE_URL;
                const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
                
                let dynamicContext = "\n[SYSTÉMOVÁ DATA]\n";

                if (supabaseServiceKey && supabaseUrl) {
                    const supabase = createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } });
                    // Limit 1 trade to maximize speed!
                    const { data: recentTrades } = await supabase.from('trades')
                        .select('*')
                        .order('created_at', { ascending: false })
                        .limit(1);

                    if (recentTrades && recentTrades.length > 0) {
                        const t = recentTrades[0];
                        const data = t.data || {};
                        const screenshots = data.screenshots && data.screenshots.length > 0 ? `Screenshot: ${data.screenshots[0]}` : '';
                        dynamicContext += `Poslední obchod: Datum: ${t.created_at?.split('T')[0]}, Přístroj: ${t.instrument}, Směr: ${t.direction}, Výsledek: ${t.pnl}$, Setup: ${data.setup || 'N/A'} ${screenshots}\n(Použij markdown pro fotky: ![Graf](url))\n`;
                    } else {
                        dynamicContext += "Žádné nedávné obchody.\n";
                    }
                }

                // Call AI with a 2-second timeout guard
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 2000);

                const aiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    signal: controller.signal,
                    body: JSON.stringify({
                        contents: [
                            { role: 'user', parts: [{ text: "Jsi Alpha Mentor. Odpovídej stručně. Zhodnoť data obchodu níže. Očekávej max 1 fotografii." }] },
                            { role: 'user', parts: [{ text: dynamicContext + "\n\nOtázka tradera:\n" + userPrompt }] }
                        ]
                    })
                });

                clearTimeout(timeout);

                if (!aiResponse.ok) {
                    throw new Error("AI status: " + aiResponse.status);
                }

                const responseData = await aiResponse.json();
                let text = responseData.candidates?.[0]?.content?.parts?.[0]?.text || "Žádná odpověď z AI.";
                text = text.length > 2000 ? text.substring(0, 1995) + '...' : text;

                // WE RETURN THE MESSAGE DIRECTLY IN THE HTTP RESPONSE!
                // NO DEFERRALS. NO BACKGROUND TASKS. NO TIMEOUTS.
                return res.status(200).json({
                    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                    data: {
                        content: text
                    }
                });

            } catch (err: any) {
                console.error("Sync AI error:", err.message);
                
                let fallbackMessage = "⚠️ Omlouvám se, server Vercel to nestihl odbavit do 3 vteřin pro Discord nebo padl limit na AI. Jsem online, ale chci příliš mnoho času na přemýšlení.";
                if (err.name === 'AbortError') fallbackMessage = "⚠️ AI neodpověděla v limitu 2 vteřin (Discord povolí jen 3 vteřiny). Mám asi pomalé vedení u Googlu.";
                
                // Return an error directly to the chat
                return res.status(200).json({
                    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                    data: {
                        content: fallbackMessage
                    }
                });
            }
        }
    }

    return res.status(400).end('Unknown Interaction Type');
}
