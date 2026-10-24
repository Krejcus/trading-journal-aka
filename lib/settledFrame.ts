/**
 * Okamžik, kdy se stránka „uklidnila“: několik plynulých snímků za sebou
 * (hlavní vlákno už nekreslí dashboard). Animace spuštěné tady jsou vidět
 * celé a plynulé — spuštěné během načítání by proběhly schovaně nebo trhaně.
 * Všechny karty, které se ptají ve stejné chvíli, dostanou stejný okamžik,
 * takže se rozjedou společně.
 */

const STABLE_FRAMES = 6;
const FRAME_BUDGET_MS = 34;
const MAX_WAIT_MS = 2_500;

let pending: Promise<void> | null = null;
let settledAt = 0;

export function whenFramesSettle(): Promise<void> {
  if (typeof window === 'undefined' || typeof requestAnimationFrame !== 'function') return Promise.resolve();
  // Čerstvě uklidněno (např. karta přidaná o chvíli později) → hned.
  if (!pending && performance.now() - settledAt < 400) return Promise.resolve();
  if (pending) return pending;
  pending = new Promise<void>(resolve => {
    const started = performance.now();
    let last = started;
    let stable = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(fallback);
      document.removeEventListener('visibilitychange', onVisible);
      settledAt = performance.now(); pending = null; resolve();
    };
    const tick = (now: number) => {
      if (done) return;
      stable = now - last <= FRAME_BUDGET_MS ? stable + 1 : 0;
      last = now;
      if (stable >= STABLE_FRAMES || now - started >= MAX_WAIT_MS) finish();
      else requestAnimationFrame(tick);
    };
    // Pojistka, když snímky neběží (přiškrcený panel): na viditelné stránce
    // po limitu stejně pustit; skrytá stránka počká, až bude vidět.
    const onVisible = () => { if (document.visibilityState === 'visible') fallback = window.setTimeout(finish, 300); };
    let fallback = window.setTimeout(() => {
      if (document.visibilityState === 'visible') finish();
      else document.addEventListener('visibilitychange', onVisible);
    }, MAX_WAIT_MS + 300);
    requestAnimationFrame(tick);
  });
  return pending;
}
