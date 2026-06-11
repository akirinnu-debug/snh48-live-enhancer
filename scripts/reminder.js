// ========== SNH48 Live Enhancer - Performance Reminder ==========
(function () {
  "use strict";

  var SNH48 = window.SNH48 || (window.SNH48 = {});
  const log = SNH48.log;
  const error = SNH48.error;
  const warn = SNH48.warn;

  const setupReminder = () => {
    const config = SNH48.config;
    if (!config.reminderEnabled) return;

    log("公演提醒已启用");

    const checkReminders = () => {
      try {
        const now = new Date();
        const items = document.querySelectorAll(".starts");
        items.forEach((item) => {
          const timeEl = item.querySelector(".starttime");
          const nameEl = item.querySelector("p");
          if (!timeEl || !nameEl) return;

          const timeText = timeEl.textContent.trim();
          const name = nameEl.textContent.trim();
          const match = timeText.match(/(\d+)日\s*(\d+):(\d+)/);
          if (!match) return;

          const day = parseInt(match[1]);
          const hour = parseInt(match[2]);
          const minute = parseInt(match[3]);
          let perfDate = new Date(now.getFullYear(), now.getMonth(), day, hour, minute);
          if (perfDate < now) perfDate.setMonth(perfDate.getMonth() + 1);

          const diff = perfDate - now;
          const minutesLeft = Math.floor(diff / 60000);
          if (minutesLeft > 0 && minutesLeft <= config.reminderMinutesBefore) {
            showReminder(name, minutesLeft, timeText);
          }
        });
      } catch (e) {
        error("checkReminders 异常:", e);
      }
    };

    const showReminder = (name, minutesLeft, timeText) => {
      const popupId = "snh48-reminder";
      if (document.getElementById(popupId)) return;

      const popup = document.createElement("div");
      popup.id = popupId;
      popup.className = "snh48-reminder-popup";
      popup.innerHTML =
        '<div class="snh48-reminder-header">' +
          '<span>🔔 公演即将开始</span>' +
          '<span class="snh48-reminder-close">&times;</span>' +
        '</div>' +
        '<div class="snh48-reminder-body">' +
          '<div class="snh48-reminder-title">' + name + '</div>' +
          '<div class="snh48-reminder-time">⏰ ' + minutesLeft + ' 分钟后开始 · ' + timeText + '</div>' +
        '</div>';

      popup.querySelector(".snh48-reminder-close").addEventListener("click", () => {
        popup.remove();
      });

      document.body.appendChild(popup);

      try {
        if (Notification.permission === "granted") {
          new Notification("SNH48 公演提醒", {
            body: name + " " + minutesLeft + " 分钟后开始",
          });
        }
      } catch (e) {
        warn("通知异常:", e);
      }

      setTimeout(() => { if (popup.parentNode) popup.remove(); }, 15000);
    };

    if (Notification.permission === "default") {
      try { Notification.requestPermission(); } catch (e) { /* ignore */ }
    }

    setInterval(checkReminders, 60000);
    checkReminders();
  };

  SNH48.setupReminder = setupReminder;
})();
