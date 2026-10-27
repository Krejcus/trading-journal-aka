/**
 * Náběh stránky jako na dashboardu po startu: bloky stránky (widgety, karty,
 * sekce) postupně vyjedou zdola a prolnou se. Stejné křivky a časování jako
 * BootTransition, takže start appky i přechod mezi stránkami působí stejně.
 *
 * Bloky se hledají obecně (bez úprav jednotlivých stránek): nejvyšší
 * karto-podobné prvky v pořadí dokumentu, jen ty na obrazovce. Obal vyšší než
 * obrazovka se přeskočí, aby se animovaly jeho karty, ne celá stránka najednou.
 */

export const PAGE_ENTER_EASE = 'cubic-bezier(.16, 1, .3, 1)';
export const PAGE_ENTER_MS = 600;
export const PAGE_ENTER_STEP_MS = 45;
const MAX_BLOCKS = 14;

const BLOCK_SELECTOR = [
  '.react-grid-item > *',
  '[data-page-enter]',
  '.theme-card',
  '.glass-panel',
  'article',
  'section',
  '.rounded-lg',
  '.rounded-xl',
].join(', ');

export interface EnterRect { top: number; bottom: number; width: number; height: number }

/** Je prvek blok k animaci? (Čistá logika — testovatelná bez DOMu.) */
export function isEnterBlock(rect: EnterRect, viewportHeight: number): boolean {
  if (rect.width < 160 || rect.height < 48) return false;
  if (rect.bottom <= 0 || rect.top >= viewportHeight) return false;
  // Obal přes celou obrazovku: animovat jeho obsah, ne jeho samotný.
  return rect.height <= viewportHeight * 0.75;
}

export function collectEnterBlocks(root: ParentNode, viewportHeight = window.innerHeight, max = MAX_BLOCKS): HTMLElement[] {
  const picked: HTMLElement[] = [];
  for (const element of root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)) {
    if (picked.length >= max) break;
    if (element.closest('[data-page-enter-skip]')) continue;
    // Pořadí dokumentu: předek je vybrán dřív než potomek.
    if (picked.some(block => block.contains(element))) continue;
    if (!isEnterBlock(element.getBoundingClientRect(), viewportHeight)) continue;
    const position = getComputedStyle(element).position;
    if (position === 'fixed' || position === 'sticky') continue;
    picked.push(element);
  }
  return picked;
}

const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

/** Celoplošné `animate-in` obalu stránky by se s náběhem bloků sčítalo. */
function cancelWrapperEntrances(root: Element, blocks: readonly HTMLElement[]): void {
  for (const animation of root.getAnimations({ subtree: true })) {
    if (!(animation instanceof CSSAnimation) || animation.animationName !== 'enter') continue;
    const target = (animation.effect as KeyframeEffect | null)?.target;
    if (target instanceof Element && blocks.some(block => target !== block && target.contains(block))) animation.cancel();
  }
}

export function playPageEnter(root: Element, blocks: readonly HTMLElement[], options: { delay?: number; firstIndex?: number } = {}): Animation[] {
  if (blocks.length === 0 || reducedMotion()) return [];
  cancelWrapperEntrances(root, blocks);
  const delay = options.delay ?? 0;
  const firstIndex = options.firstIndex ?? 0;
  return blocks.map((block, index) => block.animate([
    { opacity: 0, transform: 'translateY(22px) scale(.98)' },
    { opacity: 1, transform: 'none' },
  ], {
    duration: PAGE_ENTER_MS,
    delay: delay + (firstIndex + index) * PAGE_ENTER_STEP_MS,
    easing: PAGE_ENTER_EASE,
    fill: 'backwards',
  }));
}

/**
 * Náběh nově otevřené stránky. Volat z `useLayoutEffect` (DOM je hotový, ale
 * ještě nevykreslený): první várka se tak rozjede bez probliknutí. Bloky,
 * které se dokreslí později (líně načtená stránka, data z cache), zachytí
 * MutationObserver — jeho callback běží před dalším vykreslením, takže ani
 * ony neproblikly. Hlídá se jen krátce po přechodu a jen do počtu bloků.
 */
export function animatePageEnter(root: HTMLElement, windowMs = 900): () => void {
  if (reducedMotion()) return () => undefined;
  const animated: HTMLElement[] = [];
  let observer: MutationObserver | null = null;
  const run = () => {
    if (animated.length >= MAX_BLOCKS) {
      observer?.disconnect();
      return;
    }
    const blocks = collectEnterBlocks(root, window.innerHeight, MAX_BLOCKS - animated.length)
      .filter(block => !animated.some(seen => seen === block || seen.contains(block) || block.contains(seen)));
    if (blocks.length === 0) return;
    playPageEnter(root, blocks, { firstIndex: animated.length });
    animated.push(...blocks);
  };
  run();
  observer = new MutationObserver(run);
  observer.observe(root, { childList: true, subtree: true });
  const timer = window.setTimeout(() => observer?.disconnect(), windowMs);
  return () => {
    observer?.disconnect();
    window.clearTimeout(timer);
  };
}
