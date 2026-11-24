// Záložka LIVE „Kopírka“ (22. 11. 2026): obrazovka kopírky nad SKUTEČNÝM účtem ze služby Rithmic na Macu.
// Kopírka ve službě zatím není → jen tvůj účet jako leader, žádní followeři, žádné vymyšlené čísla.
// Zapnutí řekne, že se připravuje; akce bez napojení (zastavit, šablony, zavření, doplnění) se vůbec neukážou.
// JEN ČTENÍ: spojení se službou slouží jen ke čtení stavu; nic odtud neposílá příkazy (INV-UI-*).
import React, { Suspense, lazy, useMemo, useState } from 'react';
import { useRithmicLocalTrading } from '../../hooks/useRithmicLocalTrading';
import { rithmicLocalAuth, rithmicLocalUrl } from '../../lib/rithmicLocalLink';
import { rithmicCopierViewFromService, type CopierGate } from '../../lib/rithmicCopierView';
import { RithmicCopierPhone, RithmicCopierScreen, type CopierActions } from './RithmicCopierScreen';
import type { CopierDemoScenario } from './CopierDemo';
import { isNativeBuild } from '../../utils/runtimeConfig';

// Ukázka se smyšlenými daty: vývojová appka (localhost) a appka v iPhonu (rozhodnutí Filipa 24. 11.: chce ji vidět
// v telefonu). Na produkčním webu ne. Ukázka nic neposílá: všechny akce mění jen stav v paměti (INV-UI-01).
const DEMO_ALLOWED = import.meta.env?.DEV === true || isNativeBuild;
const CopierDemo = DEMO_ALLOWED ? lazy(() => import('./CopierDemo')) : null;
const DEMO_KEY = 'at:dev:copier-demo';
const DEMO_CHOICES: Array<{ id: CopierDemoScenario | null; label: string }> = [
  { id: null, label: 'Skutečný účet' }, { id: 'before', label: 'Před obchodem' }, { id: 'trade', label: 'V obchodu' }, { id: 'after', label: 'Po obchodu' }, { id: 'problem', label: 'Problém' },
];
const readDemo = (): CopierDemoScenario | null => {
  if (!DEMO_ALLOWED) return null;
  try { const v = window.localStorage.getItem(DEMO_KEY); return v === 'before' || v === 'trade' || v === 'after' || v === 'problem' ? v : null; } catch { return null; }
};

const NOT_READY: CopierGate = { label: 'Kopírka ve službě Rithmic', detail: 'se připravuje — zapnout půjde, až služba na Macu bude umět kopírovat na followery', ok: false };
const ACTIONS: CopierActions = { onArm: () => ({ ok: false, gate: NOT_READY }), onDisarm: () => undefined };

const RithmicCopierTab: React.FC<{ open: boolean; narrow: boolean; isDark: boolean; /** Jen zkušební stránka: lokální simulace služby. */ simulationUrl?: string }> = ({ open, narrow, isDark, simulationUrl }) => {
  const url = useMemo(() => simulationUrl ?? rithmicLocalUrl(), [simulationUrl]);
  const auth = useMemo(() => (simulationUrl ? null : rithmicLocalAuth()), [simulationUrl]);
  const [demo, setDemoState] = useState<CopierDemoScenario | null>(readDemo);
  const setDemo = (next: CopierDemoScenario | null) => { setDemoState(next); try { if (next) window.localStorage.setItem(DEMO_KEY, next); else window.localStorage.removeItem(DEMO_KEY); } catch { /* jen tato záložka */ } };
  const trading = useRithmicLocalTrading({ url, enabled: open && url != null && demo == null, auth });
  const summary = trading.position?.summary?.kind === 'position' ? trading.position.summary : null;
  const positionKnown = trading.link === 'open' && trading.helloFresh && trading.state != null && trading.position?.issueKind !== 'unknown';
  const view = useMemo(() => rithmicCopierViewFromService({
    accountName: trading.accountName, system: trading.system, closedPnl: trading.silent ? null : trading.accountClosedPnl, positionKnown,
    position: summary ? { side: summary.side, quantity: summary.quantity, entry: summary.entry, stop: summary.stop, target: summary.target } : null,
    price: trading.price, pointValue: trading.pointValue, maxContracts: trading.maxContracts,
  }), [trading.accountName, trading.system, trading.accountClosedPnl, trading.silent, positionKnown, summary?.side, summary?.quantity, summary?.entry, summary?.stop, summary?.target, trading.price, trading.pointValue, trading.maxContracts]); // eslint-disable-line react-hooks/exhaustive-deps
  const empty = url == null ? 'Kopírka běží přes službu Rithmic na Macu. Tohle zařízení s ní zatím není propojené (PC: odkaz s tokenem z Macu, telefon: spárování).'
    : trading.link !== 'open' ? 'Služba Rithmic na Macu není připojená. Jakmile poběží, ukáže se tu tvůj účet.'
      : 'Stav účtu u Rithmicu zatím není znám — čekám na první zprávu služby.';
  const note = <>Kopírka pro Rithmic se <b>připravuje</b>. Zatím tu vidíš jen svůj účet ze služby na Macu; followery půjde přidat a kopírku zapnout, až to služba bude umět.</>;
  const shown = view ?? { accounts: {}, groups: [], pointValue: 2, price: null };
  const demoBar = DEMO_ALLOWED ? (
    <div data-copier-demo-bar style={{ position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: narrow ? 96 : 14, zIndex: 60, display: 'flex', gap: 4, alignItems: 'center', padding: 5, borderRadius: 11, background: 'rgba(15,18,35,.94)', border: '1px solid rgba(255,255,255,.14)', font: '600 11.5px system-ui', color: '#cbd5e1', maxWidth: 'calc(100vw - 24px)', overflowX: 'auto' }}>
      <span style={{ padding: '0 6px', opacity: 0.7, whiteSpace: 'nowrap' }}>Ukázka</span>
      {DEMO_CHOICES.map(c => <button key={c.id ?? 'real'} type="button" onClick={() => setDemo(c.id)} style={{ height: 26, padding: '0 9px', borderRadius: 7, whiteSpace: 'nowrap', border: 0, cursor: 'pointer', font: 'inherit', color: demo === c.id ? '#fff' : '#cbd5e1', background: demo === c.id ? 'rgba(99,102,241,.75)' : 'rgba(255,255,255,.07)' }}>{c.label}</button>)}
    </div>
  ) : null;
  if (demo && CopierDemo) return <>{demoBar}<Suspense fallback={null}><CopierDemo scenario={demo} narrow={narrow} isDark={isDark} /></Suspense></>;
  return <>{demoBar}{narrow
    ? <RithmicCopierPhone view={shown} actions={ACTIONS} isDark={isDark} note={note} emptyNote={empty} />
    : <RithmicCopierScreen view={shown} actions={ACTIONS} isDark={isDark} note={note} emptyNote={empty} />}</>;
};

export default RithmicCopierTab;
