import { NextResponse } from 'next/server';
import { db } from '@/db';
import { trades } from '@/db/schema';
import { desc } from 'drizzle-orm';

export async function GET() {
    try {
        const result = await db.select().from(trades).orderBy(desc(trades.entryTime)).limit(50);
        return NextResponse.json(result);
    } catch (error) {
        console.error('Database Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();

        // Basic validation
        if (!body.symbol || !body.side || !body.entryPrice || !body.entryTime) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
        }

        // Calculate PnL if closed
        let pnl = null;
        let status = body.status || 'OPEN';

        if (body.exitPrice) {
            const entry = parseFloat(body.entryPrice);
            const exit = parseFloat(body.exitPrice);
            const size = parseFloat(body.size) || 1;

            if (body.side === 'LONG') {
                pnl = (exit - entry) * size;
            } else {
                pnl = (entry - exit) * size;
            }

            // Auto-detect status if not provided
            if (!body.status || body.status === 'OPEN') {
                status = pnl > 0 ? 'WIN' : 'LOSS';
            }
        }

        const result = await db.insert(trades).values({
            symbol: body.symbol,
            side: body.side,
            entryPrice: parseFloat(body.entryPrice),
            exitPrice: body.exitPrice ? parseFloat(body.exitPrice) : null,
            slPrice: body.slPrice ? parseFloat(body.slPrice) : null,
            tpPrice: body.tpPrice ? parseFloat(body.tpPrice) : null,
            size: parseFloat(body.size) || 1,
            status: status,
            entryTime: Math.floor(new Date(body.entryTime).getTime() / 1000),
            exitTime: body.exitTime ? Math.floor(new Date(body.exitTime).getTime() / 1000) : null,
            pnl: pnl,
            notes: body.notes || '',
        }).returning();

        return NextResponse.json({ success: true, trade: result[0] });
    } catch (error) {
        console.error('Create Trade Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
