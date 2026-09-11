import React, { useEffect, useState } from 'react';
import { Check, ChevronDown, Clock3, Pause, ShieldAlert } from 'lucide-react';
import { buildCopierCooldownDisplay, copierPauseDeadline, formatCopierCountdown, type CopierCooldownInput } from '../services/copierCooldownDisplay';
import './CopierCooldownPanel.css';

export function useCopierPauseActive(until: number): boolean {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (until <= Date.now()) return;
    const timeout = window.setTimeout(() => setNow(Date.now()), Math.min(2_147_483_647, until - Date.now() + 20));
    return () => window.clearTimeout(timeout);
  }, [until]);
  return until > now;
}

export default function CopierCooldownPanel(input: CopierCooldownInput) {
  const [now, setNow] = useState(Date.now);
  const [expanded, setExpanded] = useState(false);
  const until = copierPauseDeadline(input.cooldownUntil, input.pause?.until);
  const [lastUntil, setLastUntil] = useState(until);
  useEffect(() => {
    if (until > 0) setLastUntil(until);
  }, [until]);
  const displayUntil = until || lastUntil;
  const finished = now >= displayUntil + 10_000;
  useEffect(() => {
    if (displayUntil <= 0 || displayUntil + 10_000 < Date.now()) return;
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 250);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [displayUntil, finished]);
  const model = buildCopierCooldownDisplay(input, now);
  const recentlyElapsed = displayUntil > 0 && displayUntil <= now && now < displayUntil + 10_000;
  if (!model.active && !recentlyElapsed) return null;
  const phase = !model.known ? 'unknown' : model.active ? 'active' : model.blocker ? 'blocked' : 'elapsed';
  const showCompletion = phase === 'elapsed';
  const label = !model.known ? 'Stav vyžaduje ověření' : model.active ? 'Kopírování pozastaveno' : 'Odpočet dokončen';
  return (
    <section data-copier-cooldown={phase} className="copier-cooldown" aria-label="Pauza kopírování">
      <div className="copier-cooldown-main">
        <div className="copier-cooldown-ring" aria-hidden="true">
          <svg viewBox="0 0 52 52" className="copier-cooldown-progress">
            <circle cx="26" cy="26" r="23" fill="none" strokeWidth="2.5" className="copier-cooldown-track" />
            {model.progress != null ? <circle cx="26" cy="26" r="23" fill="none" strokeWidth="2.5" pathLength="100" strokeDasharray="100" strokeDashoffset={100 * (1 - model.progress)} strokeLinecap="round" className="copier-cooldown-arc" /> : null}
          </svg>
          <span key={showCompletion ? `completed-${displayUntil}` : 'waiting'} className={showCompletion ? 'copier-cooldown-complete' : ''}>
            {showCompletion ? <Check size={18} /> : model.blocker ? <ShieldAlert size={18} /> : <Pause size={18} />}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="copier-cooldown-eyebrow">{label}</div>
          <div key={`${phase}-${model.title}`} className={showCompletion ? 'copier-cooldown-finish-copy' : ''}>
            <h4>{model.title}</h4>
            <p role="status">{model.subtitle}</p>
          </div>
        </div>
        <div className="copier-cooldown-time">
          <div role="timer" aria-live="off" className="copier-cooldown-digits">{model.known ? formatCopierCountdown(model.seconds) : '—'}</div>
          <small>{!model.known ? 'stav neověřen' : model.active ? <>
            Konec pauzy v <time dateTime={new Date(model.until).toISOString()} title="Místní čas tohoto zařízení; konec pauzy kopírku automaticky nezapíná.">{new Date(model.until).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</time>
          </> : 'čas uplynul'}</small>
        </div>
      </div>
      <div className="copier-cooldown-footer">
        {model.cooldown.until > 0 ? <span className={model.cooldown.active || !model.known ? '' : 'copier-cooldown-done'}>
          {model.cooldown.active || !model.known ? <Clock3 size={12} /> : <Check size={12} />}
          Cooldown{model.cooldown.minutes > 0 ? ` ${model.cooldown.minutes} min` : ''} · {!model.known ? 'neověřeno' : model.cooldown.active ? 'běží' : 'čas uplynul'}
        </span> : null}
        {model.pause.until > 0 ? <span>
          <Clock3 size={12} /> Pauza{model.pause.minutes != null && model.pause.minutes > 0 ? ` ${model.pause.minutes} min` : ''} · {!model.known ? 'neověřeno' : model.pause.active ? 'běží' : 'čas uplynul'}
        </span> : null}
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>Podrobnosti <ChevronDown size={13} className={expanded ? 'rotate-180' : ''} /></button>
      </div>
      {expanded ? <div className="copier-cooldown-details">
        <p>Konec nejdelší pauzy: {new Date(displayUntil).toLocaleTimeString('cs-CZ')} · podle hodin tohoto zařízení.</p>
        <p>Ruční objednávku na leaderovi může broker přijmout. Během pauzy se nezkopíruje a později se zpětně nedoplní.</p>
        <p>Odpočet nic nezapíná. Rozhodující je ověřený stav workeru a všechna ostatní bezpečnostní pravidla.</p>
      </div> : null}
    </section>
  );
}
