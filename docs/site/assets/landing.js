/* Progressive enhancements for the static product homepage. */
(() => {
  "use strict";
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const mobile = matchMedia("(max-width: 700px)");
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const ease = "cubic-bezier(.22,1,.36,1)";

  const tools = [...document.querySelectorAll(".tool[id][data-category]")];
  const filters = [...document.querySelectorAll("[data-filter]")];
  const count = document.querySelector(".catalog-count");
  const empty = document.querySelector(".catalog-empty");
  let highlightedTool;
  const isAll = (value) => value === "全部" || value === "all";
  const filterTools = (value = "全部") => {
    let visible = 0;
    tools.forEach((tool) => {
      tool.hidden = !isAll(value) && tool.dataset.category !== value;
      if (!tool.hidden) visible++;
    });
    filters.forEach((button) => {
      const selected = button.dataset.filter === value || (isAll(value) && isAll(button.dataset.filter));
      button.setAttribute("aria-pressed", String(selected));
    });
    if (count) count.textContent = `${visible} 个插件`;
    if (empty) empty.hidden = visible > 0;
  };
  filters.forEach((button) =>
    button.addEventListener("click", () => filterTools(button.dataset.filter)),
  );
  if (tools.length) filterTools();
  const findTool = (hash) => {
    try {
      return document.getElementById(decodeURIComponent(hash.slice(1)))?.closest(".tool");
    } catch (_) {
      return null;
    }
  };
  const revealTool = (tool, scroll) => {
    if (tool.hidden) filterTools();
    highlightedTool?.classList.remove("is-highlighted");
    highlightedTool = tool;
    tool.classList.add("is-highlighted");
    if (!tool.hasAttribute("tabindex")) tool.tabIndex = -1;
    if (scroll) {
      tool.scrollIntoView({ behavior: reduce.matches ? "instant" : "smooth", block: "center" });
      tool.focus({ preventScroll: true });
    }
  };
  document.addEventListener("click", (event) => {
    const link = event.target.closest('a[href^="#"]');
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const tool = findTool(link.hash);
    if (!tool) return;
    event.preventDefault();
    if (location.hash !== link.hash) history.pushState(null, "", link.hash);
    revealTool(tool, true);
  });
  const restoreHash = () => {
    const tool = findTool(location.hash);
    if (tool) revealTool(tool, true);
    else {
      highlightedTool?.classList.remove("is-highlighted");
      highlightedTool = null;
    }
  };
  window.addEventListener("hashchange", restoreHash);
  if (location.hash) restoreHash();

  const orbit = document.querySelector("[data-orbit-scene]");
  const icons = [...document.querySelectorAll(".orbit-icon[data-orbit]")];
  if (orbit && icons.length) {
    const heroWindow = orbit.querySelector(".hero-window");
    const rings = [0, 1, 2].map((ring) => icons.filter((icon) => Number(icon.dataset.orbit) === ring));
    const smallMobile = matchMedia("(max-width: 420px)");
    const mobileSeeds = icons.filter((icon) => icon.dataset.mobile).sort((a, b) => Number(a.dataset.mobile) - Number(b.dataset.mobile));
    const mobilePool = [...mobileSeeds, ...icons.filter((icon) => !icon.dataset.mobile)];
    const guides = [...orbit.querySelectorAll(".orbit-guide")];
    const tiles = new Map(icons.map((icon) => [icon, icon.querySelector(".orbit-tile")]));
    const iconOrder = new Map(icons.map((icon, index) => [icon, index]));
    const styleCache = new WeakMap();
    const writeStyle = (element, property, value) => {
      let cached = styleCache.get(element);
      if (!cached) { cached = new Map(); styleCache.set(element, cached); }
      if (cached.get(property) === value) return;
      cached.set(property, value);
      element.style.setProperty(property, value);
    };
    const createTilt = () => ({ x: 0, y: 0, amount: 0, targetX: 0, targetY: 0, targetAmount: 0, pointerX: 0, pointerY: 0, bounds: null, over: false });
    const heroTilt = createTilt();
    const iconTilts = new Map(icons.map((icon) => [icon, createTilt()]));
    const tiltStates = [heroTilt, ...iconTilts.values()];
    const tiltAxes = [["x", "targetX"], ["y", "targetY"], ["amount", "targetAmount"]];
    const movingTilts = new Set();
    const dirtyTilts = new Set([heroTilt]);
    const periods = [22, 28, 34];
    const radii = [0.39, 0.425, 0.46];
    const elevation = 18 * Math.PI / 180;
    const sineElevation = Math.sin(elevation), cosineElevation = Math.cos(elevation);
    let width = 0, height = 0, elapsed = 0, previousTime = 0, frame = 0;
    let cameraDistance = 1, maxDepth = 1, projected = [], depthOrder = [], activeIcons = new Set();
    let projectedByTilt = new Map(), orbitDirty = true, measuredMobile, measuredSmallMobile;
    let inView = !("IntersectionObserver" in window), hovered = null, focused = false;
    const pauseReason = () => reduce.matches ? "reduced-motion" : document.hidden ? "background" : !inView ? "offscreen" : focused ? "focus" : hovered ? "hover" : "";
    const canOrbit = () => projected.length > 0 && !pauseReason();
    const canAnimate = () => projected.length > 0 && inView && !document.hidden && !reduce.matches && (canOrbit() || movingTilts.size > 0);
    const trackTilt = (state) => {
      if (tiltAxes.some(([key, target]) => state[key] !== state[target])) movingTilts.add(state);
      else movingTilts.delete(state);
    };
    const clearTilt = (state) => {
      tiltAxes.forEach(([key, target]) => { state[key] = state[target] = 0; });
      movingTilts.delete(state);
      dirtyTilts.add(state);
      state.liftTransform = state.pointerTransform = "";
    };
    const targetPointer = (state) => {
      if (!state.bounds || reduce.matches) return;
      state.targetX = -clamp((state.pointerY - state.bounds.top) / state.bounds.height * 2 - 1, -1, 1);
      state.targetY = clamp((state.pointerX - state.bounds.left) / state.bounds.width * 2 - 1, -1, 1);
      state.targetAmount = 1;
      trackTilt(state);
    };
    const cachePointerBounds = (element, state) => {
      const bounds = element.getBoundingClientRect();
      state.bounds = { left: bounds.left + window.scrollX, top: bounds.top + window.scrollY, width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) };
    };
    orbit.setAttribute("aria-label", "真实插件围绕 eNest 主窗口，选择图标了解插件");
    const paintHero = (poseChanged) => {
      if (heroWindow) {
        const bob = reduce.matches ? 0 : Math.sin(elapsed / 6.5 * Math.PI * 2) * 4.5;
        writeStyle(heroWindow, "translate", `0 ${(bob - heroTilt.amount * 5).toFixed(2)}px`);
        if (poseChanged) {
          const rest = 1 - heroTilt.amount;
          writeStyle(heroWindow, "--hero-tilt-x", `${(7 * rest).toFixed(3)}deg`);
          writeStyle(heroWindow, "--hero-tilt-y", `${(-7 * rest).toFixed(3)}deg`);
          writeStyle(heroWindow, "--hero-tilt-z", `${(-3 * rest).toFixed(3)}deg`);
          writeStyle(heroWindow, "--hero-hover-scale", (1 + heroTilt.amount * 0.03).toFixed(4));
        }
      }
    };
    const paintTile = (item) => {
      const { tile, tilt } = item;
      if (!tile) return;
      if (dirtyTilts.has(tilt) || !tilt.pointerTransform) {
        tilt.liftTransform = `translateY(${(-tilt.amount * 3).toFixed(2)}px) `;
        tilt.pointerTransform = ` rotateX(${(tilt.x * 19).toFixed(3)}deg) rotateY(${(tilt.y * 19).toFixed(3)}deg) scale(${(1 + tilt.amount * 0.1).toFixed(4)})`;
      }
      writeStyle(tile, "transform", tilt.liftTransform + item.orbitTransform + tilt.pointerTransform);
    };
    const paint = () => {
      if (orbitDirty || dirtyTilts.has(heroTilt)) paintHero(dirtyTilts.has(heroTilt));
      if (orbitDirty) {
        projected.forEach((item) => {
          const { icon, radius, period, phase } = item;
          const angle = elapsed / period * Math.PI * 2 + phase;
          const sine = Math.sin(angle);
          const cosine = Math.cos(angle);
          const z = radius * sine;
          item.depth = z * cosineElevation;
          const perspective = clamp(cameraDistance / (cameraDistance - item.depth), 0.72, 1.38);
          const normalizedDepth = clamp(item.depth / maxDepth, -1, 1);
          const px = radius * cosine * perspective;
          const py = z * sineElevation * perspective;
          writeStyle(icon, "transform", `translate(-50%,-50%) translate3d(${px.toFixed(2)}px,${py.toFixed(2)}px,0) scale(${perspective.toFixed(3)})`);
          writeStyle(icon, "opacity", (0.88 + normalizedDepth * 0.12).toFixed(3));
          item.orbitTransform = `perspective(360px) rotateX(${(26 + sine * 6).toFixed(2)}deg) rotateY(${(-cosine * 38).toFixed(2)}deg) rotateZ(${(sine * 5).toFixed(2)}deg)`;
          paintTile(item);
        });
        // Stable depth ranks change only when icons pass each other or the window plane.
        depthOrder.sort((a, b) => a.depth - b.depth || a.order - b.order);
        let behind = 0, front = 100;
        depthOrder.forEach((item) => writeStyle(item.icon, "z-index", String(item.depth < 0 ? ++behind : ++front)));
        orbitDirty = false;
      } else dirtyTilts.forEach((state) => {
        const item = projectedByTilt.get(state);
        if (item) paintTile(item);
      });
      dirtyTilts.clear();
    };
    const tick = (now) => {
      frame = 0;
      if (!canAnimate()) { previousTime = 0; return; }
      const delta = previousTime ? Math.min((now - previousTime) / 1000, 0.1) : 1 / 60;
      if (canOrbit()) { elapsed += delta; orbitDirty = true; }
      previousTime = now;
      const damping = 1 - Math.exp(-delta * 12);
      movingTilts.forEach((state) => {
        let moving = false;
        tiltAxes.forEach(([key, target]) => {
          const next = state[key] + (state[target] - state[key]) * damping;
          const value = Math.abs(state[target] - next) < 0.001 ? state[target] : next;
          if (state[key] !== value) { state[key] = value; dirtyTilts.add(state); }
          if (value !== state[target]) moving = true;
        });
        if (!moving) movingTilts.delete(state);
      });
      paint();
      if (canAnimate()) frame = requestAnimationFrame(tick);
      else previousTime = 0;
    };
    const wakeFrame = () => {
      if (!frame && canAnimate()) frame = requestAnimationFrame(tick);
    };
    const sync = () => {
      const reason = pauseReason();
      const running = canOrbit();
      const motion = reduce.matches ? "static" : running ? "running" : "paused";
      if (orbit.dataset.motion !== motion) orbit.dataset.motion = motion;
      if (orbit.dataset.pauseReason !== reason) orbit.dataset.pauseReason = reason;
      if (inView && !document.hidden && !reduce.matches) {
        if (orbit.dataset.composited !== "true") orbit.dataset.composited = "true";
      } else if (orbit.hasAttribute("data-composited")) orbit.removeAttribute("data-composited");
      if (!canAnimate()) {
        cancelAnimationFrame(frame);
        frame = 0;
        previousTime = 0;
      } else wakeFrame();
    };
    const updateFocus = () => {
      const active = document.activeElement;
      focused = activeIcons.has(active) && active.matches(":focus-visible");
      sync();
    };
    const measure = () => {
      const nextWidth = orbit.clientWidth;
      const nextHeight = orbit.clientHeight;
      if (nextWidth === width && nextHeight === height && measuredMobile === mobile.matches && measuredSmallMobile === smallMobile.matches) return;
      width = nextWidth;
      height = nextHeight;
      measuredMobile = mobile.matches;
      measuredSmallMobile = smallMobile.matches;
      cameraDistance = Math.max(1, width * 1.8);
      const center = height * 0.43;
      const mobileIcons = mobilePool.slice(0, smallMobile.matches ? 12 : 16);
      const mobileRings = [0, 1].map((ring) => mobileIcons.filter((_, index) => index % 2 === ring));
      const groups = mobile.matches ? mobileRings.map((members, index) => ({
        members, radius: width * [0.36, 0.45][index], center, period: [24, 30][index], phase: 0.18 + index * Math.PI / members.length,
      })) : rings.map((members, index) => ({
        members, radius: width * radii[index], center, period: periods[index], phase: 0.16 + index * 0.32,
      }));
      maxDepth = Math.max(1, ...groups.map((group) => group.radius * cosineElevation));
      projected = groups.flatMap((group) => group.members.map((icon, index) => {
        writeStyle(icon, "left", "50%");
        writeStyle(icon, "top", `${group.center.toFixed(2)}px`);
        return { icon, tile: tiles.get(icon), tilt: iconTilts.get(icon), order: iconOrder.get(icon), radius: group.radius, period: group.period, phase: group.phase + index / group.members.length * Math.PI * 2 };
      }));
      depthOrder = projected.slice();
      projectedByTilt = new Map(projected.map((item) => [item.tilt, item]));
      activeIcons = new Set(projected.map(({ icon }) => icon));
      icons.forEach((icon) => {
        const active = activeIcons.has(icon);
        if (icon.dataset.orbitActive !== String(active)) icon.dataset.orbitActive = String(active);
        if (!active) {
          const tilt = iconTilts.get(icon);
          clearTilt(tilt);
          tilt.over = false;
          tilt.bounds = null;
        }
      });
      guides.forEach((guide, index) => {
        const group = groups[mobile.matches ? index - (guides.length - groups.length) : index];
        writeStyle(guide, "display", group ? "block" : "none");
        if (!group) return;
        // Exact ellipse of the same perspective-projected X/Z circle used by the icons.
        const k = group.radius * cosineElevation / cameraDistance;
        const denominator = 1 - k * k;
        writeStyle(guide, "width", `${(2 * group.radius / Math.sqrt(denominator)).toFixed(2)}px`);
        writeStyle(guide, "height", `${(2 * group.radius * sineElevation / denominator).toFixed(2)}px`);
        writeStyle(guide, "left", "50%");
        writeStyle(guide, "top", `${(group.center + group.radius * sineElevation * k / denominator).toFixed(2)}px`);
        writeStyle(guide, "transform", "translate(-50%, -50%)");
      });
      if (hovered && (!activeIcons.has(hovered) || !hovered.matches(":hover"))) hovered = null;
      orbitDirty = true;
      paint();
      if (!orbit.hasAttribute("data-orbit-enhanced")) orbit.dataset.orbitEnhanced = "";
      projected.forEach(({ icon, tilt }) => {
        if (!tilt.over) return;
        cachePointerBounds(icon, tilt);
        targetPointer(tilt);
      });
      updateFocus();
    };
    const bindPointerTilt = (element, state, isIcon) => {
      const updatePointer = (event) => {
        state.pointerX = event.pageX;
        state.pointerY = event.pageY;
        targetPointer(state);
      };
      element.addEventListener("pointerenter", (event) => {
        if (event.pointerType !== "mouse" || (isIcon && !activeIcons.has(element))) return;
        state.over = true;
        if (isIcon) {
          // Keep a stable reference box while the rendered surface tilts beneath the pointer.
          cachePointerBounds(element, state);
          updatePointer(event);
          hovered = element;
        } else { state.targetAmount = reduce.matches ? 0 : 1; trackTilt(state); }
        sync();
      });
      if (isIcon) element.addEventListener("pointermove", (event) => {
        if (event.pointerType !== "mouse" || !state.over) return;
        updatePointer(event);
        wakeFrame();
      }, { passive: true });
      const leave = () => {
        state.over = false;
        state.bounds = null;
        state.targetX = state.targetY = state.targetAmount = 0;
        trackTilt(state);
        if (isIcon && hovered === element) hovered = null;
        sync();
      };
      element.addEventListener("pointerleave", leave);
      element.addEventListener("pointercancel", leave);
    };
    if (heroWindow) bindPointerTilt(heroWindow, heroTilt, false);
    icons.forEach((icon) => bindPointerTilt(icon, iconTilts.get(icon), true));
    orbit.addEventListener("focusin", updateFocus);
    orbit.addEventListener("focusout", () => queueMicrotask(updateFocus));
    document.addEventListener("pointerdown", () => {
      focused = false;
      sync();
    });
    document.addEventListener("keydown", () => {
      if (activeIcons.has(document.activeElement)) queueMicrotask(updateFocus);
    });
    document.addEventListener("visibilitychange", sync);
    mobile.addEventListener("change", measure);
    smallMobile.addEventListener("change", measure);
    reduce.addEventListener("change", () => {
      if (reduce.matches) {
        tiltStates.forEach(clearTilt);
        paint();
      } else {
        if (heroTilt.over) { heroTilt.targetAmount = 1; trackTilt(heroTilt); }
        iconTilts.forEach((state) => { if (state.over) targetPointer(state); });
      }
      sync();
    });
    if ("ResizeObserver" in window) new ResizeObserver(measure).observe(orbit);
    else window.addEventListener("resize", measure, { passive: true });
    if ("IntersectionObserver" in window) {
      const navigation = document.querySelector(".site-nav");
      let coveredTop = -1, observer;
      const observeVisibleArea = () => {
        const nextCoveredTop = navigation?.offsetHeight || 0;
        if (coveredTop === nextCoveredTop) return;
        coveredTop = nextCoveredTop;
        observer?.disconnect();
        inView = false;
        // The sticky navigation can fully cover the last visible strip of the hero.
        observer = new IntersectionObserver(([entry]) => {
          inView = entry.isIntersecting;
          sync();
        }, { rootMargin: `-${coveredTop}px 0px 0px 0px` });
        observer.observe(orbit);
        sync();
      };
      observeVisibleArea();
      if (navigation && "ResizeObserver" in window) new ResizeObserver(observeVisibleArea).observe(navigation);
      else window.addEventListener("resize", observeVisibleArea, { passive: true });
    }
    measure();
  }

  const quick = document.querySelector("[data-quick-demo]");
  if (quick) {
    const frames = [...quick.querySelectorAll("[data-quick-frame]")];
    const steps = [...document.querySelectorAll("[data-quick-step]")];
    const status = document.querySelector("[data-quick-status]");
    const labels = ["呼出 Quick", "搜索番茄钟", "打开番茄钟"];
    let current = 0, timer = 0, deadline = 0, remaining = 1700;
    let visible = false, started = false, playing = false, chosen = false, animation;
    const select = (index, motion = true) => {
      current = clamp(index, 0, frames.length - 1);
      animation?.cancel();
      frames.forEach((element) => {
        const selected = Number(element.dataset.quickFrame) === current;
        element.hidden = !selected;
        element.inert = !selected;
        element.classList.toggle("is-current", selected);
        if (selected && motion && !reduce.matches && element.animate) animation = element.animate(
          [{ opacity: 0, transform: "translateY(14px) scale(.97)" }, { opacity: 1, transform: "translateY(0) scale(1)" }],
          { duration: 480, easing: ease },
        );
      });
      steps.forEach((button) => {
        const selected = Number(button.dataset.quickStep) === current;
        button.setAttribute("aria-pressed", String(selected));
        if (selected) button.setAttribute("aria-current", "step");
        else button.removeAttribute("aria-current");
      });
      quick.dataset.quickCurrent = String(current);
      if (status) status.textContent = `${String(current + 1).padStart(2, "0")} / ${labels[current] || "演示完成"}`;
    };
    const pause = () => {
      if (timer) remaining = Math.max(0, deadline - performance.now());
      clearTimeout(timer);
      timer = 0;
    };
    const stopForInteraction = () => {
      pause();
      started = true;
      chosen = true;
      playing = false;
    };
    const resume = () => {
      if (!playing || !visible || document.hidden || reduce.matches || timer) return;
      deadline = performance.now() + remaining;
      timer = window.setTimeout(() => {
        timer = 0;
        select(current + 1);
        remaining = 1900;
        if (current === frames.length - 1) playing = false;
        else resume();
      }, remaining);
    };
    const syncPlayback = () => {
      if (!visible || document.hidden || reduce.matches) pause();
      else {
        if (!started) { started = true; playing = true; }
        resume();
      }
    };
    if (frames.length) {
      quick.dataset.enhanced = "true";
      select(reduce.matches ? frames.length - 1 : 0, false);
      if (reduce.matches) started = true;
      quick.addEventListener("focusin", stopForInteraction);
      quick.addEventListener("click", (event) => {
        if (event.target.closest("[data-zoom]")) stopForInteraction();
      });
      steps.forEach((button) => button.addEventListener("click", () => {
        stopForInteraction();
        select(Number(button.dataset.quickStep));
      }));
      document.querySelector("[data-quick-replay]")?.addEventListener("click", () => {
        pause();
        started = true;
        chosen = true;
        playing = !reduce.matches;
        remaining = 1700;
        select(reduce.matches ? frames.length - 1 : 0);
        resume();
      });
      document.addEventListener("visibilitychange", syncPlayback);
      reduce.addEventListener("change", () => {
        if (reduce.matches) {
          pause();
          started = true;
          playing = false;
          animation?.cancel();
          if (!chosen) select(frames.length - 1, false);
        }
      });
      if ("IntersectionObserver" in window) new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting && entry.intersectionRatio >= 0.25;
        syncPlayback();
      }, { threshold: [0, 0.25] }).observe(quick.querySelector(".quick-stage") || quick);
    }
  }

  const desktop = document.querySelector("[data-desktop]");
  if (desktop) {
    const panels = [...desktop.querySelectorAll(".desktop-panel[data-panel]")];
    const layoutButtons = [...document.querySelectorAll("[data-layout]")].filter((element) => element.matches("button"));
    const mobileButtons = [...document.querySelectorAll("button[data-mobile-panel]")];
    const arrangements = {
      focus: { markdown: [0.08, 0.12], calculator: [0.72, 0.93], pomodoro: [0.98, 0.03] },
      parallel: { markdown: [0.02, 0.36], calculator: [0.715, 0.54], pomodoro: [0.995, 0.24] },
    };
    const geometry = new Map();
    const positions = new Map();
    const animations = new Map();
    let width = 0, height = 0, drag, measuredMobile, stacking = 20, entered = reduce.matches || mobile.matches;
    let layout = "focus", mobilePanel = "overview";
    const bounds = (panel) => {
      const size = geometry.get(panel) || { width: 0, height: 0 };
      const maxX = Math.max(0, width - size.width);
      const maxY = Math.max(0, height - size.height);
      const insetX = Math.min(14, maxX / 2);
      const insetY = Math.min(14, maxY / 2);
      return { minX: insetX, minY: insetY, maxX: maxX - insetX, maxY: maxY - insetY };
    };
    const constrained = (panel, x, y) => {
      const area = bounds(panel);
      return { x: clamp(x, area.minX, area.maxX), y: clamp(y, area.minY, area.maxY) };
    };
    const defaultPosition = (panel) => {
      const area = bounds(panel);
      const [x, y] = arrangements[layout][panel.dataset.panel] || [0.5, 0.5];
      const top = Math.min(56, area.maxY);
      return { x: area.minX + (area.maxX - area.minX) * x, y: top + (area.maxY - top) * y };
    };
    const readGeometry = () => ({
      width: desktop.clientWidth,
      height: desktop.clientHeight,
      sizes: new Map(panels.map((panel) => [panel, { width: panel.offsetWidth, height: panel.offsetHeight }])),
    });
    const rememberGeometry = (snapshot) => {
      width = snapshot.width;
      height = snapshot.height;
      measuredMobile = mobile.matches;
      snapshot.sizes.forEach((size, panel) => geometry.set(panel, size));
    };
    const isMoving = (panel) => {
      const animation = animations.get(panel);
      return animation?.playState === "running" || animation?.pending;
    };
    const currentPosition = (panel, surface) => {
      const position = positions.get(panel);
      if (!position || !isMoving(panel)) return position;
      const visual = panel.getBoundingClientRect();
      const origin = surface || desktop.getBoundingClientRect();
      return { x: visual.left - origin.left - desktop.clientLeft, y: visual.top - origin.top - desktop.clientTop };
    };
    const capturePositions = () => {
      const surface = panels.some(isMoving) ? desktop.getBoundingClientRect() : null;
      return new Map(panels.map((panel) => [panel, currentPosition(panel, surface)]));
    };
    const place = (panel, position, animate = false, previous = positions.get(panel)) => {
      animations.get(panel)?.cancel();
      positions.set(panel, position);
      panel.style.left = `${position.x}px`;
      panel.style.top = `${position.y}px`;
      panel.style.removeProperty("transform");
      if (animate && previous && !reduce.matches && panel.animate) animations.set(panel, panel.animate(
        [{ transform: `translate(${previous.x - position.x}px,${previous.y - position.y}px)` }, { transform: "translate(0,0)" }],
        { duration: 620, easing: ease },
      ));
    };
    const finishDrag = (commit) => {
      if (!drag) return;
      const active = drag;
      drag = null;
      place(active.panel, commit ? active.current : active.start);
      active.panel.classList.remove("is-dragging");
      desktop.classList.remove("is-dragging");
      if (active.handle.hasPointerCapture(active.pointerId)) active.handle.releasePointerCapture(active.pointerId);
    };
    const chooseLayout = (next, animate = true) => {
      if (!arrangements[next]) return;
      if (animate) entered = true;
      finishDrag(false);
      const previous = mobile.matches ? null : capturePositions();
      layout = next;
      desktop.dataset.layout = next;
      layoutButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.layout === next)));
      stacking = 20;
      if (!mobile.matches) {
        // Cache the new CSS widths before placement; its ResizeObserver echo is a no-op.
        rememberGeometry(readGeometry());
        panels.forEach((panel) => {
          panel.style.removeProperty("z-index");
          place(panel, defaultPosition(panel), animate, previous.get(panel));
        });
      }
    };
    const chooseMobile = (next) => {
      mobilePanel = next;
      desktop.dataset.mobilePanel = next;
      mobileButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.mobilePanel === next)));
      panels.forEach((panel) => {
        panel.hidden = mobile.matches && next !== "overview" && panel.dataset.panel !== next;
        panel.inert = panel.hidden;
      });
    };
    const measure = () => {
      chooseMobile(mobilePanel);
      const snapshot = readGeometry();
      const changed = measuredMobile !== mobile.matches || width !== snapshot.width || height !== snapshot.height || panels.some((panel) => {
        const previous = geometry.get(panel);
        const next = snapshot.sizes.get(panel);
        return !previous || previous.width !== next.width || previous.height !== next.height;
      });
      if (!changed) return;
      finishDrag(false);
      const previous = capturePositions();
      rememberGeometry(snapshot);
      panels.forEach((panel) => {
        animations.get(panel)?.cancel();
        const handle = panel.querySelector("[data-drag-handle]");
        if (handle) {
          handle.disabled = mobile.matches;
          handle.tabIndex = mobile.matches ? -1 : 0;
          handle.setAttribute("aria-disabled", String(mobile.matches));
          handle.style.touchAction = mobile.matches ? "auto" : "none";
        }
        if (mobile.matches) {
          panel.style.removeProperty("left");
          panel.style.removeProperty("top");
          panel.style.removeProperty("transform");
          panel.style.removeProperty("z-index");
          positions.delete(panel);
        } else {
          const position = previous.get(panel);
          place(panel, position ? constrained(panel, position.x, position.y) : defaultPosition(panel));
        }
      });
      desktop.classList.add("is-ready");
    };
    panels.forEach((panel, index) => {
      panel.style.setProperty("--panel-order", String(index));
      panel.addEventListener("focusin", () => {
        if (mobile.matches) return;
        entered = true;
        panel.style.zIndex = String(++stacking);
      });
      const handle = panel.querySelector("[data-drag-handle]");
      if (!handle) return;
      handle.addEventListener("pointerdown", (event) => {
        if (mobile.matches || event.button !== 0 || event.isPrimary === false) return;
        const control = event.target.closest("a,button,input,select");
        if (control && control !== handle) return;
        finishDrag(false);
        const position = currentPosition(panel);
        if (!position) return;
        const start = constrained(panel, position.x, position.y);
        place(panel, start);
        event.preventDefault();
        entered = true;
        handle.focus({ preventScroll: true });
        panel.style.zIndex = String(++stacking);
        drag = { panel, handle, pointerId: event.pointerId, x: event.clientX, y: event.clientY, start, current: start };
        panel.classList.add("is-dragging");
        desktop.classList.add("is-dragging");
        handle.setPointerCapture(event.pointerId);
      });
      handle.addEventListener("pointermove", (event) => {
        if (!drag || drag.handle !== handle || event.pointerId !== drag.pointerId) return;
        drag.current = constrained(panel, drag.start.x + event.clientX - drag.x, drag.start.y + event.clientY - drag.y);
        panel.style.transform = `translate3d(${drag.current.x - drag.start.x}px,${drag.current.y - drag.start.y}px,0)`;
      });
      handle.addEventListener("pointerup", (event) => {
        if (drag?.pointerId === event.pointerId) finishDrag(true);
      });
      handle.addEventListener("pointercancel", () => finishDrag(false));
      handle.addEventListener("lostpointercapture", () => finishDrag(false));
      handle.addEventListener("keydown", (event) => {
        if (mobile.matches) return;
        const step = event.shiftKey ? 30 : 10;
        const directions = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
        if (event.key !== "Home" && !directions[event.key]) return;
        const position = currentPosition(panel);
        if (!position) return;
        if (event.key === "Home") {
          event.preventDefault();
          entered = true;
          place(panel, defaultPosition(panel), true, position);
        } else if (directions[event.key]) {
          event.preventDefault();
          entered = true;
          const [x, y] = directions[event.key];
          panel.style.zIndex = String(++stacking);
          place(panel, constrained(panel, position.x + x, position.y + y));
        }
      });
    });
    layoutButtons.forEach((button) => button.addEventListener("click", () => chooseLayout(button.dataset.layout)));
    document.querySelector("[data-desktop-reset]")?.addEventListener("click", () => chooseLayout(layout));
    mobileButtons.forEach((button) => button.addEventListener("click", () => chooseMobile(button.dataset.mobilePanel)));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") finishDrag(false);
    });
    window.addEventListener("blur", () => finishDrag(false));
    mobile.addEventListener("change", measure);
    reduce.addEventListener("change", () => {
      if (reduce.matches) {
        entered = true;
        animations.forEach((animation) => animation.cancel());
      }
    });
    if ("ResizeObserver" in window) {
      const observer = new ResizeObserver(measure);
      observer.observe(desktop);
      panels.forEach((panel) => observer.observe(panel));
    } else window.addEventListener("resize", measure, { passive: true });
    measure();
    chooseLayout(layout, false);
    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver(([entry]) => {
        if (!entry.isIntersecting || entry.intersectionRatio < 0.2 || document.hidden) return;
        observer.disconnect();
        if (entered || reduce.matches || mobile.matches) return;
        entered = true;
        panels.forEach((panel, index) => {
          if (!panel.animate) return;
          animations.set(panel, panel.animate(
            [{ opacity: 0, transform: "translateY(20px) scale(.96)" }, { opacity: 1, transform: "translateY(0) scale(1)" }],
            { duration: 650, delay: index * 110, easing: ease, fill: "backwards" },
          ));
        });
      }, { threshold: [0, 0.2] });
      observer.observe(desktop);
    }
  }

  const reveals = [...document.querySelectorAll("[data-reveal]")];
  if (reduce.matches || !("IntersectionObserver" in window)) reveals.forEach((element) => element.classList.add("is-visible"));
  else {
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    }), { threshold: 0.15 });
    reveals.forEach((element) => observer.observe(element));
    reduce.addEventListener("change", () => {
      if (reduce.matches) {
        reveals.forEach((element) => element.classList.add("is-visible"));
        observer.disconnect();
      }
    });
  }
})();
