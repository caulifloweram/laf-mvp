/**
 * Launcher: Mac-style desktop with Broadcaster and Radio icons.
 * Double-click opens the app in a window (iframe).
 */

const desktop = document.getElementById("desktop")!;
const VIEWPORT_PAD = 16;

const clientUrl = (import.meta.env.VITE_CLIENT_URL as string) || "client/";
const broadcasterUrl = (import.meta.env.VITE_BROADCASTER_URL as string) || "broadcaster/";

const APP_CONFIG: Record<string, { title: string; url: string }> = {
  broadcaster: { title: "Broadcaster", url: broadcasterUrl },
  radio: { title: "Radio", url: clientUrl },
};

let dragState: {
  windowEl: HTMLElement;
  startX: number;
  startY: number;
  startLeft: number;
  startTop: number;
} | null = null;

function px(n: number): string {
  return `${n}px`;
}

function centerInViewport(win: HTMLElement) {
  const deskRect = desktop.getBoundingClientRect();
  const winRect = win.getBoundingClientRect();
  const vLeft = Math.max(VIEWPORT_PAD, (window.innerWidth - winRect.width) / 2);
  const vTop = Math.max(VIEWPORT_PAD, (window.innerHeight - winRect.height) / 2);
  win.style.left = px(vLeft - deskRect.left);
  win.style.top = px(vTop - deskRect.top);
}

function bringToFront(win: HTMLElement) {
  document.querySelectorAll(".app-window").forEach((w) => w.classList.remove("bring-front"));
  win.classList.add("bring-front");
}

function onTitleMouseDown(e: MouseEvent, win: HTMLElement) {
  const target = e.target as HTMLElement;
  if (target.closest(".close-box") || target.closest(".minimize-box")) return;
  e.preventDefault();
  bringToFront(win);
  const winRect = win.getBoundingClientRect();
  const deskRect = desktop.getBoundingClientRect();
  dragState = {
    windowEl: win,
    startX: e.clientX,
    startY: e.clientY,
    startLeft: winRect.left - deskRect.left,
    startTop: winRect.top - deskRect.top,
  };
}

function onMouseMove(e: MouseEvent) {
  if (!dragState) return;
  e.preventDefault();
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;
  dragState.windowEl.style.left = px(dragState.startLeft + dx);
  dragState.windowEl.style.top = px(dragState.startTop + dy);
}

function onMouseUp() {
  dragState = null;
}

function openApp(appId: string) {
  const config = APP_CONFIG[appId];
  if (!config) return;

  const win = document.createElement("div");
  win.className = "app-window bring-front";
  win.dataset.app = appId;
  const id = `window-${appId}-${Date.now()}`;
  win.id = id;

  win.innerHTML = `
    <div class="app-window-title">
      <span class="close-box" title="Close"></span>
      <span class="minimize-box" title="Minimize"></span>
      ${config.title}
    </div>
    <iframe class="app-window-frame" src="${config.url}" title="${config.title}"></iframe>
  `;

  desktop.appendChild(win);
  centerInViewport(win);

  const titleBar = win.querySelector(".app-window-title")!;
  titleBar.addEventListener("mousedown", (e) => onTitleMouseDown(e as MouseEvent, win));

  win.querySelector(".close-box")!.addEventListener("click", (e) => {
    e.stopPropagation();
    win.remove();
  });

  const minimizeBox = win.querySelector(".minimize-box");
  if (minimizeBox) {
    minimizeBox.addEventListener("click", (e) => {
      e.stopPropagation();
      const frame = win.querySelector(".app-window-frame") as HTMLIFrameElement;
      if (frame) frame.style.display = frame.style.display === "none" ? "" : "none";
    });
  }
}

function init() {
  document.getElementById("icon-broadcaster")!.addEventListener("dblclick", () => openApp("broadcaster"));
  document.getElementById("icon-radio")!.addEventListener("dblclick", () => openApp("radio"));

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
  document.addEventListener("mouseleave", onMouseUp);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
