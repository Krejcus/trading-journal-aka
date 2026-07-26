type IncidentAllocation = {
  label?: string;
  lossAmount?: number | string;
  currency?: string;
};

export type JournalIncident = {
  id?: string;
  timestamp?: number;
  type?: string;
  title?: string;
  whatHappened?: string;
  trigger?: string;
  lesson?: string;
  allocations?: IncidentAllocation[];
};

const clean = (value: unknown): string =>
  String(value ?? '').replace(/\s+/g, ' ').trim();

export const incidentLoss = (incident: JournalIncident): number =>
  (incident.allocations || []).reduce((sum, allocation) => {
    const amount = Number(allocation.lossAmount);
    return sum + (Number.isFinite(amount) ? amount : 0);
  }, 0);

export function incidentForMcp(incident: JournalIncident) {
  return {
    id: incident.id ?? null,
    timestamp: incident.timestamp ?? null,
    type: incident.type || 'other',
    title: clean(incident.title) || 'Trading incident',
    what_happened: clean(incident.whatHappened) || null,
    trigger: clean(incident.trigger) || null,
    lesson: clean(incident.lesson) || null,
    loss_usd: Math.round(incidentLoss(incident) * 100) / 100,
    allocations: (incident.allocations || []).map(allocation => ({
      label: clean(allocation.label) || 'Neurčeno',
      loss_amount: Number(allocation.lossAmount) || 0,
      currency: allocation.currency || 'USD',
    })),
    excluded_from_trade_stats: true,
  };
}

export function incidentJournalLine(incident: JournalIncident): string {
  const mapped = incidentForMcp(incident);
  const split = mapped.allocations
    .map(allocation => `${allocation.label} -$${Math.round(allocation.loss_amount).toLocaleString('en-US')}`)
    .join(', ');
  const parts = [
    `INCIDENT BEZ TRADŮ [${mapped.type.toUpperCase()}] ${mapped.title}`,
    `ztráta -$${Math.round(mapped.loss_usd).toLocaleString('en-US')}`,
    split ? `rozpad: ${split}` : null,
    mapped.what_happened ? `co se stalo: ${mapped.what_happened}` : null,
    mapped.trigger ? `trigger: ${mapped.trigger}` : null,
    mapped.lesson ? `poučení: ${mapped.lesson}` : null,
    'NEZAHRNOVAT do počtu obchodů, WR, RR, PF ani trade P&L',
  ].filter(Boolean);
  return parts.join(' | ');
}
