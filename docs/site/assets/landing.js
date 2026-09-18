/**
 * eNest 官网 — 零依赖交互
 * 导航 / 滚动显现 / 剧场场景 / 瀑布视差 / 主题演示 / 隔离轮换 / 壳子微动效
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
    initReveal();
    initRail();
    initWaterfall();
    initTheater();
    initThemeDemo();
    initIsoFocus();
    initHeroTabs();
  });

  function reduceMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /** 主题：默认跟随系统，可切换并记住 */
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

    document.querySelectorAll("[data-theme-toggle]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
        apply(next);
        try {
          localStorage.setItem("enest-site-theme", next);
        } catch (e) {}
      });
    });
  }

  /** 产品横滑：拖拽 + 滚轮横向 */
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
      options || { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
    );
    nodes.forEach(function (el) {
      io.observe(el);
    });
  }

  function initReveal() {
    observeOnce(document.querySelectorAll(".reveal"), "is-in");
    observeOnce(document.querySelectorAll(".rgb-split"), "is-in");
  }

  /** 瀑布帘幕：列速差视差 + 卡片错列落入 */
  function initWaterfall() {
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
      { rootMargin: "0px 0px -6% 0px", threshold: 0.12 }
    );
    cards.forEach(function (el) {
      io.observe(el);
    });

    var wrap = document.getElementById("waterfall-wrap");
    var cols = document.querySelectorAll(".wf-col[data-speed]");
    if (!wrap || !cols.length || window.innerWidth < 961) return;

    var ticking = false;
    var onScroll = function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(function () {
        var rect = wrap.getBoundingClientRect();
        var viewH = window.innerHeight || 1;
        var progress = 1 - (rect.top + rect.height) / (viewH + rect.height);
        progress = Math.max(0, Math.min(1, progress));
        cols.forEach(function (col, i) {
          var speed = Number(col.getAttribute("data-speed") || 0.15);
          var offset = (progress - 0.5) * speed * 220;
          col.style.setProperty("--wf-s" + (i + 1), offset.toFixed(1));
          col.style.transform = "translateY(" + offset.toFixed(1) + "px)";
        });
        ticking = false;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  /** 剧场：场景滚动驱动壳子舞台状态 */
  function initTheater() {
    var scenes = document.querySelectorAll(".band[data-scene], .scene[data-scene]");
    var tabs = document.querySelectorAll("[data-stage-tab]");
    var title = document.getElementById("stage-title");
    var status = document.getElementById("stage-status");
    var searchLabel = document.getElementById("stage-search-label");
    if (!scenes.length) return;

    var copy = [
      {
        title: "插件市场",
        status: "市场就绪",
        search: "搜索插件、作者、标签…",
        tab: 0
      },
      {
        title: "并行工作",
        status: "2 个 Tab 运行中",
        search: "切换到剪贴板 / JSON…",
        tab: 1
      },
      {
        title: "快捷启动",
        status: "⌥Space 小窗",
        search: "输入以搜索…",
        tab: 2
      },
      {
        title: "主题预览",
        status: "跟随系统",
        search: "切换深色 / 浅色…",
        tab: 0
      }
    ];

    function applyScene(idx) {
      var data = copy[idx] || copy[0];
      if (title) title.textContent = data.title;
      if (status) status.textContent = data.status;
      if (searchLabel) searchLabel.textContent = data.search;
      tabs.forEach(function (t) {
        t.classList.toggle("active", Number(t.getAttribute("data-stage-tab")) === data.tab);
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

  /** 主题 Token 演示 */
  function initThemeDemo() {
    var stage = document.getElementById("theme-stage");
    var buttons = document.querySelectorAll("[data-theme-btn]");
    if (!stage || !buttons.length) return;

    buttons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var mode = btn.getAttribute("data-theme-btn");
        stage.classList.toggle("dark", mode === "dark");
        buttons.forEach(function (b) {
          b.classList.toggle("on", b === btn);
        });

        var light = ["#f3f4f6", "#ffffff", "#1a1f2e", "#0d9f6e"];
        var dark = ["#0d1118", "#161b24", "#e8ecf4", "#3dd68c"];
        var colors = mode === "dark" ? dark : light;
        var swatches = stage.querySelectorAll(".swatch");
        swatches.forEach(function (s, i) {
          if (!colors[i]) return;
          s.style.background = colors[i];
          s.style.color =
            i < 2 ? (mode === "dark" ? "#f3f5f9" : "#0f1420") : mode === "dark" ? "#0d1118" : "#fff";
        });
      });
    });
  }

  /** 隔离四宫格：焦点轮换 */
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

  /** 壳子仿真：Tab 轮换高亮 */
  function initHeroTabs() {
    var windowEl = document.getElementById("hero-app");
    if (!windowEl) return;
    if (reduceMotion()) return;

    var tabs = windowEl.querySelectorAll(".app-tab");
    if (tabs.length < 2) return;

    var idx = 0;
    window.setInterval(function () {
      idx = (idx + 1) % tabs.length;
      tabs.forEach(function (t, i) {
        t.classList.toggle("active", i === idx);
      });
    }, 3200);
  }
})();
