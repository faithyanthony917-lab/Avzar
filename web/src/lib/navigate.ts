/** Leaves the app for another address (a payment checkout page). A separate function so tests can replace it. */
export function redirectTo(url: string): void {
  window.location.assign(url);
}
