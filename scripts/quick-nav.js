// ========== SNH48 Live Enhancer - Quick Navigation ==========
(function () {
  "use strict";

  var SNH48 = window.SNH48 || (window.SNH48 = {});
  const log = SNH48.log;

  const createQuickNav = () => {
    const config = SNH48.config;
    if (!config.quickNav) return;
    if (document.querySelector(".snh48-quick-nav")) return;

    log("创建快捷导航");

    const groups = [
      { name: "首页", url: "https://live.48.cn/", pattern: /^https:\/\/live\.48\.cn\/?(\?.*)?$/ },
      { name: "SNH48", url: "https://live.48.cn/Index/main/club/1", pattern: /\/club\/1/ },
      { name: "BEJ48", url: "https://live.48.cn/Index/main/club/2", pattern: /\/club\/2/ },
      { name: "GNZ48", url: "https://live.48.cn/Index/main/club/3", pattern: /\/club\/3/ },
      { name: "CKG48", url: "https://live.48.cn/Index/main/club/5", pattern: /\/club\/5/ },
      { name: "CGT48", url: "https://live.48.cn/Index/main/club/6", pattern: /\/club\/6/ },
    ];

    const nav = document.createElement("div");
    nav.className = "snh48-quick-nav";

    const currentUrl = window.location.href;
    groups.forEach((g) => {
      const item = document.createElement("a");
      item.className = "snh48-nav-item";
      item.href = g.url;
      item.textContent = g.name;
      if (g.pattern.test(currentUrl)) item.classList.add("active");
      nav.appendChild(item);
    });

    document.body.appendChild(nav);

    let hideTimer = null;
    const showNav = () => {
      nav.classList.remove("hidden");
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        nav.classList.add("hidden");
      }, 4000);
    };
    document.addEventListener("mousemove", showNav);
    showNav();
  };

  SNH48.createQuickNav = createQuickNav;
})();
