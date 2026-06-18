import type { Trade } from '../types';

// ─── Persony AI Coache ────────────────────────────────────────────────────────
// Persona mění JEN "charakterový" blok system promptu (tón, osobnost, styl).
// Data, nástroje, pravidla pro karty atd. zůstávají stejné napříč personami.
// Model (rychlost × chytrost) je NEZÁVISLÁ osa — persona ji neovlivňuje.

export type CoachPersonaId = 'partak' | 'dril' | 'profik' | 'psycholog';

// 'auto' = nech systém vybrat personu podle kontextu (viz resolveAutoPersona)
export type CoachPersonaSetting = CoachPersonaId | 'auto';

export interface CoachPersona {
  id: CoachPersonaId;
  label: string;
  emoji: string;
  /** Krátký popis pro UI */
  tagline: string;
  /** Charakterový blok vkládaný do system promptu */
  block: string;
}

export const COACH_PERSONAS: Record<CoachPersonaId, CoachPersona> = {
  partak: {
    id: 'partak',
    emoji: '🤝',
    label: 'Parťák',
    tagline: 'Přímý kámoš co to s tebou myslí vážně',
    block: `=== TVOJE OSOBNOST: PARŤÁK ===
Jsi Filipův parťák a mentor v jednom — kámoš, co to s ním myslí vážně. Mluvíš na rovinu, lidsky, občas s lehkým humorem. Tykáš, oslovuješ ho "Filipe".
- Když v datech vidíš revenge trading, FOMO, overtrading nebo porušení jeho pravidel, řekni mu to NAROVINU, bez obalu — ale s respektem, jako kamarád co nechce aby si rozbil účet.
- Oceňuješ DISCIPLÍNU víc než profit. Pochval ho za dodržení pravidel i v prodělečném dni.
- Motivuješ, ale nelakuješ realitu. Žádná korporátní vata, žádné generické fráze.
- Krátké, lidské věty. Když chceš víc info, polož JEDNU otázku a počkej.`,
  },
  dril: {
    id: 'dril',
    emoji: '🔥',
    label: 'Dril',
    tagline: 'Tvrdý mentor, netoleruje výmluvy',
    block: `=== TVOJE OSOBNOST: DRIL (TOUGH LOVE) ===
Jsi tvrdý trading mentor ve stylu drill instructora. Tvůj úkol je vydřít z Filipa disciplinovaného tradera.
- Netoleruješ výmluvy. Každou chybu v datech konfrontuješ přímo a nekompromisně — pojmenuj ji a řekni důsledek.
- Netlačíš na pohodu, tlačíš na PROCES a disciplínu. "Cítil jsem to" není důvod pro trade.
- Nechválíš zbytečně — pochvala se musí zasloužit dodržením pravidel, ne profitem ze štěstí.
- Jsi přísný, ale ne krutý: tvrdost má účel. Krátké, úderné věty. Žádné omáčky.`,
  },
  profik: {
    id: 'profik',
    emoji: '📊',
    label: 'Profík',
    tagline: 'Klidný prop-firm kouč, data-first',
    block: `=== TVOJE OSOBNOST: PROFÍK ===
Jsi klidný, vyrovnaný prop-firm kouč. Věcný, analytický, minimum emocí.
- Pracuješ s ČÍSLY a vzorci chladně a přesně. Konkrétní statistiky > dojmy.
- Vyvozuješ jasné, opakovatelné závěry zaměřené na edge, risk management a konzistenci.
- Mluvíš profesionálně — bez hecování i bez měkkosti. Žádné emoce navíc, žádné fráze.
- Když něco tvrdíš, opři to o data, která reálně vidíš. Krátce a přesně.`,
  },
  psycholog: {
    id: 'psycholog',
    emoji: '🧠',
    label: 'Psycholog',
    tagline: 'Mindset, emoce, klid v hlavě',
    block: `=== TVOJE OSOBNOST: PSYCHOLOG / MINDSET ===
Jsi mentor zaměřený na psychiku a mindset tradera. Tvoje priorita je Filipova HLAVA — klid, sebereflexe, zvládání tiltu, strachu a revenge nutkání.
- Mluvíš empaticky a klidně. Vedeš ho k uvědomění OTÁZKAMI, ne kázáním.
- Méně technických ICT detailů, víc o emocích a vzorcích chování za obchody.
- Když je dole (ztráty, tilt), PODRŽÍŠ ho — nedrtíš ho čísly ani kritikou. Nejdřív hlava, pak technika.
- Pomáháš mu oddělit identitu od výsledku jednoho obchodu. Krátké, lidské, laskavé věty.`,
  },
};

export const DEFAULT_PERSONA: CoachPersonaId = 'partak';

/** Vrátí charakterový blok pro danou personu (fallback na parťáka). */
export function getPersonaBlock(id: CoachPersonaId): string {
  return (COACH_PERSONAS[id] || COACH_PERSONAS[DEFAULT_PERSONA]).block;
}

// ─── Chytrý auto-výběr persony podle kontextu ─────────────────────────────────
// Když je nastavení 'auto', persona se zvolí podle situace:
//  - série ztrát / tilt dnes              → Psycholog (podrž ho, nedrť daty)
//  - ranní příprava                       → Parťák (nahecuj, nalaď)
//  - večerní audit                        → Psycholog (reflexe dne, emoce)
//  - po-obchodní debrief                  → Profík (věcné vyhodnocení seance)
//  - jinak                                → default (Parťák)

interface AutoPersonaContext {
  sessionMode?: 'morning_prep' | 'post_session' | 'evening_review' | null;
  trades?: Trade[];
  /** ISO dnešního dne (yyyy-mm-dd) pro detekci dnešních ztrát */
  todayISO?: string;
}

/** Detekce "tilt/série ztrát" — 2+ ztráty po sobě v posledních obchodech nebo červený den. */
function isTiltLikely(trades: Trade[] | undefined, todayISO?: string): boolean {
  if (!trades || trades.length === 0) return false;
  try {
    // Klíč VŽDY jako string — exitTime/entryTime můžou být i čísla (timestamp),
    // a .localeCompare na čísle by spadlo (proto Auto persona neodpovídala).
    const key = (t: any) => String(t.exitTime ?? t.entryTime ?? t.date ?? '');
    const sorted = [...trades].sort((a, b) => key(b).localeCompare(key(a)));
    // 2 ztráty po sobě mezi posledními 3 obchody
    const last3 = sorted.slice(0, 3);
    const losses = last3.filter(t => (t.pnl ?? 0) < 0).length;
    if (losses >= 2) return true;
    // dnešní den v záporu napříč 2+ obchody
    if (todayISO) {
      const today = trades.filter(t => String((t as any).date ?? '').startsWith(todayISO));
      if (today.length >= 2) {
        const sum = today.reduce((s, t) => s + (t.pnl ?? 0), 0);
        if (sum < 0) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

export function resolveAutoPersona(ctx: AutoPersonaContext): CoachPersonaId {
  // Tilt/série ztrát má přednost vždy — když je dole, nepotřebuje dril ani čísla.
  if (isTiltLikely(ctx.trades, ctx.todayISO)) return 'psycholog';

  switch (ctx.sessionMode) {
    case 'morning_prep': return 'partak';
    case 'evening_review': return 'psycholog';
    case 'post_session': return 'profik';
    default: return DEFAULT_PERSONA;
  }
}

/** Z nastavení ('auto' | konkrétní) vyřeš finální personu. Nikdy nesmí vyhodit chybu. */
export function resolvePersona(setting: CoachPersonaSetting | undefined, ctx: AutoPersonaContext): CoachPersonaId {
  try {
    if (!setting || setting === 'auto') return resolveAutoPersona(ctx);
    return setting;
  } catch {
    return DEFAULT_PERSONA;
  }
}
