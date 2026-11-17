export interface PendingRithmicCommand {
  id: string;
  at: number;
  op: string;
  clientId?: string;
  orderId?: string;
}

export class RithmicPendingJournal {
  private readonly prefix: string;
  constructor(private readonly storage: Storage, system: string, account: string, symbol: string) {
    this.prefix = 'rithmic.pending.v1/' + [system, account, symbol].map(encodeURIComponent).join('/') + '/';
  }
  put(item: PendingRithmicCommand): void {
    this.storage.setItem(this.prefix + item.id, JSON.stringify(item));
  }
  remove(id: string): void { this.storage.removeItem(this.prefix + id); }
  list(): PendingRithmicCommand[] {
    const rows: PendingRithmicCommand[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (!key?.startsWith(this.prefix)) continue;
      const row = JSON.parse(this.storage.getItem(key) ?? 'null');
      if (!row || typeof row.id !== 'string' || key !== this.prefix + row.id || typeof row.op !== 'string') throw new Error('Poškozený záznam příkazu');
      rows.push(row);
    }
    return rows;
  }
}
