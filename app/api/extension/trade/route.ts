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

        // Validate required fields
        if (!symbol || !entryTime || !direction) {
            console.error('[Extension API] Missing required fields:', { symbol, entryTime, direction });
            return NextResponse.json({
                error: 'Missing required fields: symbol, entryTime, and direction are mandatory'
            }, { status: 400 });
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

        // Calculate exit time based on duration (if provided)
        const durationMin = body.duration ? parseInt(body.duration) : 0;
        const entryDateObj = entryTime ? new Date(entryTime) : new Date();
        const exitDateObj = new Date(entryDateObj.getTime() + (durationMin * 60000));

        const tradeData: any = {
            user_id: session.user.id,
            account_id: accountId,
            symbol: symbol,
            instrument: symbol, // Map to standard instrument field
            entry_date: entryDateObj.toISOString(),
            date: exitDateObj.toISOString().split('T')[0],
            timestamp: exitDateObj.getTime(), // Use local computer time for consistency
            status: tradeStatus,
            outcome: outcome,
            direction: direction || 'LONG',
            planned_rr: body.rrr ? safeFloat(body.rrr) : null,

            // Map inputs correctly. Popup sends 'tp' and 'sl' and 'entry'
            entry_price: safeFloat(entry),
            stop_loss: safeFloat(stop) || safeFloat(sl),
            take_profit: safeFloat(target) || safeFloat(tp),
            risk_amount: safeFloat(risk),
            pnl: safeFloat(body.pnl) || 0,
            duration_minutes: durationMin,

            notes: body.notes || "Imported from AlphaTrade Bridge",
            image_url: screenshotUrl,
            session: 'NY'
        };

        // Map entry_time for frontend compatibility (TradeDetailModal looks for this)
        tradeData.entry_time = entryDateObj.getTime();

        // CRITICAL: Frontend expects a 'data' JSONB column that contains the full trade object
        tradeData.data = {
            ...tradeData,
            accountId: accountId,
            entryPrice: tradeData.entry_price,
            exitPrice: safeFloat(body.exit) || safeFloat(body.exitPrice),
            stopLoss: tradeData.stop_loss,
            takeProfit: tradeData.take_profit,
            riskAmount: tradeData.risk_amount,
            durationMinutes: durationMin,
            entryTime: entryDateObj.getTime(), // Frontend uses this
            entryDate: entryDateObj.toISOString(), // Also provide ISO format
            screenshot: screenshotUrl,
            screenshots: screenshotUrl ? [screenshotUrl] : [],
            isValid: true
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
