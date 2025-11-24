import { NextResponse } from 'next/server';
import { db } from '@/db';
import { trades } from '@/db/schema';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        console.log("📥 Webhook received:", body);

        // Basic validation
        if (!body.symbol || !body.side || !body.entry) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
        }

        // Insert into database
        const result = await db.insert(trades).values({
            symbol: body.symbol,
            side: body.side,
            entryPrice: parseFloat(body.entry),
            exitPrice: body.exit ? parseFloat(body.exit) : null,
            size: body.size || 1,
            status: body.status || 'OPEN',
            entryTime: body.time || Math.floor(Date.now() / 1000),
            notes: body.notes || '',
        }).returning();

        return NextResponse.json({ success: true, trade: result[0] });
    } catch (error) {
        console.error('Webhook Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
