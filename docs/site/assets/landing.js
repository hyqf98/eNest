/* Native scroll is the driver. One active-scene frame loop; no wheel interception. */
(() => {
  "use strict";
  const root = document.documentElement;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const desktop = matchMedia("(min-width: 900px) and (min-height: 650px)");
  const clamp = (value, min = 0, max = 1) =>
    Math.min(max, Math.max(min, value));
  const motion = {
    high: { duration: 340, enter: 850 },
    medium: { duration: 280, enter: 450 },
    low: { duration: 0, enter: 0 },
  };
  const duration = () => motion[root.dataset.anim || "high"].duration;
  const animate = (element, frames, options = {}) => {
    if (!element?.animate || reduce.matches) return;
    return element.animate(frames, {
      duration: duration(),
      easing: "cubic-bezier(.22,1,.36,1)",
      ...options,
    });
  };
  root.classList.add("has-js");
  const nav = document.querySelector(".nav-links");
  const navToggle = document.querySelector(".nav-toggle");
  const closeNav = () => {
    nav?.classList.remove("is-open");
    navToggle?.setAttribute("aria-expanded", "false");
  };
  navToggle?.addEventListener("click", () => {
    const open = !nav.classList.contains("is-open");
    nav.classList.toggle("is-open", open);
    navToggle.setAttribute("aria-expanded", String(open));
  });
  nav?.addEventListener("click", (event) => {
    if (event.target.closest("a")) closeNav();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && nav?.classList.contains("is-open")) {
      closeNav();
      navToggle.focus();
    }
  });

  const dialog = document.querySelector(".image-dialog");
  let returnFocus;
  document.querySelectorAll("[data-zoom]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!dialog?.showModal) {
        window.open(button.dataset.zoom, "_blank", "noopener");
        return;
      }
      returnFocus = button;
      const img = dialog.querySelector("img");
      img.src = button.dataset.zoom;
      img.alt = button.dataset.caption;
      dialog.querySelector("h2").textContent = button.dataset.caption;
      dialog.showModal();
    });
  });
  dialog
    ?.querySelector("[data-close-dialog]")
    .addEventListener("click", () => dialog.close());
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        dialog.close();
    }
  });
  dialog?.addEventListener("close", () =>
    returnFocus?.focus({ preventScroll: true }),
  );

  const tools = [...document.querySelectorAll(".tool")];
  document.querySelectorAll("[data-filter]").forEach((button) =>
    button.addEventListener("click", () => {
      document
        .querySelectorAll("[data-filter]")
        .forEach((item) =>
          item.setAttribute("aria-pressed", String(item === button)),
        );
      let count = 0;
      tools.forEach((tool) => {
        tool.hidden =
          button.dataset.filter !== "全部" &&
          tool.dataset.category !== button.dataset.filter;
        if (!tool.hidden) count++;
      });
      document.querySelector(".catalog-count").textContent = `${count} 个工具`;
      document.querySelector(".catalog-empty").hidden = count > 0;
      animate(document.querySelector(".tool-grid"), [
        { opacity: 0.5, transform: "translateY(6px)" },
        { opacity: 1, transform: "translateY(0)" },
      ]);
    }),
  );
  // Preview choices are explicit, never replaced by a timer or the scroll stage.
  document.querySelectorAll("[data-preview]").forEach((button) => {
    button.setAttribute(
      "aria-pressed",
      String(button.classList.contains("is-selected")),
    );
    button.addEventListener("click", () => {
      const panel = button.closest(".scene-panel");
      panel.dataset.previewChosen = "true";
      panel.querySelectorAll("[data-preview]").forEach((item) => {
        item.classList.toggle("is-selected", item === button);
        item.setAttribute("aria-pressed", String(item === button));
      });
      const imageButton = panel.querySelector("[data-zoom]");
      const image = imageButton.querySelector("img");
      imageButton.dataset.zoom = `assets/screens/${button.dataset.preview}.webp`;
      imageButton.dataset.caption = button.dataset.title;
      imageButton.setAttribute("aria-label", `放大${button.dataset.title}`);
      image.src = imageButton.dataset.zoom;
      image.alt = button.dataset.title;
      image.style.removeProperty("transform");
      panel.querySelector("[data-preview-title]").textContent =
        button.dataset.title;
      panel.querySelector("[data-preview-description]").textContent =
        button.dataset.description;
      animate(imageButton, [
        { opacity: 0.4, transform: "translateY(8px)" },
        { opacity: 1, transform: "translateY(0)" },
      ]);
    });
  });
  const appearanceStage = document.querySelector("[data-appearance-stage]");
  let appearanceChosen = false;
  const setAppearance = (value) => {
    if (!appearanceStage || appearanceStage.dataset.appearanceStage === value)
      return;
    appearanceStage.dataset.appearanceStage = value;
    document
      .querySelectorAll("[data-appearance]")
      .forEach((button) =>
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.appearance === value),
        ),
      );
    const button = appearanceStage.querySelector("[data-zoom]");
    const path = `assets/screens/${value === "light" ? "shell" : `shell-${value}`}.webp`;
    const label = `eNest ${value === "light" ? "明亮" : value === "dark" ? "深色" : "氛围"}主题工作台`;
    button.dataset.zoom = path;
    button.dataset.caption = label;
    button.setAttribute("aria-label", `放大${label}`);
    button.querySelector("img").src = path;
    button.querySelector("img").alt = label;
  };
  document.querySelectorAll("[data-appearance]").forEach((button) =>
    button.addEventListener("click", () => {
      appearanceChosen = true;
      setAppearance(button.dataset.appearance);
    }),
  );

  const chapters = [...document.querySelectorAll("[data-chapter]")];
  if (!chapters.length || !("IntersectionObserver" in window)) return;
  const heroWindow = document.querySelector(".hero-window");
  const heroTop = document.querySelector(".hero-top");
  const modules = [...document.querySelectorAll(".module")];
  const formButtons = [...document.querySelectorAll("[data-form]")];
  const formPanels = [...document.querySelectorAll("[data-form-panel]")];
  const sceneButtons = [...document.querySelectorAll("[data-scene]")];
  const scenePanels = [...document.querySelectorAll("[data-scene-panel]")];
  let immersive = false,
    frame = 0,
    lastY = NaN,
    dirty = true,
    formIndex = -1,
    sceneIndex = -1;
  const active = new Set();
  const navHeight = () =>
    parseFloat(getComputedStyle(root).getPropertyValue("--nav-h")) || 76;
  const selectPanel = (buttons, panels, index) => {
    buttons.forEach((button, i) => {
      button.classList.toggle("is-selected", i === index);
      if (i === index) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    });
    panels.forEach((panel, i) => {
      panel.classList.toggle("is-current", i === index);
      panel.inert = immersive && i !== index;
      if (immersive && i !== index) panel.setAttribute("aria-hidden", "true");
      else panel.removeAttribute("aria-hidden");
    });
  };
  const paint = (chapter, progress) => {
    chapter.dataset.progress = progress.toFixed(3);
    switch (chapter.dataset.chapter) {
      case "assembly": {
        const p = clamp(progress / 0.75);
        heroWindow.style.transform = `translateY(${p * 18}px) rotateX(${3 * (1 - p)}deg) rotateY(${-2 * (1 - p)}deg) rotateZ(${-1 * (1 - p)}deg) scale(${1 + p * 0.08})`;
        heroTop.style.transform = `translateY(${-p * 14}px)`;
        modules.forEach((module, index) => {
          // Each module travels toward the edge of the same work surface.
          const directions = [
            [38, 25, -8],
            [-38, 25, 8],
            [24, -18, 6],
            [-24, -18, -6],
            [0, -12, -4],
            [0, -12, 4],
          ];
          const [x, y, r] = directions[index];
          module.style.transform = `translate(${x * p}px,${y * p}px) rotate(${r * (1 - p)}deg) scale(${1 - p * 0.12})`;
        });
        break;
      }
      case "forms": {
        const index = Math.min(2, Math.floor(progress * 3));
        if (index !== formIndex) {
          formIndex = index;
          selectPanel(formButtons, formPanels, index);
        }
        const local = (progress * 3) % 1;
        const visual = formPanels[index].querySelector(".screenshot");
        visual.style.transform = `perspective(1400px) rotateY(${(1 - clamp(local / 0.7)) * -4}deg) translateX(${(1 - clamp(local / 0.7)) * 14}px)`;
        break;
      }
      case "scenarios": {
        const index = progress < 0.5 ? 0 : 1;
        if (index !== sceneIndex) {
          sceneIndex = index;
          selectPanel(sceneButtons, scenePanels, index);
        }
        const p = index === 0 ? progress * 2 : (progress - 0.5) * 2;
        scenePanels[index].querySelector(".scene-media").style.transform =
          `perspective(1600px) rotateY(${-3 * (1 - p)}deg) translateY(${-8 * p}px)`;
        if (!scenePanels[index].dataset.previewChosen) {
          const image = scenePanels[index].querySelector(".screenshot img");
          image.style.transformOrigin =
            index === 0 ? "50% 40%" : `65% ${30 + 45 * p}%`;
          image.style.transform = `scale(${1 + 0.12 * clamp((p - 0.15) / 0.65)})`;
        }
        break;
      }
      case "personal": {
        const p = clamp(progress);
        appearanceStage.style.transform = `perspective(1500px) rotateY(${-4 + 8 * p}deg) translateY(${-15 * p}px)`;
        if (!appearanceChosen)
          setAppearance(p < 0.34 ? "light" : p < 0.67 ? "dark" : "ambient");
        break;
      }
    }
  };
  const tick = () => {
    frame = 0;
    if (!immersive || document.hidden || !active.size) return;
    if (dirty || lastY !== window.scrollY) {
      lastY = window.scrollY;
      dirty = false;
      const header = navHeight();
      active.forEach((chapter) => {
        const rect = chapter.getBoundingClientRect();
        const distance = Math.max(
          1,
          rect.height - (window.innerHeight - header),
        );
        paint(chapter, clamp((header - rect.top) / distance));
      });
    }
  };
  const wake = () => {
    dirty = true;
    if (!frame && immersive && !document.hidden)
      frame = requestAnimationFrame(tick);
  };
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) active.add(entry.target);
      else active.delete(entry.target);
    });
    wake();
  });
  chapters.forEach((chapter) => observer.observe(chapter));
  const configure = () => {
    immersive =
      desktop.matches && !reduce.matches && !!Element.prototype.animate;
    root.dataset.anim = reduce.matches ? "low" : immersive ? "high" : "medium";
    root.classList.toggle("immersive", immersive);
    cancelAnimationFrame(frame);
    frame = 0;
    formIndex = -1;
    sceneIndex = -1;
    if (!immersive) {
      [
        heroWindow,
        heroTop,
        appearanceStage,
        ...modules,
        ...document.querySelectorAll(
          ".scene-media,.scene-media img,.form-panel .screenshot",
        ),
      ].forEach((element) => element?.style.removeProperty("transform"));
      [...formPanels, ...scenePanels].forEach((panel) => {
        panel.inert = false;
        panel.removeAttribute("aria-hidden");
      });
    }
    wake();
  };
  const goToBeat = (chapter, p, smooth = true) => {
    const header = navHeight();
    window.scrollTo({
      top:
        window.scrollY +
        chapter.getBoundingClientRect().top -
        header +
        p * (chapter.offsetHeight - (innerHeight - header)),
      behavior: reduce.matches || !smooth ? "instant" : "smooth",
    });
    wake();
  };
  formButtons.forEach((button, index) =>
    button.addEventListener("click", (event) => {
      if (
        !immersive ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      event.preventDefault();
      history.pushState(null, "", button.hash);
      goToBeat(document.querySelector(".forms"), [0.08, 0.45, 0.8][index]);
    }),
  );
  sceneButtons.forEach((button, index) =>
    button.addEventListener("click", (event) => {
      if (
        !immersive ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      event.preventDefault();
      history.pushState(null, "", button.hash);
      goToBeat(document.querySelector(".scenarios"), index ? 0.65 : 0.15);
    }),
  );
  const restoreHash = () => {
    if (!immersive) return;
    const forms = ["#quick", "#workspace", "#detached"];
    const scenes = ["#everyday", "#development"];
    if (forms.includes(location.hash))
      goToBeat(
        document.querySelector(".forms"),
        [0.08, 0.45, 0.8][forms.indexOf(location.hash)],
        false,
      );
    else if (scenes.includes(location.hash))
      goToBeat(
        document.querySelector(".scenarios"),
        scenes.indexOf(location.hash) ? 0.65 : 0.15,
        false,
      );
    wake();
  };
  reduce.addEventListener("change", configure);
  desktop.addEventListener("change", configure);
  window.addEventListener("resize", wake);
  window.addEventListener("scroll", wake, { passive: true });
  window.addEventListener("pageshow", wake);
  window.addEventListener("hashchange", restoreHash);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      cancelAnimationFrame(frame);
      frame = 0;
    } else wake();
  });
  document
    .querySelectorAll("img")
    .forEach((img) => img.addEventListener("load", wake));
  document.fonts?.ready.then(wake);
  if ("ResizeObserver" in window) {
    const sizes = new ResizeObserver(wake);
    chapters.forEach((chapter) => sizes.observe(chapter));
  }
  configure();
  // Native fragment scrolling runs after the document loads. Restore a stage
  // beat afterwards so an overlaid figure cannot send a deep link to Quick.
  if (document.readyState === "complete") requestAnimationFrame(restoreHash);
  else
    window.addEventListener("load", () => requestAnimationFrame(restoreHash), {
      once: true,
    });
  // Opening choreography is bounded and leaves content visible if interrupted.
  if (!reduce.matches) {
    animate(
      heroWindow,
      [
        { opacity: 0.5, translate: "0 18px" },
        { opacity: 1, translate: "0 0" },
      ],
      { duration: motion[root.dataset.anim].enter },
    );
    modules.forEach((module, index) =>
      animate(
        module,
        [
          { opacity: 0, translate: `0 ${20 + index * 3}px` },
          { opacity: 1, translate: "0 0" },
        ],
        { duration: 450, delay: index * 55, fill: "backwards" },
      ),
    );
    const closing = document.querySelector(".closing-mark");
    const reveal = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            animate(
              closing,
              [
                { rotate: "-12deg", translate: "0 25px" },
                { rotate: "0deg", translate: "0 0" },
              ],
              { duration: 450 },
            );
            reveal.unobserve(entry.target);
          }
        }),
      { threshold: 0.5 },
    );
    if (closing) reveal.observe(closing);
  }
})();
