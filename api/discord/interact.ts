import { verifyKey, InteractionType, InteractionResponseType } from 'discord-interactions';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import { ALPHA_SYSTEM_PROMPT } from '../../services/discord/prompt.js';

// Helper function to process AI in the background and reply to Discord later
async function processAIInteractionAsync(userPrompt: string, interactionToken: string, appId: string) {
    try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            await sendDiscordFollowup(appId, interactionToken, "Chyba: Není nastaven GEMINI_API_KEY.");
            return;
        }

        const ai = new GoogleGenAI({ apiKey });
        
        const supabaseUrl = process.env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co';
        // Note: process.env works in Edge for Vercel, but let's be absolutely loud about it in logs
        const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        
        console.log("EDGE RUNTIME DEBUG:");
        console.log("- VITE_SUPABASE_URL exists:", !!supabaseUrl);
        console.log("- SUPABASE_SERVICE_ROLE_KEY exists:", !!supabaseServiceKey, supabaseServiceKey ? `(starts with ${supabaseServiceKey.substring(0, 10)})` : '');
        
        let dynamicContext = "\n[SYSTÉMOVÁ DATA - PAMĚŤ]\nNebyla nalezena čerstvá data v rychlém kontextu.\n";

        if (supabaseServiceKey) {
            const supabase = createClient(supabaseUrl, supabaseServiceKey, {
                auth: { persistSession: false }
            });
            const { data: recentTrades, error: tradesErr } = await supabase.from('trades')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(10);
                
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
            } else {
                tradeText = "Databáze úspěšně odpověděla, ale seznam vrací 0 položek (ověř RLS/klíče!).";
            }

            dynamicContext = `\n[SYSTÉMOVÁ DATA - EXTRÉMNÍ PAMĚŤ]\n` +
            `Aktuální načtené obchody (posledních 10):\n${tradeText}\n\n` +
            `Celkové PnL z těchto posledních obchodů: $${netPnl.toFixed(2)}\n\n` +
            `(Pokud trader požádá o ukázání některého obchodu nebo nejlepšího/nejhoršího obchodu, vždy se podívej do dat výše a pro vykreslení screenshotu VŽDY použij Markdown syntaxi takto: ![Graph](URL-ODKAZ) i přesto že to není validní URL struktura. Markdown způsobí bezpečné vykreslení i z Firebase storage v chatu.)\n`;
        } else {
             dynamicContext = "\n[SYSTÉMOVÁ DATA - PAMĚŤ]\nService Role klíč nebyl nalezen v proměnných!\n";
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
        // Discord max limit
        const finalContent = text.length > 2000 ? text.substring(0, 1995) + '...' : text;
        
        await sendDiscordFollowup(appId, interactionToken, finalContent);

    } catch (err) {
        console.error("AI/Background error:", err);
        await sendDiscordFollowup(appId, interactionToken, "Chyba při komunikaci s mentorem nebo databází. Podívej se do logů Vercelu (Edge Error).");
    }
}

async function sendDiscordFollowup(appId: string, token: string, content: string) {
    const url = `https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`;
    try {
        await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
    } catch(e) {
        console.error("Failed to cleanly update Discord message:", e);
    }
}

// Edge Runtime syntax
export const config = {
    runtime: 'edge'
};

export default async function handler(req: Request, ctx: { waitUntil: (promise: Promise<any>) => void }) {
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

    // Acknowledge PING from Discord
    if (interaction.type === InteractionType.PING) {
        return new Response(JSON.stringify({ type: InteractionResponseType.PONG }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Handle Slash Command
    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
        const { name, options } = interaction.data;

        if (name === 'mentor') {
            const userPrompt = options?.[0]?.value || '';

            // DISCORD 3-SECOND TIMEOUT FIX:
            // 1. Immediately send DEFERRED response so the UI shows "Alpha Mentor is thinking..."
            // 2. Fire the AI generation in the background without waiting for it to finish.
            
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
