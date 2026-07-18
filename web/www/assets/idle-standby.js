(() => {
  // Only control standby from the Chromium kiosk running on the Pi. A browser
  // opened on another device must not put the physical display to sleep.
  if (!["127.0.0.1", "localhost"].includes(window.location.hostname)) {
    return;
  }

  const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
  const CHECK_INTERVAL_MS = 15 * 1000;
  const SLIDE_INTERVAL_MS = 60 * 1000;
  const INACTIVE_PLAYBACK_STATES = new Set(["stopped", "paused", "ready"]);

  let lastActivity = Date.now();
  let isStandby = false;
  let requestId = 0;
  let slideTimer = null;
  let slideIndex = 0;
  let albumArt = [];
  let artLayer = null;
  let clockLayer = null;

  async function rpc(method, params) {
    const payload = {
      jsonrpc: "2.0",
      method,
      id: ++requestId,
    };
    if (params !== undefined) {
      payload.params = params;
    }

    const response = await fetch("/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`RPC ${method} failed with HTTP ${response.status}`);
    }

    const body = await response.json();
    if (body.error) {
      throw new Error(body.error.message);
    }
    return body.result;
  }

  function ensureStyles() {
    if (document.getElementById("ba-idle-art-styles")) {
      return;
    }
    const style = document.createElement("style");
    style.id = "ba-idle-art-styles";
    style.textContent = `
      #ba-idle-art-layer {
        position: fixed;
        inset: 0;
        z-index: 99990;
        background: #000;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.8s ease;
      }
      #ba-idle-art-layer.visible {
        opacity: 1;
      }
      #ba-idle-art-layer .ba-idle-slide {
        position: absolute;
        inset: 0;
        background-position: center;
        background-size: cover;
        background-repeat: no-repeat;
        opacity: 0;
        transition: opacity 1s ease;
      }
      #ba-idle-art-layer .ba-idle-slide.active {
        opacity: 1;
      }
      #ba-idle-clock-layer {
        position: fixed;
        inset: 0;
        z-index: 99991;
        display: none;
        align-items: center;
        justify-content: center;
        pointer-events: none;
      }
      #ba-idle-clock-layer.visible {
        display: flex;
      }
      #ba-idle-clock-box {
        background: rgba(0, 0, 0, 0.7);
        border-radius: 28px;
        padding: 36px 56px;
        text-align: center;
        color: #fff;
        font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
      }
      #ba-idle-clock-time {
        font-size: clamp(64px, 12vw, 120px);
        font-weight: 300;
        letter-spacing: 0.04em;
        line-height: 1;
        margin: 0;
      }
      #ba-idle-clock-date {
        font-size: clamp(18px, 3vw, 28px);
        font-weight: 400;
        opacity: 0.9;
        margin: 16px 0 0;
        letter-spacing: 0.06em;
      }
    `;
    document.head.appendChild(style);
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function formatClock(date) {
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const dateStr = date.toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    return { time, dateStr };
  }

  function updateClockText() {
    if (!clockLayer) {
      return;
    }
    const { time, dateStr } = formatClock(new Date());
    const timeEl = clockLayer.querySelector("#ba-idle-clock-time");
    const dateEl = clockLayer.querySelector("#ba-idle-clock-date");
    if (timeEl) {
      timeEl.textContent = time;
    }
    if (dateEl) {
      dateEl.textContent = dateStr;
    }
  }

  function showClockOverlay() {
    ensureStyles();
    if (!clockLayer) {
      clockLayer = document.createElement("div");
      clockLayer.id = "ba-idle-clock-layer";
      clockLayer.innerHTML = `
        <div id="ba-idle-clock-box">
          <p id="ba-idle-clock-time"></p>
          <p id="ba-idle-clock-date"></p>
        </div>
      `;
      document.body.appendChild(clockLayer);
    }
    updateClockText();
    clockLayer.classList.add("visible");
    if (!clockLayer._tick) {
      clockLayer._tick = window.setInterval(updateClockText, 1000);
    }
  }

  function hideClockOverlay() {
    if (!clockLayer) {
      return;
    }
    clockLayer.classList.remove("visible");
    if (clockLayer._tick) {
      window.clearInterval(clockLayer._tick);
      clockLayer._tick = null;
    }
  }

  function showNextSlide() {
    if (!artLayer || albumArt.length === 0) {
      return;
    }
    const slides = artLayer.querySelectorAll(".ba-idle-slide");
    if (!slides.length) {
      return;
    }
    slides.forEach((el) => el.classList.remove("active"));
    slides[slideIndex % slides.length].classList.add("active");
    slideIndex = (slideIndex + 1) % slides.length;
  }

  function startSlideshow(images) {
    ensureStyles();
    stopSlideshow();
    albumArt = images;
    slideIndex = 0;

    if (!artLayer) {
      artLayer = document.createElement("div");
      artLayer.id = "ba-idle-art-layer";
      document.body.appendChild(artLayer);
    }

    artLayer.innerHTML = images
      .map(
        (item) =>
          `<div class="ba-idle-slide" style="background-image:url('${item.image}')"></div>`
      )
      .join("");

    showNextSlide();
    requestAnimationFrame(() => artLayer.classList.add("visible"));
    showClockOverlay();
    slideTimer = window.setInterval(showNextSlide, SLIDE_INTERVAL_MS);
  }

  function stopSlideshow() {
    if (slideTimer) {
      window.clearInterval(slideTimer);
      slideTimer = null;
    }
    albumArt = [];
    if (artLayer) {
      artLayer.classList.remove("visible");
      artLayer.innerHTML = "";
    }
    hideClockOverlay();
  }

  async function idleAlbumArtEnabled() {
    try {
      const config = await rpc("config.get");
      const flag = config?.system?.idle_album_art;
      return flag !== false;
    } catch (error) {
      console.warn("Unable to read idle_album_art config", error);
      return true;
    }
  }

  async function maybeStartArtSlideshow() {
    const enabled = await idleAlbumArtEnabled();
    if (!enabled) {
      stopSlideshow();
      return;
    }
    try {
      const albums = await rpc("local.albums_with_art", { limit: 200 });
      if (!Array.isArray(albums) || albums.length === 0) {
        stopSlideshow();
        return;
      }
      // Shuffle so idle sessions do not always start on the same cover.
      for (let i = albums.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [albums[i], albums[j]] = [albums[j], albums[i]];
      }
      startSlideshow(albums);
    } catch (error) {
      console.warn("Unable to start idle album art slideshow", error);
      stopSlideshow();
    }
  }

  async function recordActivity(event) {
    lastActivity = Date.now();

    // Wake without clearing source; swallow this first touch so the
    // overlay's own button cannot immediately toggle standby back on.
    if (isStandby) {
      event.preventDefault();
      event.stopImmediatePropagation();
      stopSlideshow();
      try {
        await rpc("system.wake");
        isStandby = false;
      } catch (error) {
        console.warn("Unable to wake BerryAudio from standby", error);
      }
    }
  }

  async function checkIdle() {
    try {
      const powerState = await rpc("system.power_state");
      const wasStandby = isStandby;
      isStandby = powerState === "standby";

      const playbackState = await rpc("playback.get_state");
      const inactive = INACTIVE_PLAYBACK_STATES.has(playbackState);

      // Playback started while idle — clear art; React wakes + opens Now Playing.
      if (isStandby && !inactive) {
        stopSlideshow();
        return;
      }

      if (isStandby) {
        if (
          !wasStandby ||
          (!artLayer?.classList.contains("visible") &&
            !clockLayer?.classList.contains("visible"))
        ) {
          await maybeStartArtSlideshow();
        }
        return;
      }

      if (wasStandby) {
        stopSlideshow();
      }

      if (Date.now() - lastActivity < IDLE_TIMEOUT_MS) {
        return;
      }

      if (!inactive) {
        return;
      }

      await rpc("system.standby");
      isStandby = true;
      lastActivity = Date.now();
      await maybeStartArtSlideshow();
    } catch (error) {
      console.warn("Unable to check BerryAudio idle state", error);
    }
  }

  window.addEventListener("pointerdown", recordActivity, {
    capture: true,
    passive: false,
  });
  window.addEventListener("keydown", recordActivity, { capture: true });

  checkIdle();
  window.setInterval(checkIdle, CHECK_INTERVAL_MS);
})();
