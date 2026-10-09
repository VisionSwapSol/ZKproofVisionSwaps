/**
 * At most `limit` jobs of one kind at once; a few more wait their turn briefly, and anything
 * beyond that is turned away with a 503 carrying `busyMessage`. Keeps one expensive endpoint
 * from using up the whole server or its RPC plan.
 */
export function gate(limit: number, maxQueue: number, maxWaitMs: number, busyMessage: string) {
  let active = 0;
  const queue: { go: () => void; timer: ReturnType<typeof setTimeout> }[] = [];
  const busy = () => Object.assign(new Error(busyMessage), { status: 503, retryAfter: 5 });
  // a finished job hands its slot straight to the next in line
  const release = () => {
    const next = queue.shift();
    if (!next) return void active--;
    clearTimeout(next.timer);
    next.go();
  };
  const run = async <T>(job: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      if (queue.length >= maxQueue) throw busy();
      await new Promise<void>((resolve, reject) => {
        const entry = {
          go: () => resolve(),
          timer: setTimeout(() => {
            queue.splice(queue.indexOf(entry), 1);
            reject(busy());
          }, maxWaitMs),
        };
        queue.push(entry);
      });
    } else active++;
    try {
      return await job();
    } finally {
      release();
    }
  };
  return Object.assign(run, { stats: () => ({ active, queued: queue.length }) });
}
