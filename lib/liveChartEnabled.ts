/**
 * Jediný vypínač obrazovky LIVE → Graf (PC i telefon) včetně všeho, co na ní
 * žije: lístek příkazu, čáry SL/TP, rychlé zadání, alerty na cenu a zvuky
 * vyplnění.
 *
 * Filip 12. 11. 2026: obchodování z appky se zmrazuje, příkazy se zadávají
 * u brokera a appka zůstává kopírkou s pojistkami a přehledem. Kód grafu se
 * nemaže, jen se nepřipojí — záložka zmizí a její balíček se nikdy nenačte.
 *
 * Je to čistě zobrazovací přepínač: nic neautorizuje a nic neposílá. Návrat
 * je změna na `true` plus zapnutí příslušných přepínačů workera.
 */
export const LIVE_CHART_ENABLED = false;
