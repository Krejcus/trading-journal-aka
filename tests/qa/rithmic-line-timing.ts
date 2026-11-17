// Pouze na vyžádání na simulátoru. Všechny časy používají hodiny stejné stránky.
export function measureSimulationLine() {
  const report = document.createElement('output');
  report.setAttribute('aria-label', 'Měření Limitu');
  report.style.cssText = 'position:fixed;top:46px;left:6px;z-index:700;color:white;background:#182336;padding:4px 10px;pointer-events:none';
  document.body.append(report);
  let clicked = 0;
  let sample: { id: string; start: number; ack?: number; frame?: number } | null = null;
  function show() {
    if (sample?.ack === undefined || sample.frame === undefined) return;
    report.textContent = `Klik → odpověď ${(sample.ack - sample.start).toFixed(1)} ms · klik → snímek s čárou ${(sample.frame - sample.start).toFixed(1)} ms`;
  }
  document.addEventListener('click', () => { clicked = performance.now(); }, true);
  const NativeSocket = window.WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener('message', event => {
        const data = JSON.parse(event.data);
        if (sample && data.type === 'reply' && data.id === sample.id && data.ok) { sample.ack = performance.now(); show(); }
      });
    }
    send(data: Parameters<WebSocket['send']>[0]) {
      if (typeof data === 'string') {
        const msg = JSON.parse(data);
        if (msg.command?.op === 'entry' && msg.command.orderType === 'Limit') sample = { id: msg.id, start: clicked };
      }
      super.send(data);
    }
  };
  let scheduled = false;
  new MutationObserver(() => {
    if (!sample || sample.frame !== undefined || scheduled || !document.querySelector('[aria-label^="Posunout "][aria-label*="čeká na vyplnění"]')) return;
    scheduled = true;
    const active = sample;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      scheduled = false;
      if (sample === active) { active.frame = performance.now(); show(); }
    }));
  }).observe(document.body, { subtree: true, childList: true, attributeFilter: ['aria-label'] });
}
