import { NextResponse } from 'next/server';
import { db } from '@/db';
import { trades } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function DELETE(
    request: Request,
    { params }: { params: { id: string } }
) {
    try {
        const id = parseInt(params.id);
        if (isNaN(id)) {
            return NextResponse.json({ error: 'Invalid ID' }, { status: 400 });
        }

        await db.delete(trades).where(eq(trades.id, id));

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Delete Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
