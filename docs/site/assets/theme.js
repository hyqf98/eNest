/* Theme applies before paint and shares the existing docs preference. */
(() => {
  const root = document.documentElement;
  const preference = matchMedia("(prefers-color-scheme: dark)");
  let stored;
  try {
    stored = localStorage.getItem("enest-site-theme");
  } catch (_) {}
  const apply = (value) => {
    root.dataset.theme = value;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = value === "dark" ? "#15221d" : "#f5f7f4";
    document.dispatchEvent(new CustomEvent("site-theme-change", { detail: value }));
  };
  apply(
    stored === "dark" || stored === "light"
      ? stored
      : preference.matches
        ? "dark"
        : "light",
  );
  preference.addEventListener("change", () => {
    if (stored !== "dark" && stored !== "light")
      apply(preference.matches ? "dark" : "light");
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("[data-theme-toggle]")) return;
    stored = root.dataset.theme === "dark" ? "light" : "dark";
    apply(stored);
    try {
      localStorage.setItem("enest-site-theme", stored);
    } catch (_) {}
  });
})();
