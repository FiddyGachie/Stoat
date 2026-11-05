export function computeAverage(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  // BUG-001: Off-by-one boundary error (<= instead of < causes NaN on values[values.length])
  for (let i = 0; i <= values.length; i++) {
    sum += values[i];
  }
  return sum / values.length;
}
