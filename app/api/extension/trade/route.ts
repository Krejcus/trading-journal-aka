import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
    try {
        const supabase = createRouteHandlerClient({ cookies });

        // Check authentication
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await request.json();
        const { symbol, risk, entryTime, screenshot, entry, stop, target, tp, sl, direction, status, accountId } = body;

        if (!symbol || !entryTime || !accountId) {
            return NextResponse.json({ error: 'Missing required fields (Symbol, Time, Account)' }, { status: 400 });
        }

        // 1. Upload Screenshot if exists
        let screenshotUrl = null;
        if (screenshot) {
            // Convert Base64 to Buffer
            const base64Data = screenshot.replace(/^data:image\/\w+;base64,/, "");
            const buffer = Buffer.from(base64Data, 'base64');

            const fileName = `extension_upload_${Date.now()}.png`;
            const { data: uploadData, error: uploadError } = await supabase
                .storage
                .from('trade-images')
                .upload(fileName, buffer, {
                    contentType: 'image/png',
                    upsert: false
                });

            if (uploadError) {
                console.error('Screenshot upload error:', uploadError);
            } else {
                const { data: { publicUrl } } = supabase
                    .storage
                    .from('trade-images')
                    .getPublicUrl(fileName);
                screenshotUrl = publicUrl;
            }
        }

        // 2. Create Trade
        // Determine Status and Outcome
        const tradeStatus = (status === 'WIN' || status === 'LOSS' || status === 'BE') ? 'CLOSED' : 'OPEN';
        let outcome = null;
        if (status === 'WIN') outcome = 'WIN';
        if (status === 'LOSS') outcome = 'LOSS';
        if (status === 'BE') outcome = 'BE';

        // Helper to parse potential string numbers
        const safeFloat = (val: any) => val ? parseFloat(val) : null;

        const tradeData = {
            user_id: session.user.id,
            account_id: accountId, // Required field
            symbol: symbol,
            entry_date: entryTime, // ISO string from popup
            status: tradeStatus,
            outcome: outcome,
            direction: direction || 'LONG', // Default to Long if unknown
            planned_rr: body.rrr ? safeFloat(body.rrr) : null,

            // Map inputs correctly. Popup sends 'tp' and 'sl' and 'entry'
            entry_price: safeFloat(entry),
            stop_loss: safeFloat(stop) || safeFloat(sl), // Fallback
            take_profit: safeFloat(target) || safeFloat(tp), // Fallback
            risk_amount: safeFloat(risk),

            notes: "Imported from AlphaTrade Bridge",
            image_url: screenshotUrl,
            session: 'NY' // Default or infer from time?
        };

        const { data: trade, error: tradeError } = await supabase
            .from('trades')
            .insert([tradeData])
            .select()
            .single();

        if (tradeError) {
            throw new Error(tradeError.message);
        }

        const response = NextResponse.json({ success: true, trade });

        // Add CORS headers for Chrome Extension
        const origin = request.headers.get('origin');
        if (origin) {
            response.headers.set('Access-Control-Allow-Origin', origin);
            response.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
            response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            response.headers.set('Access-Control-Allow-Credentials', 'true');
        }

        return response;

    } catch (error: any) {
        console.error('Extension API Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

export async function OPTIONS(request: Request) {
    const response = NextResponse.json({}, { status: 200 });
    const origin = request.headers.get('origin');
    if (origin) {
        response.headers.set('Access-Control-Allow-Origin', origin);
        response.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
        response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        response.headers.set('Access-Control-Allow-Credentials', 'true');
    }
    return response;
}
