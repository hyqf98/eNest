/**
 * eNest 官网 — 零依赖交互
 * 导航 / Hero 编排（fonts.ready 门控逐行揭示）/ 光标聚光 / 磁性 CTA /
 * 滚动揭示双轨（IO + view-timeline）/ 剧场场景 FLIP / VT 主题切换 / 壳子微动效
 * 动效原则：只动 transform / opacity / 颜色；reduced-motion 一律跳终态。
 */
(function () {
  "use strict";

  function ready(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn);
    } else {
      fn();
    }
  }

  ready(function () {
    initTheme();
    initNav();
    initHeroIntro();
    initSpotlight();
    initMagnetic();
    initReveal();
    initRail();
    initWaterfallCards();
    initTheater();
    initIsoFocus();
    initHeroTabs();
  });

  function reduceMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function finePointer() {
    return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  }

  /* ——— 主题：默认跟随系统；切换走 View Transition 圆形扩散 ——— */
  function initTheme() {
    var root = document.documentElement;
    var stored = null;
    try {
      stored = localStorage.getItem("enest-site-theme");
    } catch (e) {}

    function systemTheme() {
      return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }

    function apply(theme) {
      root.setAttribute("data-theme", theme);
    }

    apply(stored === "light" || stored === "dark" ? stored : systemTheme());

    try {
      window
        .matchMedia("(prefers-color-scheme: light)")
        .addEventListener("change", function (e) {
          var cur = null;
          try {
            cur = localStorage.getItem("enest-site-theme");
          } catch (err) {}
          if (cur !== "light" && cur !== "dark") {
            apply(e.matches ? "light" : "dark");
          }
        });
    } catch (e) {}

    /** VT 扩散：clip-path circle 从点击坐标扩到最远角；不支持/reduced-motion 瞬切 */
    function applyWithReveal(theme, x, y) {
      var canVT =
        document.startViewTransition &&
        !reduceMotion() &&
        typeof CSS !== "undefined" &&
        CSS.supports &&
        CSS.supports("view-transition-name: root");

      if (!canVT) {
        apply(theme);
        return;
      }

      var r = Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y)
      );

      var transition = document.startViewTransition(function () {
        apply(theme);
      });

      transition.ready.then(function () {
        root.classList.add("is-vt-expanding");
        root.style.setProperty("--vt-x", x + "px");
        root.style.setProperty("--vt-y", y + "px");
        root.style.setProperty("--vt-r", r + "px");
      });
      transition.finished.finally(function () {
        root.classList.remove("is-vt-expanding");
        root.style.removeProperty("--vt-x");
        root.style.removeProperty("--vt-y");
        root.style.removeProperty("--vt-r");
      });
    }

    document.querySelectorAll("[data-theme-toggle]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
        var rect = btn.getBoundingClientRect();
        var x = e.clientX || rect.left + rect.width / 2;
        var y = e.clientY || rect.top + rect.height / 2;
        applyWithReveal(next, x, y);
        try {
          localStorage.setItem("enest-site-theme", next);
        } catch (err) {}
      });
    });
  }

  /* ——— Hero 编排：fonts.ready 后逐行揭示（中文渲染关键），整条时间线 ≤1.6s ———
     CSS 掩码 + transition-delay 承担 stagger；JS 只做 armed→played 两拍切换。
     reduced-motion：CSS 闸门已保证终态，直接跳过。 */
  function initHeroIntro() {
    var hero = document.getElementById("hero");
    if (!hero) return;
    if (reduceMotion()) return;

    hero.classList.add("is-armed"); // 进入待播态：行沉底、fade 元素隐身

    var play = function () {
      // 双 rAF：确保浏览器先把 armed 的起始态渲染出来再播放
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          hero.classList.add("is-played");
        });
      });
    };

    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(play);
      // 兜底：字体加载异常时 800ms 内强制开播
      window.setTimeout(play, 800);
    } else {
      play();
    }
  }

  /* ——— 光标聚光：rAF + lerp 把 --mx/--my 写进 hero，CSS 出 600px 品牌色光束 ——— */
  function initSpotlight() {
    var hero = document.getElementById("hero");
    if (!hero) return;
    if (reduceMotion() || !finePointer()) return;

    var tx = 0, ty = 0, cx = 0, cy = 0, started = false, rafId = 0;

    function tick() {
      cx += (tx - cx) * 0.1;
      cy += (ty - cy) * 0.1;
      hero.style.setProperty("--mx", cx.toFixed(1) + "px");
      hero.style.setProperty("--my", cy.toFixed(1) + "px");
      if (Math.abs(tx - cx) < 0.5 && Math.abs(ty - cy) < 0.5) {
        started = false;
        return; // 收敛即停帧，pointermove 再唤醒
      }
      rafId = requestAnimationFrame(tick);
    }

    hero.addEventListener("pointermove", function (e) {
      var rect = hero.getBoundingClientRect();
      tx = e.clientX - rect.left;
      ty = e.clientY - rect.top;
      if (!started) {
        started = true;
        hero.classList.add("is-spotlit");
        rafId = requestAnimationFrame(tick);
      }
    });
    hero.addEventListener("pointerleave", function () {
      hero.classList.remove("is-spotlit");
    });
  }

  /* ——— 磁性主 CTA：仅 hero 主按钮；位移 ≤ 尺寸 25%，rAF lerp 0.1 ——— */
  function initMagnetic() {
    if (reduceMotion() || !finePointer()) return;

    document.querySelectorAll(".btn-magnetic").forEach(function (btn) {
      var tx = 0, ty = 0, ox = 0, oy = 0, running = false;

      function tick() {
        ox += (tx - ox) * 0.1;
        oy += (ty - oy) * 0.1;
        btn.style.transform =
          "translate3d(" + ox.toFixed(2) + "px," + oy.toFixed(2) + "px,0)";
        if (Math.abs(tx - ox) < 0.1 && Math.abs(ty - oy) < 0.1) {
          running = false;
          return;
        }
        requestAnimationFrame(tick);
      }

      function wake() {
        if (!running) {
          running = true;
          requestAnimationFrame(tick);
        }
      }

      btn.addEventListener("pointermove", function (e) {
        var rect = btn.getBoundingClientRect();
        var bx = rect.left + rect.width / 2;
        var by = rect.top + rect.height / 2;
        var dx = e.clientX - bx;
        var dy = e.clientY - by;
        var limit = Math.min(rect.width, rect.height) * 0.25;
        var len = Math.hypot(dx, dy) || 1;
        var clamped = Math.min(len, limit);
        tx = (dx / len) * clamped;
        ty = (dy / len) * clamped;
        wake();
      });
      btn.addEventListener("pointerleave", function () {
        tx = 0;
        ty = 0;
        wake();
      });
    });
  }

  /* ——— 一次性滚动揭示：IO threshold 0.15，触发即 unobserve ——— */
  function observeOnce(nodes, className, options) {
    if (!nodes.length) return;
    if (!("IntersectionObserver" in window)) {
      nodes.forEach(function (el) {
        el.classList.add(className);
      });
      return;
    }
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add(className);
            io.unobserve(entry.target);
          }
        });
      },
      options || { threshold: 0.15 }
    );
    nodes.forEach(function (el) {
      io.observe(el);
    });
  }

  function initReveal() {
    observeOnce(document.querySelectorAll(".reveal"), "is-in");
  }

  /* ——— 产品横滑：拖拽 + 滚轮横向 ——— */
  function initRail() {
    var rail = document.getElementById("rail");
    if (!rail) return;

    var down = false;
    var startX = 0;
    var scrollLeft = 0;

    rail.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      down = true;
      rail.classList.add("is-dragging");
      startX = e.clientX;
      scrollLeft = rail.scrollLeft;
      try {
        rail.setPointerCapture(e.pointerId);
      } catch (err) {}
    });
    rail.addEventListener("pointermove", function (e) {
      if (!down) return;
      var dx = e.clientX - startX;
      rail.scrollLeft = scrollLeft - dx;
    });
    function endDrag() {
      down = false;
      rail.classList.remove("is-dragging");
    }
    rail.addEventListener("pointerup", endDrag);
    rail.addEventListener("pointercancel", endDrag);
    rail.addEventListener("pointerleave", function () {
      if (down) endDrag();
    });
    rail.addEventListener(
      "wheel",
      function (e) {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          rail.scrollLeft += e.deltaY;
          e.preventDefault();
        }
      },
      { passive: false }
    );
  }

  function initNav() {
    var nav = document.querySelector(".site-nav");
    if (!nav) return;

    var onScroll = function () {
      nav.classList.toggle("is-scrolled", window.scrollY > 8);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    var toggle = nav.querySelector(".nav-toggle");
    if (!toggle) return;
    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    nav.querySelectorAll(".nav-links a").forEach(function (link) {
      link.addEventListener("click", function () {
        nav.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  /* ——— 瀑布卡片：错列落入（旧列视差已删） ——— */
  function initWaterfallCards() {
    var cards = document.querySelectorAll(".wf-card");
    if (!cards.length) return;

    if (!("IntersectionObserver" in window) || reduceMotion()) {
      cards.forEach(function (el) {
        el.classList.add("is-in");
      });
      return;
    }

    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var el = entry.target;
          var delay = Number(el.getAttribute("data-delay") || 0);
          window.setTimeout(function () {
            el.classList.add("is-in");
          }, delay);
          io.unobserve(el);
        });
      },
      { threshold: 0.15 }
    );
    cards.forEach(function (el) {
      io.observe(el);
    });
  }

  /* ——— 剧场：场景滚动驱动舞台（tab 内容切换走 FLIP：First→Last→Invert→Play） ——— */
  function initTheater() {
    var scenes = document.querySelectorAll(".band[data-scene], .scene[data-scene]");
    var tabs = document.querySelectorAll("[data-stage-tab]");
    var title = document.getElementById("stage-title");
    var status = document.getElementById("stage-status");
    var searchLabel = document.getElementById("stage-search-label");
    if (!scenes.length) return;

    var copy = [
      { title: "插件市场", status: "市场就绪", search: "搜索插件、作者、标签…", tab: 0 },
      { title: "并行工作", status: "2 个 Tab 运行中", search: "切换到剪贴板 / JSON…", tab: 1 },
      { title: "快捷启动", status: "⌥Space 小窗", search: "输入以搜索…", tab: 2 },
      { title: "主题预览", status: "跟随系统", search: "切换深色 / 浅色…", tab: 0 }
    ];

    var FLIP_EASE = "cubic-bezier(.2,.8,.2,1)";

    /** 对舞台内文字节点做 FLIP：First 记 rect → Last 改文案 → Invert 反演 → Play。
        等位切换（rect 不变）退化为恒定 y:16 fade 入场，保证每次切换都有可感反馈。 */
    function flipSwap(mutate) {
      var stage = document.getElementById("stage-app");
      if (!stage || reduceMotion() || !stage.animate) {
        mutate();
        return;
      }

      // First：记录将变文案的元素当前位置
      var targets = [];
      if (title) targets.push(title);
      if (status) targets.push(status);
      if (searchLabel) targets.push(searchLabel);
      var first = targets.map(function (el) {
        return el.getBoundingClientRect();
      });

      // Last：切换内容
      mutate();

      // Invert + Play：位置有变则反演 transform；无变化则走 16px 入场
      targets.forEach(function (el, i) {
        var last = el.getBoundingClientRect();
        var dx = first[i].left - last.left;
        var dy = first[i].top - last.top;
        var sx = first[i].width / (last.width || 1);
        var fromTransform;
        var fromOpacity;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || Math.abs(sx - 1) > 0.01) {
          fromTransform = "translate3d(" + dx + "px," + dy + "px,0) scale(" + sx + ")";
          fromOpacity = 0.4;
        } else {
          fromTransform = "translate3d(0,16px,0)";
          fromOpacity = 0;
        }
        el.animate(
          [
            { transform: fromTransform, opacity: fromOpacity },
            { transform: "translate3d(0,0,0) scale(1)", opacity: 1 }
          ],
          {
            duration: 350,
            delay: i * 45, // 内容卡片 stagger 30-60ms
            easing: FLIP_EASE,
            fill: "backwards" // delay 期间保持起始帧
          }
        );
      });
    }

    function applyScene(idx) {
      var data = copy[idx] || copy[0];
      flipSwap(function () {
        if (title) title.textContent = data.title;
        if (status) status.textContent = data.status;
        if (searchLabel) searchLabel.textContent = data.search;
        tabs.forEach(function (t) {
          t.classList.toggle("active", Number(t.getAttribute("data-stage-tab")) === data.tab);
        });
      });
      scenes.forEach(function (s) {
        s.classList.toggle("is-on", Number(s.getAttribute("data-scene")) === idx);
      });
    }

    if (!("IntersectionObserver" in window)) {
      applyScene(0);
      return;
    }

    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var idx = Number(entry.target.getAttribute("data-scene") || 0);
          applyScene(idx);
        });
      },
      { root: null, rootMargin: "-35% 0px -45% 0px", threshold: 0 }
    );
    scenes.forEach(function (s) {
      io.observe(s);
    });
    applyScene(0);
  }

  /* ——— 隔离四宫格：焦点轮换 ——— */
  function initIsoFocus() {
    var cells = document.querySelectorAll(".iso-cell");
    if (cells.length < 2) return;
    if (reduceMotion()) return;

    var i = 0;
    window.setInterval(function () {
      cells.forEach(function (c) {
        c.classList.remove("is-focus");
      });
      i = (i + 1) % cells.length;
      cells[i].classList.add("is-focus");
    }, 2200);
  }

  /* ——— 壳子仿真：Hero Tab 轮换高亮（触达即停，避免注意力干扰） ——— */
  function initHeroTabs() {
    var windowEl = document.getElementById("hero-app");
    if (!windowEl) return;
    if (reduceMotion()) return;

    var tabs = windowEl.querySelectorAll(".app-tab");
    if (tabs.length < 2) return;

    var idx = 0;
    var stopped = false;
    window.setInterval(function () {
      if (stopped) return;
      idx = (idx + 1) % tabs.length;
      tabs.forEach(function (t, i) {
        t.classList.toggle("active", i === idx);
      });
    }, 3200);
    // 用户视线离开 hero 后停止轮换
    window.addEventListener(
      "scroll",
      function () {
        if (!stopped && window.scrollY > window.innerHeight) stopped = true;
      },
      { passive: true }
    );
  }
})();
