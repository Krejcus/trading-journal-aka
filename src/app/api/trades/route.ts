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
        const { symbol, side, entryPrice, exitPrice, slPrice, tpPrice, size, entryTime, exitTime, notes, accountId } = body;

        if (!symbol || !side || !entryPrice || !size || !entryTime) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
        }

        // Calculate PnL if exit price exists
        let pnl = null;
        let status = "OPEN";
        if (exitPrice) {
            const entry = parseFloat(entryPrice);
            const exit = parseFloat(exitPrice);
            const s = parseFloat(size);

            // Simple PnL calculation (needs refinement for contract value)
            // Assuming NQ $20/point for now as per user context
            const multiplier = 20;
            if (side === "LONG") {
                pnl = (exit - entry) * multiplier * s;
            } else {
                pnl = (entry - exit) * multiplier * s;
            }
            status = pnl > 0 ? "WIN" : "LOSS";
        }

        const newTrade = await db.insert(trades).values({
            symbol,
            side,
            entryPrice: parseFloat(entryPrice),
            exitPrice: exitPrice ? parseFloat(exitPrice) : null,
            slPrice: slPrice ? parseFloat(slPrice) : null,
            tpPrice: tpPrice ? parseFloat(tpPrice) : null,
            size: parseFloat(size),
            pnl,
            status,
            entryTime: Math.floor(new Date(entryTime).getTime() / 1000),
            exitTime: exitTime ? Math.floor(new Date(exitTime).getTime() / 1000) : null,
            notes,
            accountId: accountId ? parseInt(accountId) : null, // Save accountId
        }).returning();

        return NextResponse.json({ success: true, trade: newTrade[0] });
    } catch (error) {
        console.error('Create Trade Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
