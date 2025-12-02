import { pgTable, serial, text, real, integer, timestamp, boolean } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const accounts = pgTable('accounts', {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    initialBalance: real('initial_balance').notNull().default(0),
    currency: text('currency').notNull().default('USD'),
    isDefault: boolean('is_default').default(false),
    createdAt: timestamp('created_at').default(sql`now()`),
});

export const trades = pgTable('trades', {
    id: serial('id').primaryKey(),
    accountId: integer('account_id').references(() => accounts.id), // Foreign Key
    symbol: text('symbol').notNull(),
    side: text('side').notNull(), // LONG or SHORT
    entryPrice: real('entry_price').notNull(),
    exitPrice: real('exit_price'),
    slPrice: real('sl_price'), // Stop Loss
    tpPrice: real('tp_price'), // Take Profit
    size: real('size').notNull(),
    pnl: real('pnl'),
    status: text('status').notNull(), // OPEN, CLOSED, WIN, LOSS
    entryTime: integer('entry_time').notNull(), // Unix timestamp
    exitTime: integer('exit_time'), // Unix timestamp
    notes: text('notes'),
    screenshotUrl: text('screenshot_url'),
    createdAt: timestamp('created_at').default(sql`now()`),
});

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Trade = typeof trades.$inferSelect;
export type NewTrade = typeof trades.$inferInsert;
