(() => {
  // Only control standby from the Chromium kiosk running on the Pi. A browser
  // opened on another device must not put the physical display to sleep.
  if (!["127.0.0.1", "localhost"].includes(window.location.hostname)) {
    return;
  }

  const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
  const CHECK_INTERVAL_MS = 15 * 1000;
  const WAKE_GUARD_MS = 700;
  const INACTIVE_PLAYBACK_STATES = new Set(["stopped", "paused", "ready"]);

  let lastActivity = Date.now();
  let isStandby = false;
  let waking = false;
  let wakeGuardUntil = 0;
  let requestId = 0;

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

  function swallow(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  async function wakeFromStandby() {
    if (waking) {
      return;
    }

    waking = true;
    isStandby = false;
    wakeGuardUntil = Date.now() + WAKE_GUARD_MS;

    try {
      await rpc("system.wake");
    } catch (error) {
      console.warn("Unable to wake BerryAudio from standby", error);
    } finally {
      waking = false;
    }
  }

  function onPointerDown(event) {
    lastActivity = Date.now();

    if (Date.now() < wakeGuardUntil) {
      swallow(event);
      return;
    }

    if (!isStandby) {
      return;
    }

    // Do not swallow the wake tap itself; only block follow-up click-through.
    wakeFromStandby();
  }

  function onFollowUp(event) {
    if (Date.now() < wakeGuardUntil) {
      swallow(event);
    }
  }

  async function checkIdle() {
    try {
      const powerState = await rpc("system.power_state");
      isStandby = powerState === "standby";

      if (isStandby || waking) {
        return;
      }

      if (Date.now() - lastActivity < IDLE_TIMEOUT_MS) {
        return;
      }

      const playbackState = await rpc("playback.get_state");
      if (!INACTIVE_PLAYBACK_STATES.has(playbackState)) {
        return;
      }

      // Keep Library/Radio/etc. source intact across idle standby.
      await rpc("system.standby", { clear_source: false });
      isStandby = true;
      lastActivity = Date.now();
    } catch (error) {
      console.warn("Unable to check BerryAudio idle state", error);
    }
  }

  const captureBlock = { capture: true, passive: false };
  window.addEventListener("pointerdown", onPointerDown, captureBlock);
  window.addEventListener("pointerup", onFollowUp, captureBlock);
  window.addEventListener("click", onFollowUp, captureBlock);
  window.addEventListener(
    "keydown",
    (event) => {
      lastActivity = Date.now();
      if (Date.now() < wakeGuardUntil) {
        swallow(event);
        return;
      }
      if (isStandby) {
        wakeFromStandby();
      }
    },
    { capture: true }
  );

  checkIdle();
  window.setInterval(checkIdle, CHECK_INTERVAL_MS);
})();
