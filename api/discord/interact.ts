import { verifyKey, InteractionType, InteractionResponseType } from 'discord-interactions';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import { ALPHA_SYSTEM_PROMPT } from '../../services/discord/prompt.js';

export const config = {
    runtime: 'edge'
};

// Start the AI background task
async function processAIInteractionAsync(userPrompt: string, interactionToken: string, appId: string) {
    try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            await sendDiscordFollowup(appId, interactionToken, "Chyba: Není nastaven GEMINI_API_KEY.");
            return;
        }

        const ai = new GoogleGenAI({ apiKey });
        
        const supabaseUrl = process.env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co';
        const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        
        let dynamicContext = "\n[SYSTÉMOVÁ DATA - PAMĚŤ]\nNebyla nalezena čerstvá data v rychlém kontextu.\n";

        if (supabaseServiceKey) {
            const supabase = createClient(supabaseUrl, supabaseServiceKey, {
                auth: { persistSession: false }
            });
            
            // Reduced to 3 to prevent Google Gemini API Rate Limits 429
            const { data: recentTrades, error: tradesErr } = await supabase.from('trades')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(3);
                
            console.log("Supabase fetch returned trades length:", recentTrades?.length);
            if (tradesErr) console.error("Supabase trades error:", tradesErr);

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
            `Aktuální načtené obchody (posledních 3):\n${tradeText}\n\n` +
            `Celkové PnL z těchto posledních obchodů: $${netPnl.toFixed(2)}\n\n` +
            `(Pokud trader požádá o ukázání některého obchodu nebo nejlepšího/nejhoršího obchodu, najdi URL screenshotu a vlož ho ukrytý v Markdown syntaxi takto: ![Graph](URL). Markdown způsobí bezpečné vykreslení i z Firebase storage v chatu.)\n`;
        }

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                { role: 'user', parts: [{ text: ALPHA_SYSTEM_PROMPT }] },
                { role: 'model', parts: [{ text: "Rozumím. Jsem Alpha Mentor a bedlivě tě sleduji. Jakmile uvidím URL screenshotu obchodu, vykreslím jej v Markdownu např.: ![Graf](https://firebasestorage.googleapis.com/...)" }] },
                { role: 'user', parts: [{ text: dynamicContext + "\n\nTrader Filip se ptá:\n" + userPrompt }] }
            ]
        });

        const text = response.text || "Omlouvám se, jsem teď myšlenkami jinde.";
        const finalContent = text.length > 2000 ? text.substring(0, 1995) + '...' : text;
        
        await sendDiscordFollowup(appId, interactionToken, finalContent);

    } catch (err: any) {
        console.error("AI/Background error:", err.message || err);
        let errorMsg = "Při generování odpovědi u Googlu došlo k nečekané chybě (možná vyčerpaný limit tokenů).";
        
        if (err.status === 429 || (err.message && err.message.includes("429"))) {
            errorMsg = "⚠️ **Chyba Google AI (Kód 429 - Vyčerpané Tokeny)**\nVyčerpali jsme dostupný Free-limit tokenů u Google Gemini. Zkus to prosím znovu za minutu, nebo si aktivuj na Google AI Studio placený účet pro tyto masivní datové analýzy.";
        }
        await sendDiscordFollowup(appId, interactionToken, errorMsg);
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
        if (!res.ok) {
            console.error("Discord Followup failed:", await res.text());
        }
    } catch(e) {
        console.error("Failed to cleanly update Discord message:", e);
    }
}

export default async function handler(req: Request, ctx: any) {
    if (req.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    const signature = req.headers.get('x-signature-ed25519');
    const timestamp = req.headers.get('x-signature-timestamp');
    const clientPublicKey = process.env.DISCORD_PUBLIC_KEY;

    if (!signature || !timestamp || !clientPublicKey) {
        return new Response('Missing Signature or Public Key', { status: 401 });
    }

    const rawBody = await req.text();
    const isValidRequest = await verifyKey(rawBody, signature, timestamp, clientPublicKey);

    if (!isValidRequest) {
        console.error('Invalid Request Signature');
        return new Response('Bad request signature', { status: 401 });
    }

    const interaction = JSON.parse(rawBody);

    if (interaction.type === InteractionType.PING) {
        return new Response(JSON.stringify({ type: InteractionResponseType.PONG }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
        const { name, options } = interaction.data;

        if (name === 'mentor') {
            const userPrompt = options?.[0]?.value || '';

            // Using Vercel Edge Runtime's strict waitUntil logic
            ctx.waitUntil(processAIInteractionAsync(userPrompt, interaction.token, interaction.application_id));
            
            return new Response(JSON.stringify({
                type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }

    return new Response('Unknown Interaction Type', { status: 400 });
}
