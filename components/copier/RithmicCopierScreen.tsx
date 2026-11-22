// Obrazovka kopírky Rithmic — PC i telefon (příprava 22. 11. 2026, napojí se na kopírku ve službě Rithmic).
// JEN ZOBRAZENÍ: všechno, co mění stav (zapnutí, zastavení, přepínače účtů, šablony, zavření, doplnění ochrany),
// jde přes `actions` — o provedení a bezpečnosti rozhoduje služba / jádro kopírky, ne tahle obrazovka.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import './copier.css';
import {
  COPIER_TABLE_STORAGE_KEY, copierGroupMembers, copierGroupSummary, copierOpenPnl, copierTileKind, parseCopierTableSettings, usdText,
  type CopierGate, type CopierGroup, type CopierTableSettings, type CopierView,
} from '../../lib/rithmicCopierView';
import {
  CopierAccountDetail, CopierFollowerTable, CopierGroupMenu, CopierGroupStrip, CopierPowerSwitch, CopierSettingsPanel, CopierTiles,
  FirmDot, SltpValue, shownName, statusChip, type PowerState,
} from './CopierParts';
import { playCopierEnergy } from './copierFx';

/** Co obrazovka umí vyvolat. Volitelné akce, které nejsou napojené, se v obrazovce vůbec neukážou (nic nepředstírá). */
export interface CopierActions {
  /** Požádá o zapnutí; vrátí bránu, která neprošla (obrazovka ji jen ukáže). */
  onArm: (groupId: string) => { ok: true } | { ok: false; gate: CopierGate };
  onDisarm: (groupId: string) => void;
  onKill?: () => void;
  onToggleCopy?: (accountId: string) => void;
  onBulk?: (groupId: string, action: 'on' | 'off' | 'ratio', ids: string[], value?: number) => void;
  onTemplate?: (groupId: string, ratio: number, max: number) => void;
  onFlatten?: (groupId: string) => void;
  onFixProtection?: (accountId: string) => void;
  onClosePosition?: (accountId: string) => void;
  /** Oprava brány „Účty způsobilé“: vypnout účet a zkusit znovu. */
  onDisableAccount?: (accountId: string) => void;
  onNewGroup?: () => void;
}

export function useCopierTableSettings(): [CopierTableSettings, (next: CopierTableSettings) => void] {
  const [settings, setSettings] = useState<CopierTableSettings>(() => {
    try { return parseCopierTableSettings(JSON.parse(window.localStorage.getItem(COPIER_TABLE_STORAGE_KEY) || 'null')); } catch { return parseCopierTableSettings(null); }
  });
  const save = useCallback((next: CopierTableSettings) => {
    setSettings(next);
    try { window.localStorage.setItem(COPIER_TABLE_STORAGE_KEY, JSON.stringify(next)); } catch { /* jen v tomto zařízení */ }
  }, []);
  return [settings, save];
}

const powerOf = (g: CopierGroup): { state: PowerState; sub: string } => (
  g.state === 'armed' ? { state: 'on', sub: 'zapnutá' } : g.state === 'disarmed' ? { state: 'off', sub: 'vypnutá · klik = zapnout' }
    : { state: 'block', sub: g.state === 'kill' ? 'kill do konce session' : 'neshoda pozic' });

/** Zapnutí / vypnutí + animace (komety z vypínače k dlaždicím) a řádek s důvodem, když se zapnout nedá. */
function useArm(group: CopierGroup | undefined, actions: CopierActions, root: React.RefObject<HTMLDivElement>, switches: Array<React.RefObject<HTMLButtonElement>>) {
  const [fail, setFail] = useState<CopierGate | null>(null), [shake, setShake] = useState(0), [fx, setFx] = useState<{ n: number; on: boolean } | null>(null);
  const prev = useRef<{ id: string; state: string } | null>(null);
  useEffect(() => {
    if (!group) return;
    const p = prev.current; prev.current = { id: group.id, state: group.state };
    if (!p || p.id !== group.id || p.state === group.state) return;
    const on = group.state === 'armed', off = p.state === 'armed';
    if (!on && !off) return;
    setFx(f => ({ n: (f?.n ?? 0) + 1, on }));
    requestAnimationFrame(() => playCopierEnergy(on, switches.map(s => s.current), [...(root.current?.querySelectorAll<HTMLElement>('[data-cp-tile]') ?? [])]));
  }, [group?.id, group?.state]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!fail) return undefined; const t = window.setTimeout(() => setFail(null), 9000); return () => window.clearTimeout(t); }, [fail]);
  const toggle = () => {
    if (!group) return;
    setFail(null);
    if (group.state === 'armed') { actions.onDisarm(group.id); return; }
    if (group.state !== 'disarmed') { setShake(n => n + 1); return; }
    const r = actions.onArm(group.id);
    if ('gate' in r) { setFail(r.gate); setShake(n => n + 1); }
  };
  return { fail, setFail, shake, fx, toggle };
}

function FailNote({ gate, onClose, onFix }: { gate: CopierGate; onClose: () => void; onFix?: (id: string) => void }) {
  return (
    <div className="cp-fail" onClick={(e) => e.stopPropagation()}>
      <b>Kopírka se nezapnula</b><span>{gate.label} · {gate.detail}</span>
      {gate.fixAccountId && onFix && <button type="button" className="cp-btn" style={{ marginTop: 8, height: 28, fontSize: 11.5 }} onClick={() => onFix(gate.fixAccountId!)}>Vypnout účet a zapnout</button>}
      <button type="button" className="x" onClick={onClose}>×</button>
    </div>
  );
}

// ─────────────────────────────── PC
export function RithmicCopierScreen({ view, actions, isDark = true, note = null, emptyNote = 'Žádná kopírovací skupina.' }: { view: CopierView; actions: CopierActions; isDark?: boolean; note?: React.ReactNode; emptyNote?: React.ReactNode }) {
  const [gi, setGi] = useState(0);
  const group = view.groups[Math.min(gi, view.groups.length - 1)];
  const [settings, setSettings] = useCopierTableSettings();
  const [panel, setPanel] = useState<null | 'settings' | { id: string }>(null), [menu, setMenu] = useState(false), [edit, setEdit] = useState(false);
  const root = useRef<HTMLDivElement>(null), sw = useRef<HTMLButtonElement>(null);
  const arm = useArm(group, actions, root, [sw]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { setPanel(null); setMenu(false); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);
  if (!group) return <div className={`cp-root${isDark ? '' : ' cp-light'}`} style={{ padding: 24 }}><div className="cp-card" style={{ padding: 18, fontSize: 13 }}>{emptyNote}</div></div>;
  const sum = copierGroupSummary(view, group, settings.sltp);
  const pw = powerOf(group);
  const openId = panel && typeof panel === 'object' ? panel.id : null;
  const openPositions = copierGroupMembers(group).filter(id => view.accounts[id]?.position).length;
  return (
    <div ref={root} className={`cp-root${isDark ? '' : ' cp-light'}`} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 12, padding: 16, minHeight: 640 }} onClick={() => { setPanel(null); setMenu(false); }} data-rithmic-copier>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 850, letterSpacing: '-.02em' }}>Kopírka</h1>
        <span className="cp-chip" style={{ height: 26, fontSize: 11.5 }}>Skupina dnes <b className={`cp-num ${sum.day == null ? '' : sum.day >= 0 ? 'cp-win' : 'cp-loss'}`} style={{ marginLeft: 6 }}>{usdText(sum.day)}</b></span>
        <span className="cp-chip" style={{ height: 26, fontSize: 11.5 }}>Otevřeno <b className={`cp-num ${sum.open >= 0 ? 'cp-win' : 'cp-loss'}`} style={{ marginLeft: 6 }}>{usdText(sum.open)}</b></span>
        <span style={{ flex: 1 }} />
        {actions.onNewGroup && <button type="button" className="cp-btn" onClick={actions.onNewGroup}>＋ Nová skupina</button>}
        <span style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
          <CopierPowerSwitch ref={sw} state={pw.state} sub={pw.sub} onClick={arm.toggle} shakeKey={arm.shake} fx={arm.fx} />
          {arm.fail && <FailNote gate={arm.fail} onClose={() => arm.setFail(null)} onFix={actions.onDisableAccount ? (id) => { arm.setFail(null); actions.onDisableAccount!(id); window.setTimeout(arm.toggle, 250); } : undefined} />}
        </span>
        {actions.onKill && <button type="button" className="cp-btn red" onClick={actions.onKill} title="Zastaví všechny skupiny do konce session. SL, TP a zavírání fungují dál.">⏻ Zastavit kopírku</button>}
      </div>

      {note && <div className="cp-card" style={{ padding: '10px 14px', fontSize: 12.5, borderColor: 'color-mix(in srgb,var(--cp-accent) 40%,transparent)' }}>{note}</div>}
      <div className="cp-card" style={{ padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <div className="cp-gtabs">{view.groups.map((g, i) => <button key={g.id} type="button" className={i === gi ? 'on' : ''} onClick={(e) => { e.stopPropagation(); setGi(i); setPanel(null); }}><i className={`cp-dot ${g.state}`} />{g.name} <small>1 → {g.followerIds.length}</small></button>)}</div>
        </div>
        <CopierTiles view={view} group={group} settings={settings} selectedId={openId} onOpen={(id) => setPanel({ id })} />
      </div>

      <div className="cp-card" style={{ padding: 12, display: 'flex', flexDirection: 'column', minHeight: 0 }} onClick={(e) => e.stopPropagation()}>
        <CopierGroupStrip view={view} group={group} settings={settings}
          onSettings={() => { setMenu(false); setPanel(p => (p === 'settings' ? null : 'settings')); }} settingsOpen={panel === 'settings'}
          onMenu={() => setMenu(m => !m)} menuOpen={menu}
          onToggleSltp={() => setSettings({ ...settings, sltp: settings.sltp === 'avg' ? 'sum' : 'avg' })}
          onOpenAccount={(id) => setPanel({ id })}
          menu={menu ? <CopierGroupMenu openPositions={openPositions} editOn={edit} onClose={() => setMenu(false)}
            onEdit={() => { setEdit(e => !e); setMenu(false); }} onTemplate={actions.onTemplate ? (r, m) => { setMenu(false); actions.onTemplate!(group.id, r, m); } : undefined} onFlatten={actions.onFlatten ? () => { setMenu(false); actions.onFlatten!(group.id); } : undefined} /> : null} />
        <CopierFollowerTable view={view} group={group} settings={settings} edit={edit} selectedId={openId} onOpen={(id) => setPanel({ id })}
          onToggleCopy={actions.onToggleCopy} onBulk={actions.onBulk ? (a, ids, v) => actions.onBulk!(group.id, a, ids, v) : undefined} />
      </div>

      {panel === 'settings' && <CopierSettingsPanel settings={settings} onChange={setSettings} onClose={() => setPanel(null)} sample={view.accounts[group.followerIds[0]]?.name ?? 'Flex 50K •002'} />}
      {openId && <CopierAccountDetail view={view} group={group} id={openId} settings={settings} asSheet={false} onClose={() => setPanel(null)}
        onToggleCopy={actions.onToggleCopy} onFixProtection={actions.onFixProtection} onClosePosition={actions.onClosePosition} />}
    </div>
  );
}

// ─────────────────────────────── telefon
export function RithmicCopierPhone({ view, actions, isDark = true, note = null, emptyNote = 'Žádná kopírovací skupina.' }: { view: CopierView; actions: CopierActions; isDark?: boolean; note?: React.ReactNode; emptyNote?: React.ReactNode }) {
  const [gi, setGi] = useState(0);
  const group = view.groups[Math.min(gi, view.groups.length - 1)];
  const [settings, setSettings] = useCopierTableSettings();
  const [sheet, setSheet] = useState<null | 'settings' | { id: string }>(null), [filter, setFilter] = useState<'all' | 'prob'>('all');
  const root = useRef<HTMLDivElement>(null), sw = useRef<HTMLButtonElement>(null);
  const arm = useArm(group, actions, root, [sw]);
  if (!group) return <div className={`cp-root${isDark ? '' : ' cp-light'}`} style={{ padding: 16 }}><div className="cp-card" style={{ padding: 16, fontSize: 13 }}>{emptyNote}</div></div>;
  const sum = copierGroupSummary(view, group, settings.sltp);
  const leader = view.accounts[group.leaderId];
  const followers = group.followerIds.map(id => view.accounts[id]).filter(Boolean);
  const probs = followers.filter(a => ['bad', 'prob', 'lock'].includes(copierTileKind(a)));
  const rows = filter === 'prob' ? probs : followers;
  const names = (id: string) => (view.accounts[id] ? shownName(view.accounts[id], settings) : id);
  const pw = powerOf(group);
  const inTrade = sum.inPosition > 0;
  const stLabel = { armed: 'ARMED', disarmed: 'DISARMED', halted: 'ZASTAVENO', kill: 'KILL' }[group.state];
  const sync = sum.unprotectedIds.length ? <span className="cp-loss">SL/TP chybí u {sum.unprotectedIds.length} {sum.unprotectedIds.length === 1 ? 'účtu' : 'účtů'}</span>
    : <span className="cp-win">SL/TP sedí {sum.protectedCount}/{sum.inPosition} ✓</span>;
  const lo = leader ? copierOpenPnl(leader, view.price, view.pointValue) : 0;
  return (
    <div ref={root} className={`cp-root${isDark ? '' : ' cp-light'}`} style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 14px 110px' }} data-rithmic-copier-phone>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 24, fontWeight: 850, letterSpacing: '-.02em' }}>Kopírka</h2><span style={{ flex: 1 }} />
        <span className="cp-chip" style={{ height: 26 }}><i className={`cp-dot ${group.state}`} style={{ marginRight: 6 }} />{stLabel}</span>
        <button type="button" className="cp-btn" style={{ width: 32, padding: 0, justifyContent: 'center' }} onClick={() => setSheet('settings')} aria-label="Nastavení">⚙</button>
      </div>
      <div className="cp-pchips">{view.groups.map((g, i) => <button key={g.id} type="button" className={i === gi ? 'on' : ''} onClick={() => { setGi(i); setSheet(null); }}><i className={`cp-dot ${g.state}`} />{g.name} <span className="cp-mut">{g.followerIds.length}</span></button>)}</div>

      <div className={`cp-card cp-grpc${inTrade ? ' intrade' : ''}`}>
        <div className="ga"><div className="l">Skupina dnes</div><b className={`v cp-num ${sum.day == null ? '' : sum.day >= 0 ? 'cp-win' : 'cp-loss'}`}>{usdText(sum.day)}</b><div className="sync" style={{ fontSize: 10.5 }}>{sync}</div></div>
        <span className="sp" />
        <div className="gb"><div className="l">Otevřeno · {sum.inPosition} účtů</div><b className={`v cp-num ${sum.open >= 0 ? 'cp-win' : 'cp-loss'}`}>{usdText(sum.open)}</b>
          <div className="sub"><SltpValue sl={sum.sl} tp={sum.tp} mode={settings.sltp} unit={false} onToggle={() => setSettings({ ...settings, sltp: settings.sltp === 'avg' ? 'sum' : 'avg' })}
            missing={[]} onMissing={() => undefined} names={names} /></div>
          {sum.unprotectedIds.length > 0 && <i className="cp-miss" style={{ marginLeft: 0, marginTop: 4 }} onClick={() => setSheet({ id: sum.unprotectedIds[0] })}>⚠ {sum.unprotectedIds.length === 1 ? `${names(sum.unprotectedIds[0]).split(' ').pop()} bez SL` : `${sum.unprotectedIds.length} účty bez SL`}</i>}
        </div>
      </div>

      <div className="cp-card" style={{ padding: 10 }}>
        {leader && <div data-cp-tile style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }} onClick={() => setSheet({ id: leader.id })}>
          <span className="cp-chip a">Leader</span><b style={{ fontSize: 13 }}>{shownName(leader, settings)}</b>
          <span className="cp-mut" style={{ fontSize: 12 }}>{leader.position ? `${leader.position.side === 'long' ? 'Long' : 'Short'} ${leader.position.quantity}` : 'bez pozice'}</span>
          <span style={{ flex: 1 }} /><b className={`cp-num ${lo >= 0 ? 'cp-win' : 'cp-loss'}`} style={{ fontSize: 13 }}>{leader.position ? usdText(lo) : '—'}</b>
        </div>}
        <div className="cp-mgrid">{followers.map(a => { const o = copierOpenPnl(a, view.price, view.pointValue); return (
          <button key={a.id} type="button" data-cp-tile className={`cp-mt ${copierTileKind(a)}`} onClick={() => setSheet({ id: a.id })}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}><FirmDot firm={a.firm} />{settings.redact ? shownName(a, settings) : `•${a.name.split('•').pop()}`}</span>
            <b className={`cp-num ${a.position ? (o >= 0 ? 'cp-win' : 'cp-loss') : 'cp-mut'}`}>{a.position ? usdText(o) : '—'}</b>
          </button>); })}</div>
      </div>

      <div className="cp-card" style={{ padding: 12, position: 'relative' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <CopierPowerSwitch ref={sw} big state={pw.state} sub={pw.sub} onClick={arm.toggle} shakeKey={arm.shake} fx={arm.fx} />
          {actions.onKill && <button type="button" className="cp-btn red" style={{ height: 48, borderRadius: 14 }} onClick={actions.onKill}>⏻ Zastavit</button>}
        </div>
        {arm.fail && <div className="cp-fail" style={{ position: 'static', width: 'auto', marginTop: 8 }}><b>Kopírka se nezapnula</b><span>{arm.fail.label} · {arm.fail.detail}</span>
          {arm.fail.fixAccountId && actions.onDisableAccount && <button type="button" className="cp-btn" style={{ marginTop: 8, height: 30 }} onClick={() => { const id = arm.fail!.fixAccountId!; arm.setFail(null); actions.onDisableAccount!(id); window.setTimeout(arm.toggle, 250); }}>Vypnout účet a zapnout</button>}
          <button type="button" className="x" onClick={() => arm.setFail(null)}>×</button></div>}
        {actions.onKill && <div className="cp-mut" style={{ fontSize: 11, marginTop: 8 }}>Zapnutí i zastavení platí hned, na PC i v telefonu.</div>}
      </div>
      {note && <div className="cp-card" style={{ padding: '10px 13px', fontSize: 12 }}>{note}</div>}

      <div className="cp-card" style={{ padding: '6px 13px' }}>
        <div className="cp-fchips" style={{ margin: '6px 0' }}>{([['all', 'Vše', followers.length], ['prob', 'Problém', probs.length]] as const).map(([k, l, n]) => <button key={k} type="button" className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}<i>{n}</i></button>)}</div>
        {!rows.length && <div className="cp-mut" style={{ fontSize: 12, padding: '10px 0' }}>{followers.length ? 'Žádný účet s problémem.' : 'Zatím žádní followeři.'}</div>}
        {rows.map(a => { const o = copierOpenPnl(a, view.price, view.pointValue), day = a.realizedToday == null ? null : a.realizedToday + o; return (
          <div key={a.id} className="cp-row" onClick={() => setSheet({ id: a.id })}>
            <span><b><FirmDot firm={a.firm} />{shownName(a, settings)}</b><small>×{a.ratio.toLocaleString('cs-CZ')} · {a.position ? `${a.position.side === 'long' ? 'Long' : 'Short'} ${a.brokerQuantity ?? a.position.quantity}` : 'bez pozice'} · dnes <b className={`cp-num ${day == null ? '' : day >= 0 ? 'cp-win' : 'cp-loss'}`} style={{ display: 'inline' }}>{usdText(day)}</b></small></span>
            {statusChip(a, group.state === 'armed')}<span className="chev">›</span>
          </div>); })}
      </div>

      {sheet === 'settings' && <CopierSettingsPanel asSheet settings={settings} onChange={setSettings} onClose={() => setSheet(null)} sample={followers[0]?.name ?? 'Flex 50K •002'} />}
      {sheet && typeof sheet === 'object' && <CopierAccountDetail view={view} group={group} id={sheet.id} settings={settings} asSheet onClose={() => setSheet(null)}
        onToggleCopy={actions.onToggleCopy} onFixProtection={actions.onFixProtection} onClosePosition={actions.onClosePosition} />}
    </div>
  );
}
