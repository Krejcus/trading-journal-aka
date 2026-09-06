import { useCallback, useEffect, useState } from 'react';
import { chartAppearanceUserId } from '../services/chartAppearanceScope';
import { readWorkspaceLibrary, subscribeWorkspaceLibrary, type WorkspaceLibrary } from '../services/chartWorkspaceLibrary';
const read = () => {
  const owner = chartAppearanceUserId();
  try { return { owner, library: readWorkspaceLibrary(owner), error: null as string | null }; }
  catch (reason) { return { owner, library: { version: 1, defaultId: null, templates: [] } as WorkspaceLibrary, error: reason instanceof Error ? reason.message : 'Knihovnu nelze načíst.' }; }
};
export const useWorkspaceLibrary = () => {
  const [snapshot, setSnapshot] = useState(read);
  const refresh = useCallback(() => setSnapshot(read()), []);
  useEffect(() => { refresh(); return subscribeWorkspaceLibrary(refresh); }, [refresh]);
  return { ...snapshot, refresh };
};
