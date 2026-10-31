import { describe, expect, it } from 'vitest';
import {
  createPrimitiveUpdateBinding,
  sameRenderedFvgSnapshot,
  sameRenderedStructure,
  type RenderedFvgSnapshot,
  type RenderedStructureItem,
} from '../services/chartIndicatorPaint';

const fvgSnapshot = (): RenderedFvgSnapshot => ({
  regular: [{
    isEntry: false,
    formingTime: 90,
    gap: {
      direction: 'bullish',
      startTime: 100,
      endTime: 140,
      top: 20,
      bottom: 10,
      mitigated: false,
      touched: true,
      mitigationSteps: [{ time: 120, remainingTop: 20, remainingBottom: 12, filledTop: 12, filledBottom: 10 }],
    },
  }],
  entry: [],
});

const structureSnapshot = (): RenderedStructureItem[] => [{
  midpoint: 120,
  event: {
    type: 'BOS',
    direction: 'bullish',
    pivotTime: 100,
    breakTime: 140,
    price: 20,
    labelPrice: 21,
    protectedPrice: 10,
    protectedTime: 80,
  },
}];

describe('indicator paint snapshots', () => {
  it('opožděný detach staré vrstvy nesmaže paint callback nové vrstvy', () => {
    const target = { current: null as (() => void) | null };
    const oldBinding = createPrimitiveUpdateBinding(target);
    const newBinding = createPrimitiveUpdateBinding(target);
    const oldUpdate = () => undefined;
    const newUpdate = () => undefined;
    oldBinding.attach(oldUpdate);
    newBinding.attach(newUpdate);
    oldBinding.detach();
    expect(target.current).toBe(newUpdate);
    newBinding.detach();
    expect(target.current).toBeNull();
  });

  it('považuje nový objekt se stejnou FVG geometrií za stejný paint', () => {
    expect(sameRenderedFvgSnapshot(fvgSnapshot(), fvgSnapshot())).toBe(true);
  });

  it('odhalí změnu vyplnění FVG, i když zůstane stejný počet boxů', () => {
    const previous = fvgSnapshot();
    const next = fvgSnapshot();
    next.regular[0].gap.mitigationSteps[0].remainingBottom = 13;
    expect(sameRenderedFvgSnapshot(previous, next)).toBe(false);
  });

  it('odhalí změnu struktury, ale ignoruje novou identitu objektu', () => {
    expect(sameRenderedStructure(structureSnapshot(), structureSnapshot())).toBe(true);
    const changed = structureSnapshot();
    changed[0].event.labelPrice = 22;
    expect(sameRenderedStructure(structureSnapshot(), changed)).toBe(false);
  });
});
