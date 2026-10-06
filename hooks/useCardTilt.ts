import { useEffect, type RefObject } from 'react';

/*
 * Náklon karty za myší / prstem / gyroskopem se skleněným odleskem — sdílí ho
 * Karta dne z LIVE i sdílecí karta obchodu, aby se obě chovaly stejně.
 * Obal dostává třídy `live-day-pressed` a `live-day-gyro` a proměnné
 * `--mx` / `--my`, na které je navázaný odlesk v CSS.
 */

export const reducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

type OrientationPermission = 'granted' | 'denied' | 'default';
type DeviceOrientationWithPermission = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<OrientationPermission>;
};

/**
 * iOS pustí gyroskop do webu až po `requestPermission()` zavolaném přímo
 * z klepnutí. V nativní appce ho Capacitor (WKUIDelegate) schválí bez
 * dialogu, v Safari se zeptá. Volá se proto synchronně z klepnutí na
 * „Dnešní P&L“ i z prvního dotyku karty; výsledek platí do zavření appky.
 */
let orientationPermission: Promise<boolean> | null = null;
export const primeDeviceTilt = (): Promise<boolean> => {
  if (orientationPermission) return orientationPermission;
  if (typeof window === 'undefined' || typeof DeviceOrientationEvent === 'undefined') return Promise.resolve(false);
  const request = (DeviceOrientationEvent as DeviceOrientationWithPermission).requestPermission;
  if (typeof request !== 'function') return (orientationPermission = Promise.resolve(true));
  orientationPermission = request.call(DeviceOrientationEvent)
    .then(state => {
      // Bez gesta prohlížeč odmítne; další klepnutí to smí zkusit znovu.
      if (state !== 'granted') orientationPermission = null;
      return state === 'granted';
    })
    .catch(() => {
      orientationPermission = null;
      return false;
    });
  return orientationPermission;
};

export function useCardTilt(
  wrapRef: RefObject<HTMLElement | null>,
  cardRef: RefObject<HTMLElement | null>,
  disabled = false,
): void {
  // Náklon a odlesk jako u Spotify. Konstanty jsou rozpětí okraj–okraj, na
  // kraji karty je tedy polovina. Myš: už najetí nakloní kartu výrazně
  // (±15°), stisk ji navíc lehce zamáčkne. Dotyk: zhoupnutí k místu prstu
  // (±15°) a pružný návrat po puštění. Telefon navíc sleduje gyroskop (±10°).
  // Píše se rovnou do stylu, aby se při pohybu nepřekresloval React strom.
  useEffect(() => {
    const wrap = wrapRef.current;
    const card = cardRef.current;
    if (!wrap || !card || reducedMotion() || disabled) return;
    const HOVER_DEG = 30;
    const PRESS_DEG = 30;
    const GYRO_DEG = 20;
    let pressed = false;
    let hovering = false;
    let gyro: { x: number; y: number } | null = null;
    const apply = (px: number, py: number, deg: number, transition: string, scale = 1) => {
      card.style.transition = transition;
      card.style.transform = `rotateX(${(0.5 - py) * deg}deg) rotateY(${(px - 0.5) * deg}deg)${scale !== 1 ? ` scale(${scale})` : ''}`;
      wrap.style.setProperty('--mx', `${px * 100}%`);
      wrap.style.setProperty('--my', `${py * 100}%`);
    };
    const point = (event: PointerEvent) => {
      const box = wrap.getBoundingClientRect();
      return {
        px: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
        py: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
      };
    };
    // Klidová poloha: gyroskop, jinak rovně. Pružný návrat s lehkým překmitem.
    const settle = () => {
      const spring = 'transform .7s cubic-bezier(.34,1.56,.64,1)';
      if (gyro) apply(0.5 + gyro.x / 2, 0.5 + gyro.y / 2, GYRO_DEG, spring);
      else {
        card.style.transition = 'transform .55s cubic-bezier(.34,1.56,.64,1)';
        card.style.transform = '';
      }
    };
    const move = (event: PointerEvent) => {
      const { px, py } = point(event);
      if (pressed) apply(px, py, PRESS_DEG, 'transform .09s ease-out', 0.985);
      else if (event.pointerType === 'mouse') {
        hovering = true;
        apply(px, py, HOVER_DEG, 'transform .12s linear');
      }
    };
    const down = (event: PointerEvent) => {
      // Karta obsahuje tlačítka (sdílení, zavření) — ta se nehoupou.
      if ((event.target as HTMLElement | null)?.closest('button, a, input')) return;
      pressed = true;
      wrap.classList.add('live-day-pressed');
      const { px, py } = point(event);
      apply(px, py, PRESS_DEG, 'transform .18s cubic-bezier(.2,.9,.3,1.2)', 0.985);
      if (event.pointerType !== 'mouse') void primeDeviceTilt().then(ok => { if (ok) startGyro(); });
    };
    const release = (event: PointerEvent) => {
      if (!pressed) return;
      pressed = false;
      wrap.classList.remove('live-day-pressed');
      if (event.pointerType === 'mouse' && event.type === 'pointerup') {
        const { px, py } = point(event);
        apply(px, py, HOVER_DEG, 'transform .6s cubic-bezier(.34,1.56,.64,1)');
      } else settle();
    };
    const leave = (event: PointerEvent) => {
      hovering = false;
      if (pressed) release(event);
      else settle();
    };

    // Gyroskop: klidová poloha je, jak telefon právě držíš, a pomalu se
    // k ní přizpůsobuje — karta se tak po položení telefonu sama srovná.
    let base: { beta: number; gamma: number } | null = null;
    let lastGyroPaint = 0;
    let listening = false;
    const orient = (event: DeviceOrientationEvent) => {
      if (event.beta == null || event.gamma == null) return;
      const angle = typeof screen !== 'undefined' ? screen.orientation?.angle ?? 0 : 0;
      const landscape = angle === 90 || angle === -90 || angle === 270;
      const sign = angle === -90 || angle === 270 ? -1 : 1;
      const beta = landscape ? event.gamma * sign : event.beta;
      const gamma = landscape ? -event.beta * sign : event.gamma;
      if (!base) base = { beta, gamma };
      base.beta += (beta - base.beta) * 0.015;
      base.gamma += (gamma - base.gamma) * 0.015;
      const clamp = (value: number) => Math.max(-1, Math.min(1, value));
      gyro = { x: clamp((gamma - base.gamma) / 18), y: clamp((beta - base.beta) / 18) };
      // Senzor chodí ~60× za sekundu; víc zápisů do stylu nemá smysl.
      const now = performance.now();
      if (pressed || hovering || now - lastGyroPaint < 16) return;
      lastGyroPaint = now;
      wrap.classList.add('live-day-gyro');
      apply(0.5 + gyro.x / 2, 0.5 + gyro.y / 2, GYRO_DEG, 'transform .15s linear');
    };
    const startGyro = () => {
      if (listening) return;
      listening = true;
      window.addEventListener('deviceorientation', orient);
    };
    // Na dotykových zařízeních zkusit hned — v nativní appce povolení už
    // zajistilo klepnutí na „Dnešní P&L“, jinde přijde s prvním dotykem.
    if (window.matchMedia?.('(pointer: coarse)').matches) {
      void primeDeviceTilt().then(ok => { if (ok) startGyro(); });
    }

    wrap.addEventListener('pointermove', move);
    wrap.addEventListener('pointerdown', down);
    wrap.addEventListener('pointerup', release);
    wrap.addEventListener('pointercancel', release);
    wrap.addEventListener('pointerleave', leave);
    return () => {
      wrap.removeEventListener('pointermove', move);
      wrap.removeEventListener('pointerdown', down);
      wrap.removeEventListener('pointerup', release);
      wrap.removeEventListener('pointercancel', release);
      wrap.removeEventListener('pointerleave', leave);
      window.removeEventListener('deviceorientation', orient);
    };
  }, [cardRef, disabled, wrapRef]);
}
