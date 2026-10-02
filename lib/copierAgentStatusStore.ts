import { CopierRelayFeedSources } from './copierRelayPollSources';

/**
 * Last accepted copier worker status, kept in module memory so that leaving
 * and re-entering LIVE (the desk unmounts) does not start from "unknown".
 *
 * Display only. A restored snapshot never authorizes ARM or a config change:
 * the desk keeps commands gated until its own poll accepts a fresh status.
 * Lives only in memory — a reload or app restart starts from unknown — and is
 * dropped immediately on sign-out or a user change.
 */
export interface CopierAgentStatusSnapshot<Status, Feed> {
  userId: string;
  status: Status;
  observedAt: number | null;
  readHealthy: boolean;
  transport: 'local' | 'relay' | null;
  relayConnectionId: string | null;
  lastRoute: { transport: 'local' | 'relay'; relayConnectionId: string | null } | null;
  feedReceipt: { userId: string; receivedAt: number; feeds: Feed[] } | null;
}

let snapshot: CopierAgentStatusSnapshot<unknown, unknown> | null = null;
let feedSources: { userId: string; sources: CopierRelayFeedSources<unknown> } | null = null;

export function readCopierAgentStatusSnapshot<Status, Feed>(userId: string): CopierAgentStatusSnapshot<Status, Feed> | null {
  if (!userId || snapshot?.userId !== userId) return null;
  return snapshot as CopierAgentStatusSnapshot<Status, Feed>;
}

export function writeCopierAgentStatusSnapshot<Status, Feed>(next: CopierAgentStatusSnapshot<Status, Feed>): void {
  if (!next.userId) return;
  if (snapshot && snapshot.userId !== next.userId) clearCopierAgentStatusStore();
  snapshot = next as CopierAgentStatusSnapshot<unknown, unknown>;
}

/** Relay display feeds per source connection; shared so a remount keeps the
 * feeds of connections its first poll has not read yet. */
export function copierRelayFeedSourcesFor<Feed>(userId: string): CopierRelayFeedSources<Feed> {
  if (feedSources?.userId !== userId) {
    feedSources = { userId, sources: new CopierRelayFeedSources<unknown>() };
  }
  return feedSources.sources as CopierRelayFeedSources<Feed>;
}

export function clearCopierAgentStatusStore(): void {
  snapshot = null;
  feedSources?.sources.clear();
  feedSources = null;
}
