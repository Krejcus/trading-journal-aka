export interface CopyGroupLibraryReadToken { epoch: number; generation: number }
export interface CopyGroupLibraryWriteToken { epoch: number; id: number }

/** Reject old cloud reads across local writes, account changes and unmounts. */
export class CopyGroupLibraryRequestFence {
  private epoch = 0;
  private generation = 0;
  private nextWriteId = 0;
  private readonly writes = new Set<number>();

  constructor(private ownerId: string) {}

  setOwner(ownerId: string): void {
    if (ownerId === this.ownerId) return;
    this.ownerId = ownerId;
    this.invalidate();
  }

  invalidate(): void {
    this.epoch += 1;
    this.generation += 1;
    this.writes.clear();
  }

  beginRead(): CopyGroupLibraryReadToken | null {
    if (this.writes.size > 0) return null;
    return { epoch: this.epoch, generation: ++this.generation };
  }

  canAcceptRead(token: CopyGroupLibraryReadToken): boolean {
    return token.epoch === this.epoch && token.generation === this.generation && this.writes.size === 0;
  }

  beginWrite(): CopyGroupLibraryWriteToken {
    this.generation += 1;
    const token = { epoch: this.epoch, id: ++this.nextWriteId };
    this.writes.add(token.id);
    return token;
  }

  canAcceptWrite(token: CopyGroupLibraryWriteToken): boolean {
    return token.epoch === this.epoch && this.writes.has(token.id);
  }

  endWrite(token: CopyGroupLibraryWriteToken): void {
    if (!this.canAcceptWrite(token)) return;
    this.writes.delete(token.id);
    this.generation += 1;
  }
}
