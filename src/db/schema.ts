import { pgTable, serial, text, real, integer, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const trades = pgTable('trades', {
    id: serial('id').primaryKey(),
    symbol: text('symbol').notNull(),
    side: text('side').notNull(), // LONG or SHORT
    entryPrice: real('entry_price').notNull(),
    exitPrice: real('exit_price'),
    size: real('size').notNull(),
    pnl: real('pnl'),
    status: text('status').notNull(), // OPEN, CLOSED, WIN, LOSS
    entryTime: integer('entry_time').notNull(), // Unix timestamp
    exitTime: integer('exit_time'), // Unix timestamp
    notes: text('notes'),
    screenshotUrl: text('screenshot_url'),
    createdAt: timestamp('created_at').default(sql`now()`),
});

export type Trade = typeof trades.$inferSelect;
export type NewTrade = typeof trades.$inferInsert;
