import { useLayoutEffect, useState } from 'react';
import { createLiveClickGate, type LiveClickGate, type LiveClickTarget } from '../lib/liveClickGate';

/** Tenké napojení `createLiveClickGate` na React: `sync` při každé změně klíče některého cíle. */
export function useLiveClickGate(targets: ReadonlyArray<LiveClickTarget | null | undefined>): LiveClickGate {
  const [gate] = useState(() => createLiveClickGate());
  const syncKey = targets.map(target => target?.key ?? '-').join('|');
  useLayoutEffect(() => { gate.sync(targets); }, [syncKey, gate]); // eslint-disable-line react-hooks/exhaustive-deps
  return gate;
}
