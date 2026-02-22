import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyKey, InteractionType, InteractionResponseType } from 'discord-interactions';
import { GoogleGenAI } from '@google/genai';
import { supabase } from '../../services/supabase.js';
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

                // Fetch recent context for the user 
                // In multi-tenant, we would use interaction.user.id or interaction.member.user.id to find the user in DB
                // For now, let's fetch the most recent trades broadly if it's a single user app, or just pass a generic context

                let dynamicContext = "\n[SYSTÉMOVÁ DATA - PAMĚŤ]\nNebyla nalezena čerstvá data v rychlém kontextu.\n";

                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: [
                        { role: 'user', parts: [{ text: ALPHA_SYSTEM_PROMPT }] },
                        { role: 'model', parts: [{ text: "Rozumím. Jsem Alpha Mentor." }] },
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
