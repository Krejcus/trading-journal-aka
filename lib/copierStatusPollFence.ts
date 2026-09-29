/**
 * Oddělí periodické read-only status requesty od autoritativních ACK zápisů.
 * Poll zahájený před nebo během mutace nesmí po jejím dokončení vrátit starší
 * full-group snapshot zpět do UI.
 */
export class CopierStatusPollFence {
  private generation = 0;
  private mutationPending = false;

  get inFlight(): boolean {
    return this.mutationPending;
  }

  beginMutation(): boolean {
    if (this.mutationPending) return false;
    this.mutationPending = true;
    this.generation += 1;
    return true;
  }

  endMutation(): void {
    if (!this.mutationPending) return;
    this.generation += 1;
    this.mutationPending = false;
  }

  /**
   * Zahodí všechny právě běžící polly bez vzájemného vyloučení s mutací.
   * Volá se kolem každého příkazu, jehož ACK mění stav (DISARM, kill switch,
   * ARM, přepnutí followera): controller.revision se při ARM/DISARM nemění,
   * takže jen revize nestačí k odmítnutí pollu zahájeného před příkazem.
   */
  invalidatePolls(): void {
    this.generation += 1;
  }

  beginPoll(): number {
    return this.generation;
  }

  canAcceptPoll(startedAtGeneration: number): boolean {
    return !this.mutationPending && startedAtGeneration === this.generation;
  }
}

/**
 * Řadí ACK podle okamžiku, kdy UI příkaz přijalo. Worker zatím nemá vlastní
 * gateSeq, takže pozdější odpověď staršího ARM nesmí přepsat už přijatý
 * DISARM/kill ACK. Úplná distribuovaná garance zůstává na worker gateSeq.
 */
export class CopierStatusAckFence {
  private nextSequence = 0;
  private lastAcceptedSequence = 0;

  beginRequest(): number {
    this.nextSequence += 1;
    return this.nextSequence;
  }

  accept(sequence: number): boolean {
    if (!Number.isSafeInteger(sequence) || sequence < this.lastAcceptedSequence) return false;
    this.lastAcceptedSequence = sequence;
    return true;
  }

  reset(): void {
    this.nextSequence = 0;
    this.lastAcceptedSequence = 0;
  }
}

export interface CopierStatusOrder {
  startedAt: string;
  controller: { revision: number };
}

/**
 * Runtime restart time is the primary epoch. Within one worker run, the
 * durable controller revision is monotonic. Equal versions are accepted so a
 * newer relay heartbeat can refresh observation time without changing state.
 */
export function shouldAcceptCopierStatus(
  candidate: CopierStatusOrder,
  lastAccepted: CopierStatusOrder | null,
): boolean {
  const candidateStartedAt = Date.parse(candidate.startedAt);
  if (!Number.isFinite(candidateStartedAt) || !Number.isFinite(candidate.controller.revision)) return false;
  if (!lastAccepted) return true;
  const acceptedStartedAt = Date.parse(lastAccepted.startedAt);
  if (!Number.isFinite(acceptedStartedAt)) return true;
  if (candidateStartedAt !== acceptedStartedAt) return candidateStartedAt > acceptedStartedAt;
  return candidate.controller.revision >= lastAccepted.controller.revision;
}
