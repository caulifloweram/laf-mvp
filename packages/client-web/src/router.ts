/**
 * Hash-based routing: #live (homepage), #about. Default #live.
 */

export type RouteId = "live" | "about";

const ROUTES: RouteId[] = ["live", "about"];
const DEFAULT_ROUTE: RouteId = "live";

export function getRoute(): RouteId {
  const hash = window.location.hash.slice(1).toLowerCase();
  if (hash === "home") return DEFAULT_ROUTE;
  return ROUTES.includes(hash as RouteId) ? (hash as RouteId) : DEFAULT_ROUTE;
}

export function setRoute(route: RouteId): void {
  window.location.hash = route;
}

export function initRouter(onRoute: (route: RouteId) => void): void {
  function apply() {
    const route = getRoute();
    onRoute(route);
  }
  window.addEventListener("hashchange", apply);
  apply();
}
