
/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
    readonly VITE_SUPABASE_URL: string
    readonly VITE_SUPABASE_ANON_KEY: string
    readonly VITE_GEMINI_API_KEY?: string
    readonly VITE_NATIVE_BUILD?: string
    readonly VITE_API_ORIGIN?: string
    readonly VITE_NATIVE_AUTH_REDIRECT?: string
}

interface ImportMeta {
    readonly env: ImportMetaEnv
}
