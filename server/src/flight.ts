/** Requests that miss a cache at the same moment share one read instead of each making their own. */
export function shared<T>(read: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= read().finally(() => (p = null)));
}
