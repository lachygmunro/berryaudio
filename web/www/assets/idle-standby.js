(() => {
  // Only control standby from the Chromium kiosk running on the Pi. A browser
  // opened on another device must not put the physical display to sleep.
  if (!["127.0.0.1", "localhost"].includes(window.location.hostname)) {
    return;
  }

  const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
  const CHECK_INTERVAL_MS = 15 * 1000;
  const INACTIVE_PLAYBACK_STATES = new Set(["stopped", "paused", "ready"]);

  let lastActivity = Date.now();
  let isStandby = false;
  let requestId = 0;

  async function rpc(method) {
    const response = await fetch("/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method,
        id: ++requestId,
      }),
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

  async function recordActivity(event) {
    lastActivity = Date.now();

    // Standby is a toggle in BerryAudio. Swallow this first touch so the
    // overlay's own button cannot immediately toggle standby back on.
    if (isStandby) {
      event.preventDefault();
      event.stopImmediatePropagation();
      try {
        await rpc("system.standby");
        isStandby = false;
      } catch (error) {
        console.warn("Unable to wake BerryAudio from standby", error);
      }
    }
  }

  async function checkIdle() {
    try {
      const powerState = await rpc("system.power_state");
      isStandby = powerState === "standby";

      if (isStandby || Date.now() - lastActivity < IDLE_TIMEOUT_MS) {
        return;
      }

      const playbackState = await rpc("playback.get_state");
      if (!INACTIVE_PLAYBACK_STATES.has(playbackState)) {
        return;
      }

      await rpc("system.standby");
      isStandby = true;
      lastActivity = Date.now();
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
