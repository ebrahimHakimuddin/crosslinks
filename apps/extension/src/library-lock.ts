// The service worker is the single writer for the Chrome library.  Keep this
// queue in its own module so background alarms, RPCs, and storage callbacks
// share the same serialization boundary.
let queue = Promise.resolve();

export function withLibraryLock<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.then(() => undefined, () => undefined);
  return run;
}
