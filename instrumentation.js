// Next.js runs this before any page renders.
// Node.js 25 defines localStorage as an experimental global, but when
// --localstorage-file is missing/invalid it exists as a broken object
// where .getItem is not a function. This crashes @vercel/analytics and
// Next.js internals during SSR. Remove it so code falls back to the
// standard "localStorage is not defined" path.
export function register() {
  if (
    typeof globalThis.localStorage !== 'undefined' &&
    typeof globalThis.localStorage.getItem !== 'function'
  ) {
    delete globalThis.localStorage;
  }
}
