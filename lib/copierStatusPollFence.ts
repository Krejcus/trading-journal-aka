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

  beginPoll(): number {
    return this.generation;
  }

  canAcceptPoll(startedAtGeneration: number): boolean {
    return !this.mutationPending && startedAtGeneration === this.generation;
  }
}
