import { db } from '@/db';
import { accounts } from '@/db/schema';
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

export async function GET() {
    try {
        const allAccounts = await db.select().from(accounts).orderBy(accounts.createdAt);
        return NextResponse.json(allAccounts);
    } catch (error) {
        console.error('Fetch Accounts Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { name, initialBalance, currency } = body;

        if (!name) {
            return NextResponse.json({ error: 'Name is required' }, { status: 400 });
        }

        const newAccount = await db.insert(accounts).values({
            name,
            initialBalance: parseFloat(initialBalance) || 0,
            currency: currency || 'USD',
            isDefault: false, // First one could be default logic later
        }).returning();

        return NextResponse.json(newAccount[0]);
    } catch (error) {
        console.error('Create Account Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
