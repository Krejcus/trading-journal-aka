import { EMPTY_JOURNAL_LIVE_VIEW, type JournalLiveTarget, type JournalLiveView } from './journalLivePosition';

/**
 * Sdílený stav živé pozice deníku (jen zobrazení): běžec čtení ho plní,
 * štítek v grafu ho čte (`useSyncExternalStore`). Obnova po 2 s tak
 * překreslí jen štítek, ne deník ani graf. Výběr účtu jde opačným směrem.
 */
export interface JournalLivePositionStore {
  subscribe(listener: () => void): () => void;
  getView(): JournalLiveView;
  setView(view: JournalLiveView): void;
  getTarget(): JournalLiveTarget;
  setTarget(target: JournalLiveTarget): void;
}

export function createJournalLivePositionStore(): JournalLivePositionStore {
  const listeners = new Set<() => void>();
  let view: JournalLiveView = EMPTY_JOURNAL_LIVE_VIEW;
  let target: JournalLiveTarget = 'group';
  const emit = () => listeners.forEach(listener => listener());
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getView: () => view,
    setView(next) {
      if (next === view) return;
      view = next;
      emit();
    },
    getTarget: () => target,
    setTarget(next) {
      if (next === target) return;
      target = next;
      emit();
    },
  };
}
