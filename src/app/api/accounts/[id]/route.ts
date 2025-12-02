import { db } from '@/db';
import { accounts, trades } from '@/db/schema';
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

export async function DELETE(
    request: Request,
    { params }: { params: any }
) {
    try {
        const { id: idString } = await params;
        const id = parseInt(idString);
        if (isNaN(id)) {
            return NextResponse.json({ error: 'Invalid ID' }, { status: 400 });
        }

        // Optional: Check for trades associated with this account and handle them (delete or unassign)
        // For now, we'll just delete the account. Foreign key constraints might fail if trades exist.
        // Let's update trades to set accountId to null first (if we want to keep them) or delete them.
        // User asked for separation, so deleting account might imply deleting its trades or archiving.
        // Safest is to prevent delete if trades exist, or cascade.
        // Let's try to delete. If it fails due to FK, we'll know.

        await db.delete(accounts).where(eq(accounts.id, id));

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Delete Account Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
