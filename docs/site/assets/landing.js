/**
 * eNest 官网 — 零依赖交互
 * 导航 / 滚动显现 / 瀑布流入场 / 主题演示 / 隔离焦点轮换 / 壳子 Tab 微动效
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
    initNav();
    initReveal();
    initWaterfall();
    initThemeDemo();
    initIsoFocus();
    initHeroTabs();
  });

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
  }

  /** 瀑布流：按列交错延迟入场，模拟下落 */
  function initWaterfall() {
    var cards = document.querySelectorAll(".wf-card");
    if (!cards.length) return;

    if (!("IntersectionObserver" in window)) {
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
  }

  /** 主题 Token 演示：浅/深切换 swatch 与 chip */
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

        // 同步 swatch 色板，贴近 tokens.css
        var light = ["#f3f4f6", "#ffffff", "#1a1f2e", "#0d9f6e"];
        var dark = ["#0d1118", "#161b24", "#e8ecf4", "#3dd68c"];
        var colors = mode === "dark" ? dark : light;
        var swatches = stage.querySelectorAll(".swatch");
        swatches.forEach(function (s, i) {
          if (!colors[i]) return;
          s.style.background = colors[i];
          s.style.color = i >= 2 && mode !== "dark" ? "#fff" : mode === "dark" && i < 2 ? "#f3f5f9" : i < 2 ? "#0f1420" : "#0d1118";
        });
      });
    });
  }

  /** 隔离四宫格：焦点轮换，强调「各玩各的」 */
  function initIsoFocus() {
    var cells = document.querySelectorAll(".iso-cell");
    if (cells.length < 2) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    var i = 0;
    window.setInterval(function () {
      cells.forEach(function (c) {
        c.classList.remove("is-focus");
      });
      i = (i + 1) % cells.length;
      cells[i].classList.add("is-focus");
    }, 2200);
  }

  /** 壳子仿真：Tab 轮换高亮 + 卡片轻微浮动 */
  function initHeroTabs() {
    var windowEl = document.getElementById("hero-app");
    if (!windowEl) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

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
