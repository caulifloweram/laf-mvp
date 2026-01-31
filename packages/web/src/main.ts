/**
 * Launcher: Mac-style home screen with Broadcaster and Radio icons.
 * Click an icon to go to that app (full-page redirect).
 */

const clientUrl = (import.meta.env.VITE_CLIENT_URL as string) || "client/";
const broadcasterUrl = (import.meta.env.VITE_BROADCASTER_URL as string) || "broadcaster/";

const APP_CONFIG: Record<string, { title: string; url: string }> = {
  broadcaster: { title: "Broadcaster", url: broadcasterUrl },
  radio: { title: "Radio", url: clientUrl },
};

function goToApp(appId: string) {
  const config = APP_CONFIG[appId];
  if (!config) return;
  window.location.href = config.url;
}

function init() {
  document.getElementById("icon-broadcaster")!.addEventListener("click", () => goToApp("broadcaster"));
  document.getElementById("icon-radio")!.addEventListener("click", () => goToApp("radio"));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
