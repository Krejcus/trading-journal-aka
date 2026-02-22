import { verifyKey, InteractionType, InteractionResponseType } from 'discord-interactions';
import { createClient } from '@supabase/supabase-js';
import { ALPHA_SYSTEM_PROMPT } from '../../services/discord/prompt.js';

export const config = {
    runtime: 'edge'
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
        let imageToAnalyze: { data: string, mime: string } | null = null;
        let base64ToAttach: string | null = null;

        if (supabaseServiceKey && supabaseUrl) {
            try {
                const supabase = createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } });

                // Fetch full trade data including 'data' column which has screenshots
                const { data: recentTrades, error: tradesErr } = await supabase.from('trades')
                    .select('*')
                    .order('created_at', { ascending: false })
                    .limit(3);

                if (recentTrades && recentTrades.length > 0) {
                    const tradeText = recentTrades.map((t, index) => {
                        const data = t.data || {};
                        let screenshotInfo = 'Žádný';

                        if (data.screenshots && data.screenshots.length > 0) {
                            const url = data.screenshots[0];
                            if (url.startsWith('http')) {
                                screenshotInfo = `URL: ${url}`;
                            } else if (url.startsWith('data:image/')) {
                                screenshotInfo = 'Přiložen k analýze (Base64)';
                                // If it's the very first trade, we'll try to analyze the image
                                if (index === 0) {
                                    const parts = url.split(',');
                                    if (parts.length === 2) {
                                        imageToAnalyze = {
                                            mime: url.match(/data:([^;]+);/)?.[1] || 'image/png',
                                            data: parts[1]
                                        };
                                        base64ToAttach = parts[1];
                                    }
                                }
                            }
                        }

                        return `- Datum: ${t.created_at?.split('T')[0]}, Přístroj: ${t.instrument}, Směr: ${t.direction}, Výsledek: ${t.pnl}$, Setup: ${data.setup || 'N/A'}, Graf: ${screenshotInfo}`;
                    }).join('\n');

                    dynamicContext += `Aktuální načtené obchody (posledních 3):\n${tradeText}\n`;
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
            const contents: any[] = [
                { role: 'user', parts: [{ text: ALPHA_SYSTEM_PROMPT }] },
                { role: 'model', parts: [{ text: "Rozumím. Jsem Alpha Mentor. Vidím tvoje data i grafy." }] }
            ];

            const userPart: any = { role: 'user', parts: [{ text: dynamicContext + "\n\nTrader Filip se ptá:\n" + userPrompt }] };

            // If we have an image, add it to the Gemini prompt
            if (imageToAnalyze) {
                userPart.parts.push({
                    inline_data: {
                        mime_type: imageToAnalyze.mime,
                        data: imageToAnalyze.data
                    }
                });
            }

            contents.push(userPart);

            const aiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents })
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
                finalContent = "⚠️ **Chyba Gemini (Kód 429)**\nNarazil jsem na limit tokenů. Zkuste to za minutu.";
            } else {
                finalContent = `⚠️ Chyba AI: ${apiErr.message}`;
            }
        }

        await sendDiscordFollowup(appId, interactionToken, finalContent, base64ToAttach);

    } catch (err: any) {
        console.error("Global background error:", err);
        await sendDiscordFollowup(appId, interactionToken, "Kritický výpadek systému. Zkuste to později.");
    }
}

async function sendDiscordFollowup(appId: string, token: string, content: string, base64Image?: string | null) {
    const url = `https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`;

    try {
        if (base64Image) {
            // Multipart/form-data for image attachment
            const formData = new FormData();

            // Build the payload_json
            formData.append('payload_json', JSON.stringify({ content }));

            // Convert Base64 to Blob
            const binary = atob(base64Image);
            const array = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                array[i] = binary.charCodeAt(i);
            }
            const blob = new Blob([array], { type: 'image/png' });

            formData.append('files[0]', blob, 'chart.png');

            const res = await fetch(url, {
                method: 'PATCH',
                body: formData
            });

            if (!res.ok) console.error("Discord Followup (Multipart) failed:", await res.text());
            else console.log("Discord Followup SENT with attachment.");
        } else {
            // Simple JSON followup
            const res = await fetch(url, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content })
            });
            if (!res.ok) console.error("Discord Followup failed:", await res.text());
            else console.log("Discord Followup SENT successfully.");
        }
    } catch (e) {
        console.error("Failed to update Discord message:", e);
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
