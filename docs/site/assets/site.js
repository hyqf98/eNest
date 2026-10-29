/* Shared page controls; homepage scenes live in landing.js. */
(() => {
  "use strict";
  document.documentElement.classList.add("has-js");

  const nav = document.querySelector(".nav-links");
  const toggle = document.querySelector(".nav-toggle");
  if (nav && toggle) {
    let compact;
    const setOpen = (open) => {
      nav.classList.toggle("is-open", open);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "关闭菜单" : "打开菜单");
      const mark = toggle.querySelector('[aria-hidden="true"]');
      if (mark) mark.textContent = open ? "−" : "＋";
      nav.inert = compact && !open;
      if (compact && !open) nav.setAttribute("aria-hidden", "true");
      else nav.removeAttribute("aria-hidden");
    };
    const syncNavigation = () => {
      const nextCompact = getComputedStyle(toggle).display !== "none";
      if (compact === nextCompact) return;
      compact = nextCompact;
      setOpen(false);
    };
    toggle.addEventListener("click", () =>
      setOpen(toggle.getAttribute("aria-expanded") !== "true"),
    );
    nav.addEventListener("click", (event) => {
      if (event.target.closest("a")) setOpen(false);
    });
    document.addEventListener("click", (event) => {
      if (!nav.contains(event.target) && !toggle.contains(event.target))
        setOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && nav.classList.contains("is-open")) {
        setOpen(false);
        toggle.focus();
      }
    });
    document.addEventListener("focusin", (event) => {
      if (!nav.contains(event.target) && !toggle.contains(event.target))
        setOpen(false);
    });
    window.addEventListener("resize", syncNavigation, { passive: true });
    syncNavigation();
  }

  const syncThemeButtons = () => {
    const next = document.documentElement.dataset.theme === "dark" ? "浅色" : "深色";
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      button.setAttribute("aria-label", `切换到${next}主题`);
      button.title = `切换到${next}主题`;
    });
  };
  document.addEventListener("site-theme-change", syncThemeButtons);
  syncThemeButtons();

  const dialog = document.querySelector(".image-dialog");
  if (!dialog?.showModal) return;
  const preview = dialog.querySelector("img");
  const heading = dialog.querySelector("h2");
  if (!preview || !heading) return;
  let returnFocus;
  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-zoom]");
    if (
      !trigger || event.defaultPrevented || event.button !== 0 ||
      event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
    ) return;
    const visibleImage = [...trigger.querySelectorAll("img")].find(
      (image) => image.getClientRects().length && getComputedStyle(image).visibility !== "hidden",
    );
    const source = visibleImage?.currentSrc || visibleImage?.src || trigger.dataset.zoom;
    if (!source) return;
    event.preventDefault();
    returnFocus = trigger;
    preview.src = source;
    preview.alt = visibleImage?.alt || trigger.dataset.caption || "eNest 界面预览";
    heading.textContent = trigger.dataset.caption || preview.alt;
    document.body.classList.add("dialog-open");
    dialog.showModal();
  });
  dialog.querySelector("[data-close-dialog]")?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (
      event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom
    ) dialog.close();
  });
  dialog.addEventListener("close", () => {
    document.body.classList.remove("dialog-open");
    const canFocus = (element) => element?.isConnected && !element.disabled &&
      !element.closest("[hidden], [inert]") && element.getClientRects().length &&
      getComputedStyle(element).visibility !== "hidden";
    const quick = returnFocus?.closest("[data-quick-demo]");
    const fallback = quick?.querySelector('[data-quick-step][aria-pressed="true"]') ||
      document.querySelector('.mobile-panel-controls button[aria-pressed="true"]');
    const target = canFocus(returnFocus) ? returnFocus : canFocus(fallback) ? fallback : null;
    target?.focus({ preventScroll: true });
  });
})();
