import React, { useCallback, useEffect, useState } from 'react';

type OverviewComponent = (typeof import('./LiveCopyTradeOverview'))['default'];
type OverviewProps = React.ComponentProps<OverviewComponent>;
type MobileDetailComponent = (typeof import('./LiveMobileAccountDetail'))['default'];
type MobileDetailProps = React.ComponentProps<MobileDetailComponent>;

interface DeferredModule<Component extends React.ComponentType<any>> {
  component: Component | null;
  pending: Promise<Component> | null;
  load: () => Promise<Component>;
}

const deferredModule = <Component extends React.ComponentType<any>>(
  importer: () => Promise<{ default: Component }>,
): DeferredModule<Component> => {
  const state: DeferredModule<Component> = {
    component: null,
    pending: null,
    load: () => {
      if (state.component) return Promise.resolve(state.component);
      if (!state.pending) {
        state.pending = importer()
          .then(module => {
            state.component = module.default;
            return module.default;
          })
          .catch(reason => {
            // Přechodná chyba chunku nesmí otrávit další otevření nebo retry.
            state.pending = null;
            throw reason;
          });
      }
      return state.pending;
    },
  };
  return state;
};

const overviewModule = deferredModule<OverviewComponent>(() => import('./LiveCopyTradeOverview'));
const mobileDetailModule = deferredModule<MobileDetailComponent>(() => import('./LiveMobileAccountDetail'));

function useDeferredComponent<Component extends React.ComponentType<any>>(
  module: DeferredModule<Component>,
): { Component: Component | null; failed: boolean; retry: () => void } {
  const [Component, setComponent] = useState<Component | null>(() => module.component);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (Component) return undefined;
    let active = true;
    module.load()
      .then(next => {
        if (!active) return;
        setComponent(() => next);
        setFailed(false);
      })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [Component, module, attempt]);
  const retry = useCallback(() => {
    setFailed(false);
    setAttempt(value => value + 1);
  }, []);
  return { Component, failed, retry };
}

const OverviewFallback = ({ failed, onRetry }: { failed: boolean; onRetry: () => void }) => (
  <section
    className="grid min-h-[360px] place-items-center rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-6 text-center"
    role="status"
    aria-busy={!failed}
  >
    <div>
      <span className={`mx-auto block h-7 w-7 rounded-full border-2 border-indigo-500/20 border-t-indigo-500 ${failed ? '' : 'animate-spin'}`} />
      <p className="mt-3 text-xs font-bold text-[var(--text-secondary)]">
        {failed ? 'LIVE přehled se nepodařilo načíst. Graf a bezpečnostní ovládání fungují dál.' : 'Načítám LIVE přehled…'}
      </p>
      {failed ? <button type="button" onClick={onRetry} className="mt-4 h-9 rounded-md bg-indigo-600 px-4 text-xs font-black text-white">Zkusit znovu</button> : null}
    </div>
  </section>
);

/** Připraví těžký přehled při záměru otevřít záložku, bez mountu a odběrů. */
export const preloadLiveCopyTradeOverview = (): Promise<void> => overviewModule.load().then(() => undefined);

const LiveCopyTradeOverviewSlot = (props: OverviewProps) => {
  const { Component, failed, retry } = useDeferredComponent(overviewModule);
  return Component ? <Component {...props} /> : <OverviewFallback failed={failed} onRetry={retry} />;
};

export const LiveMobileAccountDetailSlot = (props: MobileDetailProps) => {
  const { Component, failed, retry } = useDeferredComponent(mobileDetailModule);
  if (Component) return <Component {...props} />;
  return (
    <div className="fixed inset-0 z-[500] grid place-items-center bg-black/65 p-5 backdrop-blur-md" role="status" aria-busy={!failed}>
      <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-6 text-center shadow-2xl">
        <span className={`mx-auto block h-7 w-7 rounded-full border-2 border-indigo-500/20 border-t-indigo-500 ${failed ? '' : 'animate-spin'}`} />
        <p className="mt-3 text-xs font-bold text-[var(--text-secondary)]">{failed ? 'Detail účtu se nepodařilo načíst.' : 'Načítám detail účtu…'}</p>
        <div className="mt-4 flex justify-center gap-2">
          {failed ? <button type="button" onClick={retry} className="h-9 rounded-md bg-indigo-600 px-4 text-xs font-black text-white">Zkusit znovu</button> : null}
          <button type="button" onClick={props.onClose} className="h-9 rounded-md border border-[var(--border-subtle)] px-4 text-xs font-bold text-[var(--text-secondary)]">Zavřít</button>
        </div>
      </div>
    </div>
  );
};

export default LiveCopyTradeOverviewSlot;
