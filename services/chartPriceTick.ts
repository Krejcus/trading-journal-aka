export const NQ_MNQ_TICK_SIZE = 0.25;

export const roundNqMnqPriceToTick = (price: number): number => {
  if (!Number.isFinite(price)) return price;
  const rounded = Math.round(price / NQ_MNQ_TICK_SIZE) * NQ_MNQ_TICK_SIZE;
  return Object.is(rounded, -0) ? 0 : Number(rounded.toFixed(8));
};

export const formatNqMnqTickPrice = (price: number): string => (
  roundNqMnqPriceToTick(price).toFixed(2)
);
