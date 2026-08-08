const gridRoot = document.getElementById("grid");
const debugLog = document.getElementById("debugLog");

let debugEnabled = false;
const players = new Map();

function appendLog(message) {
  if (!debugEnabled || !debugLog) {
    return;
  }
  const now = new Date().toLocaleTimeString();
  debugLog.textContent = `${now} ${message}\n${debugLog.textContent}`.slice(0, 2000);
}

function setDebugEnabled(enabled) {
  debugEnabled = Boolean(enabled);
  if (debugLog) {
    debugLog.style.display = debugEnabled ? "block" : "none";
  }
}

function makeTile(camera) {
  const tile = document.createElement("article");
  tile.className = "tile offline";
  tile.dataset.cameraId = camera.camera_id;

  const status = document.createElement("div");
  status.className = "offline-state";
  status.textContent = "connecting";

  const label = document.createElement("div");
  label.className = "tile-label";
  label.textContent = camera.label;

  const meta = document.createElement("div");
  meta.className = "tile-meta";

  const ip = document.createElement("span");
  ip.className = "tile-ip";
  ip.textContent = camera.ip || "No IP";

  const mode = document.createElement("span");
  mode.className = "tile-latency";
  mode.textContent = "WEBRTC";

  meta.appendChild(ip);
  meta.appendChild(mode);

  tile.appendChild(status);
  tile.appendChild(label);
  tile.appendChild(meta);

  tile.addEventListener("click", () => {
    window.location.href = `/view?camera=${encodeURIComponent(camera.camera_id)}`;
  });

  const player = new CameraWebRTCPlayer({
    tile,
    statusEl: status,
    labelEl: label,
    ipEl: ip,
    modeEl: mode,
    appendLog,
  });

  players.set(camera.camera_id, { camera, tile, player });
  player.setCamera(camera);

  return tile;
}

function cameraChanged(prev, next) {
  return (
    prev.label !== next.label
    || prev.ip !== next.ip
    || prev.active !== next.active
    || prev.path !== next.path
    || prev.whep_url !== next.whep_url
  );
}

function reconcileCameras(cameras) {

  const sorted = cameras.slice().sort((a, b) => a.camera_id.localeCompare(b.camera_id));
  const ids = new Set(sorted.map((camera) => camera.camera_id));

  for (const [cameraId, entry] of players.entries()) {
    if (!ids.has(cameraId)) {
      entry.player.destroy();
      entry.tile.remove();
      players.delete(cameraId);
      appendLog(`removed ${cameraId}`);
    }
  }

  sorted.forEach((camera) => {
    const existing = players.get(camera.camera_id);
    if (!existing) {
      gridRoot.appendChild(makeTile(camera));
      appendLog(`added ${camera.camera_id}`);
      return;
    }

    if (cameraChanged(existing.camera, camera)) {
      existing.camera = camera;
      existing.player.setCamera(camera);
      appendLog(`updated ${camera.camera_id}`);
    }
  });

  // Keep visual order stable by appending in sorted order.
  sorted.forEach((camera) => {
    const entry = players.get(camera.camera_id);
    if (entry) {
      gridRoot.appendChild(entry.tile);
    }
  });
}

async function refreshGridConfig() {
  try {
    const [metaRes, camerasRes] = await Promise.all([
      fetch("/api/meta", { cache: "no-store" }),
      fetch("/api/cameras", { cache: "no-store" }),
    ]);

    if (!metaRes.ok || !camerasRes.ok) {
      throw new Error("Failed to load API data");
    }

    const meta = await metaRes.json();
    const payload = await camerasRes.json();
    setDebugEnabled(meta.debug_log);
    reconcileCameras(payload.cameras || []);
  } catch (error) {
    appendLog(`config refresh failed: ${error.message}`);
  }
}

window.addEventListener("beforeunload", () => {
  for (const entry of players.values()) {
    entry.player.destroy();
  }
});

window.addEventListener("load", async () => {
  await refreshGridConfig();
  setInterval(refreshGridConfig, 30000);
});
