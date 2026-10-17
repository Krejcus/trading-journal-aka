/**
 * Krátká hláška po změně profilu grafů: „Změněno pro všechny grafy · Vrátit“.
 *
 * Profil platí ve všech grafech appky, takže změna v jednom grafu se projeví
 * všude — hláška to řekne a nabídne jedním klikem návrat. Vykresluje se přímo
 * do `document.body` mimo React: fullscreen graf schovává kořen appky
 * (`#root`), hláška ale musí být vidět i nad ním.
 */

const VISIBLE_MS = 6_000;

let element: HTMLDivElement | null = null;
let hideTimer: number | null = null;

const hide = () => {
  if (hideTimer !== null) window.clearTimeout(hideTimer);
  hideTimer = null;
  element?.remove();
  element = null;
};

export const dismissChartProfileToast = (): void => hide();

export const announceChartProfileChange = (message: string, undo?: () => void): void => {
  if (typeof document === 'undefined') return;
  hide();
  const box = document.createElement('div');
  box.setAttribute('role', 'status');
  box.setAttribute('data-chart-profile-toast', '');
  box.setAttribute('data-snapshot-hide', '');
  Object.assign(box.style, {
    position: 'fixed',
    left: '50%',
    bottom: '24px',
    transform: 'translateX(-50%)',
    zIndex: '2000',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '8px 10px 8px 14px',
    borderRadius: '10px',
    background: 'rgba(15, 23, 42, 0.94)',
    color: '#f8fafc',
    font: '600 12px Inter, ui-sans-serif, system-ui, sans-serif',
    boxShadow: '0 18px 40px -16px rgba(0, 0, 0, 0.55)',
  } satisfies Partial<CSSStyleDeclaration>);
  const text = document.createElement('span');
  text.textContent = message;
  box.appendChild(text);
  if (undo) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Vrátit';
    Object.assign(button.style, {
      border: '0',
      borderRadius: '6px',
      padding: '5px 10px',
      background: '#2962ff',
      color: '#ffffff',
      font: 'inherit',
      cursor: 'pointer',
    } satisfies Partial<CSSStyleDeclaration>);
    button.addEventListener('click', () => {
      hide();
      undo();
    });
    box.appendChild(button);
  }
  document.body.appendChild(box);
  element = box;
  hideTimer = window.setTimeout(hide, VISIBLE_MS);
};
