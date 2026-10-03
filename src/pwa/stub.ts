/**
 * Stand-in for `virtual:pwa-register` in builds without a service worker
 * (e.g. the single-file artifact build, where service workers are not allowed).
 */
export function registerSW(_opts?: unknown): (reload?: boolean) => Promise<void> {
  return async () => undefined;
}
