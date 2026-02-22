import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyKey, InteractionType, InteractionResponseType } from 'discord-interactions';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import { ALPHA_SYSTEM_PROMPT } from '../../services/discord/prompt.js';

export const config = {
    api: {
        bodyParser: false,
    },
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') {
        return res.status(405).end('Method Not Allowed');
    }

    const signature = req.headers['x-signature-ed25519'] as string;
    const timestamp = req.headers['x-signature-timestamp'] as string;
    const clientPublicKey = process.env.DISCORD_PUBLIC_KEY;

    if (!signature || !timestamp || !clientPublicKey) {
        return res.status(401).end('Missing Signature or Public Key');
    }

    // Get raw body
    const rawBody = await new Promise<string>((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });

    const isValidRequest = await verifyKey(rawBody, signature, timestamp, clientPublicKey);

    if (!isValidRequest) {
        console.error('Invalid Request Signature');
        return res.status(401).end('Bad request signature');
    }

    const interaction = JSON.parse(rawBody);

    // Acknowledge PING from Discord
    if (interaction.type === InteractionType.PING) {
        return res.status(200).json({ type: InteractionResponseType.PONG });
    }

    // Handle Slash Command
    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
        const { name, options } = interaction.data;

        if (name === 'mentor') {
            const userPrompt = options?.[0]?.value || '';

            // Let's initially respond quickly to Discord to avoid the 3s timeout
            // In a real production scale app we would DEFER and process via a background queue.
            // For Alpha Trade MVP, let's call Gemini and hope it's fast enough.
            try {
                const apiKey = process.env.GEMINI_API_KEY;
                if (!apiKey) {
                    return res.status(200).json({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: { content: "Chyba: Není nastaven GEMINI_API_KEY." }
                    });
                }

                const ai = new GoogleGenAI({ apiKey });

                // Init Supabase Service Role Client
                const supabaseUrl = process.env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co';
                const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

                let dynamicContext = "\n[SYSTÉMOVÁ DATA - PAMĚŤ]\nNebyla nalezena čerstvá data v rychlém kontextu.\n";

                if (supabaseServiceKey) {
                    const supabase = createClient(supabaseUrl, supabaseServiceKey);

                    // Fetch recent trades broadly (for the single-trader MVP, we just grab the newest trades across the platform, or we grab the profile that actually HAS trades)
                    const { data: recentTrades } = await supabase.from('trades')
                        .select('*, profiles(full_name, username)')
                        .order('created_at', { ascending: false })
                        .limit(10);

                    let netPnl = 0;
                    let tradeText = "Žádné nedávné obchody.";

                    if (recentTrades && recentTrades.length > 0) {
                        netPnl = recentTrades.reduce((acc, trade) => acc + (Number(trade.pnl) || 0), 0);
                        tradeText = recentTrades.map(t => {
                            const data = t.data || {};
                            const screenshots = data.screenshots && data.screenshots.length > 0
                                ? `\nScreenshot: ${data.screenshots[0]}`
                                : '';
                            return `- Datum: ${t.created_at?.split('T')[0]}, Přístroj: ${t.instrument}, Směr: ${t.direction}, Výsledek: ${t.pnl}$, Setup: ${data.setup || 'N/A'}${screenshots}`;
                        }).join('\n');
                    }

                    dynamicContext = `\n[SYSTÉMOVÁ DATA - EXTRÉMNÍ PAMĚŤ]\n` +
                        `Aktuální načtené obchody (posledních 10):\n${tradeText}\n\n` +
                        `Celkové PnL z těchto posledních obchodů: $${netPnl.toFixed(2)}\n\n` +
                        `(Pokud trader požádá o ukázání některého obchodu nebo nejlepšího/nejhoršího obchodu, vždy se podívej do dat výše, najdi URL screenshotu a vlož ho do své odpovědi ukrytý v Markdown syntaxi takto: ![Název Grafu](URL-ODKAZ). To způsobí, že se graf na Discordu vykreslí.)\n`;
                }

                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: [
                        { role: 'user', parts: [{ text: ALPHA_SYSTEM_PROMPT }] },
                        { role: 'model', parts: [{ text: "Rozumím. Jsem Alpha Mentor a bedlivě tě sleduji. Jakmile uvidím screenshot obchodu, který chceš ukázat, vykreslím jej v Markdownu." }] },
                        { role: 'user', parts: [{ text: dynamicContext + "\n\nTrader Filip se ptá:\n" + userPrompt }] }
                    ]
                });

                const text = response.text || "Omlouvám se, jsem teď myšlenkami jinde.";

                return res.status(200).json({
                    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                    data: {
                        content: text.length > 2000 ? text.substring(0, 1995) + '...' : text
                    }
                });

            } catch (err) {
                console.error(err);
                return res.status(200).json({
                    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                    data: { content: "Chyba při komunikaci s mentorem. Zkus to znovu." }
                });
            }
        }
    }

    return res.status(400).end('Unknown Interaction Type');
}
