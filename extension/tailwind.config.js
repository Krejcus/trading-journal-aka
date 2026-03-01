/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                alpha: {
                    bg: 'rgba(255, 255, 255, 0.7)',
                    panel: 'rgba(255, 255, 255, 0.25)',
                    accent: '#0891b2',
                    accentGlow: 'rgba(8, 145, 178, 0.2)',
                    text: '#0f172a', /* slate-900 */
                    muted: '#64748b', /* slate-500 */
                    border: 'rgba(148, 163, 184, 0.3)',
                    glassBorder: 'rgba(255, 255, 255, 0.8)',
                    success: '#059669',
                    danger: '#e11d48',
                }
            },
            fontFamily: {
                sans: ['Inter', 'sans-serif'],
                outfit: ['Outfit', 'sans-serif'],
            },
            boxShadow: {
                'glass': '0 25px 50px -12px rgba(0, 0, 0, 0.25), inset 0 0 0 1px rgba(255, 255, 255, 0.3)',
            }
        },
    },
    plugins: [],
}
