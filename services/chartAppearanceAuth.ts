import { setChartAppearanceUserId } from './chartAppearanceScope';

interface Session { user: { id: string } }
interface AppearanceAuth {
  onAuthStateChange: (listener: (event: string, session: Session | null) => void) => { data: { subscription: { unsubscribe: () => void } } };
  getSession: () => Promise<{ data: { session: Session | null } }>;
}

/** Read identity only. A delayed initial read cannot undo a newer auth event. */
export const bindChartAppearanceAuth = (auth: AppearanceAuth): (() => void) => {
  let version = 0;
  const { data: { subscription } } = auth.onAuthStateChange((_event, session) => {
    version += 1;
    setChartAppearanceUserId(session?.user.id ?? null);
  });
  void auth.getSession().then(({ data }) => {
    if (version === 0) setChartAppearanceUserId(data.session?.user.id ?? null);
  }).catch(() => { /* Unknown identity keeps neutral defaults until auth resolves. */ });
  return () => { version += 1; subscription.unsubscribe(); };
};
