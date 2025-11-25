import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import dotenv from 'dotenv';

dotenv.config();

// Prevent build failure if DATABASE_URL is missing (e.g. during static generation)
const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/postgres';

if (!process.env.DATABASE_URL) {
    console.warn('⚠️ DATABASE_URL is missing. Using dummy connection string for build.');
}

const client = postgres(connectionString);
export const db = drizzle(client, { schema });
