import type { FairValueGap, MarketStructureEvent } from './marketDataCalculations';

export interface RenderedFvgItem {
  gap: FairValueGap;
  isEntry: boolean;
  formingTime: number;
}

export interface RenderedFvgSnapshot {
  regular: RenderedFvgItem[];
  entry: RenderedFvgItem[];
}

export interface RenderedStructureItem {
  event: MarketStructureEvent;
  midpoint: number;
}

export interface PrimitiveUpdateRef {
  current: (() => void) | null;
}

/** Only the primitive that owns the current callback may clear it. */
export const createPrimitiveUpdateBinding = (target: PrimitiveUpdateRef) => {
  let owned: (() => void) | null = null;
  return {
    attach(requestUpdate: () => void) {
      owned = requestUpdate;
      target.current = requestUpdate;
    },
    detach() {
      if (target.current === owned) target.current = null;
      owned = null;
    },
  };
};

const sameMitigationSteps = (left: FairValueGap['mitigationSteps'], right: FairValueGap['mitigationSteps']) =>
  left.length === right.length && left.every((step, index) => {
    const other = right[index];
    return step.time === other.time
      && step.remainingTop === other.remainingTop
      && step.remainingBottom === other.remainingBottom
      && step.filledTop === other.filledTop
      && step.filledBottom === other.filledBottom;
  });

export const sameFairValueGap = (left: FairValueGap, right: FairValueGap): boolean =>
  left.direction === right.direction
  && left.startTime === right.startTime
  && left.endTime === right.endTime
  && left.top === right.top
  && left.bottom === right.bottom
  && left.mitigated === right.mitigated
  && left.touched === right.touched
  && sameMitigationSteps(left.mitigationSteps, right.mitigationSteps);

const sameRenderedFvgItems = (left: RenderedFvgItem[], right: RenderedFvgItem[]) =>
  left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return item.isEntry === other.isEntry
      && item.formingTime === other.formingTime
      && sameFairValueGap(item.gap, other.gap);
  });

export const sameRenderedFvgSnapshot = (left: RenderedFvgSnapshot, right: RenderedFvgSnapshot): boolean =>
  sameRenderedFvgItems(left.regular, right.regular) && sameRenderedFvgItems(left.entry, right.entry);

const sameStructureEvent = (left: MarketStructureEvent, right: MarketStructureEvent) =>
  left.type === right.type
  && left.direction === right.direction
  && left.pivotTime === right.pivotTime
  && left.breakTime === right.breakTime
  && left.price === right.price
  && left.labelPrice === right.labelPrice
  && left.protectedPrice === right.protectedPrice
  && left.protectedTime === right.protectedTime;

export const sameRenderedStructure = (left: RenderedStructureItem[], right: RenderedStructureItem[]): boolean =>
  left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return item.midpoint === other.midpoint && sameStructureEvent(item.event, other.event);
  });
