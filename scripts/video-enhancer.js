// ========== SNH48 Live Enhancer - Video Enhancer ==========
(function () {
  "use strict";

  var SNH48 = window.SNH48 || (window.SNH48 = {});
  const log = SNH48.log;
  const warn = SNH48.warn;
  const error = SNH48.error;
  const showToast = SNH48.showToast;
  const isExtensionContextAlive = SNH48.isExtensionContextAlive;
  const safeStorageSet = SNH48.safeStorageSet;
  const _extSetTimeout = SNH48._extSetTimeout;
  const _extSetInterval = SNH48._extSetInterval;

  const formatTime = (seconds) => {
    seconds = Math.floor(seconds || 0);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  };

  // ---- Shadow DOM video 元素缓存 ----
  let _cachedVideoEl = null;
  let _videoCacheValid = false;

  function getVideoElement() {
    if (_videoCacheValid && _cachedVideoEl && _cachedVideoEl.isConnected) {
      return _cachedVideoEl;
    }

    // Try simple query first
    let video = document.querySelector("video");
    if (video) {
      _cachedVideoEl = video;
      _videoCacheValid = true;
      return video;
    }

    // Only search Shadow DOM if simple query fails
    const allEls = document.querySelectorAll("*");
    for (const el of allEls) {
      if (el.shadowRoot) {
        video = el.shadowRoot.querySelector("video");
        if (video) {
          _cachedVideoEl = video;
          _videoCacheValid = true;
          return video;
        }
      }
    }

    return null;
  }

  // Invalidate cache on significant DOM changes
  if (typeof MutationObserver !== "undefined") {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "childList" && m.addedNodes.length > 0) {
          for (const node of m.addedNodes) {
            if (node.nodeName === "VIDEO" || node.querySelector?.("video")) {
              _videoCacheValid = false;
              return;
            }
          }
        }
      }
    });
    // Observe after DOM is ready
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  }

  const adjustVolume = (delta) => {
    const video = getVideoElement();
    if (!video) return;
    video.volume = Math.max(0, Math.min(1, video.volume + delta));
    showToast("🔊 " + Math.round(video.volume * 100) + "%");
  };

  const seekRelative = (seconds) => {
    const video = getVideoElement();
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(video.duration || 1e10, video.currentTime + seconds));
    showToast(seconds > 0 ? "⏩ +" + seconds + "s" : "⏪ " + seconds + "s");
  };

  const toggleMute = () => {
    const video = getVideoElement();
    if (!video) return;
    video.muted = !video.muted;
    showToast(video.muted ? "🔇 已静音" : "🔊 取消静音");
  };

  const resetPlaybackRate = () => {
    const video = getVideoElement();
    if (!video) return;
    video.playbackRate = 1;
    showToast("⚡ 1x");
  };

  const setupVideoShortcuts = () => {
    const config = SNH48.config;
    if (!config.videoShortcuts) {
      log("视频快捷键已禁用");
      return;
    }
    log("视频快捷键已启用");

    const bindings = config.shortcutBindings || SNH48_DEFAULT_CONFIG.shortcutBindings;
    const keyActionMap = {};
    for (const [action, key] of Object.entries(bindings)) {
      keyActionMap[key] = action;
    }

    document.addEventListener("keydown", (e) => {
      const tag = e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;

      let video = getVideoElement();

      // Space for play/pause (always hardcoded)
      if (e.key === " ") {
        if (video) {
          e.preventDefault();
          e.stopPropagation();
          if (video.paused) {
            video.play().catch(() => {});
            showToast("▶ 播放");
          } else {
            video.pause();
            showToast("⏸ 暂停");
          }
        }
        return;
      }

      // Number keys 1-9 for seek-to-percentage (always hardcoded)
      if (e.key >= "1" && e.key <= "9") {
        if (video && video.duration) {
          e.preventDefault();
          const percent = parseInt(e.key) / 10;
          video.currentTime = video.duration * percent;
          showToast("⏱ 跳到 " + (percent * 100) + "%");
        }
        return;
      }

      // Configurable shortcuts via keyActionMap
      const action = keyActionMap[e.key];
      if (!action) return;
      if (!video && action !== "fullscreen") return;

      switch (action) {
        case "speedUp":
          e.preventDefault();
          changePlaybackRate(0.25);
          break;
        case "speedDown":
          e.preventDefault();
          changePlaybackRate(-0.25);
          break;
        case "speedReset":
          e.preventDefault();
          resetPlaybackRate();
          break;
        case "screenshot":
          if (e.ctrlKey || e.metaKey) return;
          if (SNH48.config.screenshotEnabled) {
            e.preventDefault();
            takeScreenshot();
          }
          break;
        case "pip":
          e.preventDefault();
          togglePictureInPicture();
          break;
        case "fullscreen":
          e.preventDefault();
          toggleFullScreen();
          break;
        case "volumeUp":
          e.preventDefault();
          adjustVolume(0.05);
          break;
        case "volumeDown":
          e.preventDefault();
          adjustVolume(-0.05);
          break;
        case "mute":
          e.preventDefault();
          toggleMute();
          break;
        case "seekForward":
          e.preventDefault();
          seekRelative(5);
          break;
        case "seekBackward":
          e.preventDefault();
          seekRelative(-5);
          break;
      }
    }, true);
  };

  // ---- 视频播放进度记忆 ----
  const PROGRESS_STORAGE_KEY = "snh48_video_progress";
  const PROGRESS_MAX_ENTRIES = 100;
  const PROGRESS_SAVE_INTERVAL = 10000;
  const PROGRESS_MIN_TIME = 5;

  const findVideoElement = getVideoElement;

  const saveVideoProgress = () => {
    const video = findVideoElement();
    if (!video) return;
    const ct = video.currentTime;
    const dur = video.duration;
    if (!dur || isNaN(dur)) return;
    const url = window.location.href;

    if (dur - ct < 10) {
      removeVideoProgress(url);
      return;
    }

    if (ct < PROGRESS_MIN_TIME) return;

    readVideoProgressAll((all) => {
      if (!all) all = {};
      all[url] = { time: ct, ts: Date.now(), duration: dur };

      const keys = Object.keys(all);
      if (keys.length > PROGRESS_MAX_ENTRIES) {
        keys.sort((a, b) => (all[a].ts || 0) - (all[b].ts || 0));
        while (keys.length > PROGRESS_MAX_ENTRIES) {
          const oldKey = keys.shift();
          delete all[oldKey];
        }
      }

      const data = {};
      data[PROGRESS_STORAGE_KEY] = all;
      safeStorageSet(data, () => {});
    });
  };

  const removeVideoProgress = (url) => {
    readVideoProgressAll((all) => {
      if (!all || !all[url]) return;
      delete all[url];
      const data = {};
      data[PROGRESS_STORAGE_KEY] = all;
      safeStorageSet(data, () => {});
    });
  };

  const readVideoProgressAll = (callback) => {
    if (!isExtensionContextAlive()) { callback({}); return; }
    try {
      chrome.storage.local.get(PROGRESS_STORAGE_KEY, (data) => {
        if (chrome.runtime.lastError) {
          callback({});
          return;
        }
        callback(data[PROGRESS_STORAGE_KEY] || {});
      });
    } catch (e) {
      callback({});
    }
  };

  const setupVideoProgressMemory = () => {
    log("视频进度记忆已启用");

    const waitForVideo = (attempts) => {
      if (attempts <= 0) return;
      const video = findVideoElement();
      if (video) {
        onVideoFound(video);
      } else {
        _extSetTimeout(() => { waitForVideo(attempts - 1); }, 1000);
      }
    };

    const onVideoFound = (video) => {
      const url = window.location.href;
      readVideoProgressAll((all) => {
        const entry = all[url];
        if (entry && entry.time > PROGRESS_MIN_TIME) {
          const doSeek = () => {
            if (video.duration && entry.time < video.duration - 5) {
              video.currentTime = entry.time;
              showToast("⏱ 已跳转到 " + formatTime(entry.time));
            }
          };
          if (video.readyState >= 1) {
            doSeek();
          } else {
            video.addEventListener("loadedmetadata", doSeek, { once: true });
          }
        }
      });

      _extSetInterval(() => {
        saveVideoProgress();
      }, PROGRESS_SAVE_INTERVAL);

      video.addEventListener("ended", () => {
        removeVideoProgress(url);
      });
    };

    waitForVideo(30);
  };

  const toggleFullScreen = () => {
    const player = document.querySelector(".videoplay") || getVideoElement();
    if (!player) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      (player.requestFullscreen || player.webkitRequestFullscreen).call(player)
        .catch((e) => {
          warn("全屏请求失败:", e);
          showToast("全屏不可用");
        });
    }
  };

  const togglePictureInPicture = () => {
    const video = getVideoElement();
    if (!video) return;
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture();
      showToast("退出画中画");
    } else {
      video.requestPictureInPicture()
        .then(() => {
          showToast("📺 画中画已开启");
        })
        .catch((e) => {
          warn("画中画失败:", e);
          showToast("画中画不可用");
        });
    }
  };

  const changePlaybackRate = (delta) => {
    const video = getVideoElement();
    if (!video) return;
    const newRate = Math.max(0.25, Math.min(4, (video.playbackRate || 1) + delta));
    video.playbackRate = newRate;
    showToast("⚡ " + newRate + "x");
  };

  const takeScreenshot = () => {
    const video = getVideoElement();
    if (!video) {
      showToast("未找到视频");
      return;
    }
    log("正在截图...");

    // Try to enable CORS for screenshot support
    if (video && !video.crossOrigin) {
      try {
        video.crossOrigin = "anonymous";
        // Need to reload the video source for crossOrigin to take effect
        // This won't work for already-playing videos, but helps for future attempts
      } catch (e) {}
    }

    // Check for potential CORS issue
    try {
      const videoSrc = video.src || video.currentSrc;
      if (videoSrc && new URL(videoSrc, window.location.href).origin !== window.location.origin) {
        // Cross-origin video - screenshot may fail
        // Try anyway, but warn user
      }
    } catch (e) {}

    try {
      const flash = document.createElement("div");
      flash.className = "snh48-screenshot-flash";
      document.body.appendChild(flash);
      requestAnimationFrame(() => {
        flash.classList.add("active");
      });
      setTimeout(() => {
        flash.classList.remove("active");
        setTimeout(() => { flash.remove(); }, 200);
      }, 120);

      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0);

      canvas.toBlob((blob) => {
        if (!blob) {
          error("截图 blob 生成失败");
          showToast("截图失败");
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const d = new Date();
        const ts =
          d.getFullYear() +
          ("0" + (d.getMonth() + 1)).slice(-2) +
          ("0" + d.getDate()).slice(-2) + "_" +
          ("0" + d.getHours()).slice(-2) +
          ("0" + d.getMinutes()).slice(-2) +
          ("0" + d.getSeconds()).slice(-2);
        a.download = "SNH48_" + ts + ".png";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast("📸 截图已保存");
      }, "image/png");
    } catch (e) {
      error("截图异常:", e);
      if (e.name === "SecurityError" || (e.message && e.message.includes("tainted"))) {
        showToast("截图失败：视频源存在跨域限制，无法截图");
      } else {
        showToast("截图失败：" + (e.message || "未知错误"));
      }
    }
  };

  SNH48.setupVideoShortcuts = setupVideoShortcuts;
  SNH48.setupVideoProgressMemory = setupVideoProgressMemory;
})();
