/**
 * Desktop window behavior: drag, close, minimize, bring to front.
 */

const desktop = document.getElementById("desktop")!;
const WINDOW_SELECTOR = ".mac-window, .player-section";

type DragState = {
  windowEl: HTMLElement;
  startX: number;
  startY: number;
  startLeft: number;
  startTop: number;
};

let dragState: DragState | null = null;

function px(num: number): string {
  return `${num}px`;
}

function bringToFront(win: HTMLElement) {
  document.querySelectorAll(WINDOW_SELECTOR).forEach((w) => w.classList.remove("bring-front"));
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

function closeWindow(win: HTMLElement) {
  const id = win.getAttribute("data-window-id");
  if (!id) return;
  win.classList.add("window-closed");
  const taskbarBtn = document.getElementById(`taskbar-${id}`);
  if (taskbarBtn) {
    taskbarBtn.classList.remove("hidden");
  }
}

function restoreWindow(id: string) {
  const win = document.querySelector(`[data-window-id="${id}"]`) as HTMLElement;
  const taskbarBtn = document.getElementById(`taskbar-${id}`);
  if (!win || !taskbarBtn) return;
  win.classList.remove("window-closed");
  taskbarBtn.classList.add("hidden");
  if (id === "player") {
    win.classList.remove("hidden");
  }
  bringToFront(win);
}

function minimizeWindow(win: HTMLElement) {
  const body = win.querySelector(".mac-window-body") as HTMLElement;
  if (!body) return;
  const isMinimized = win.classList.toggle("minimized");
  body.style.display = isMinimized ? "none" : "";
}

function init() {
  document.querySelectorAll(WINDOW_SELECTOR).forEach((winEl) => {
    const win = winEl as HTMLElement;
    if (!win.hasAttribute("data-window-id")) return;

    const titleBar = win.querySelector(".mac-window-title");
    if (!titleBar) return;

    titleBar.addEventListener("mousedown", (e) => onTitleMouseDown(e as MouseEvent, win));

    const closeBox = titleBar.querySelector(".close-box");
    if (closeBox) {
      closeBox.addEventListener("click", (e) => {
        e.stopPropagation();
        closeWindow(win);
      });
    }

    const minimizeBox = titleBar.querySelector(".minimize-box");
    if (minimizeBox) {
      minimizeBox.addEventListener("click", (e) => {
        e.stopPropagation();
        minimizeWindow(win);
      });
    }
  });

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
  document.addEventListener("mouseleave", onMouseUp);

  document.getElementById("taskbar-channels")?.addEventListener("click", () => restoreWindow("channels"));
  document.getElementById("taskbar-player")?.addEventListener("click", () => restoreWindow("player"));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
