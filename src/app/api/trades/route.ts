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
