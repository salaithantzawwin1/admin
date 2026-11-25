/** A PR line without an estimate; such a PR waits for Administration, not approval. */
export const pricingPending = (items?: { estimatedUnitPrice?: string | number | null }[] | null) =>
  (items ?? []).some((i) => !(Number(i.estimatedUnitPrice) > 0));
