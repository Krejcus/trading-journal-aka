import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

// Allowed origins for Chrome Extension CORS
const ALLOWED_ORIGINS = [
    'chrome-extension://', // Chrome extensions
    'https://alphatrade-mentor-15.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000',
];

function isAllowedOrigin(origin: string | null): boolean {
    if (!origin) return false;
    return ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed));
}

function setCorsHeaders(response: NextResponse, origin: string | null, methods: string) {
    if (origin && isAllowedOrigin(origin)) {
        response.headers.set('Access-Control-Allow-Origin', origin);
        response.headers.set('Access-Control-Allow-Methods', methods);
        response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        response.headers.set('Access-Control-Allow-Credentials', 'true');
    }
}

export async function GET(request: Request) {
    try {
        const supabase = createRouteHandlerClient({ cookies });

        // Check authentication
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { data: accounts, error } = await supabase
            .from('accounts')
            .select('id, name, type, currency')
            .eq('user_id', session.user.id)
            .eq('status', 'Active')
            .order('created_at', { ascending: false });

        if (error) {
            throw new Error(error.message);
        }

        const response = NextResponse.json({ success: true, accounts });
        setCorsHeaders(response, request.headers.get('origin'), 'GET, OPTIONS');
        return response;

    } catch (error: any) {
        console.error('Extension Accounts Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

export async function OPTIONS(request: Request) {
    const response = NextResponse.json({}, { status: 200 });
    setCorsHeaders(response, request.headers.get('origin'), 'GET, OPTIONS');
    return response;
}
