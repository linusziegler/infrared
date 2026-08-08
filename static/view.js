const viewRoot = document.getElementById("singleViewRoot");
const debugLog = document.getElementById("debugLog");

let debugEnabled = false;
let player = null;
let activeCameraId = "";

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

function buildTile(camera) {
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

  return { tile, status, label, ip, mode };
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

let currentCamera = null;

function mountOrUpdatePlayer(camera) {
  if (!player) {
    const refs = buildTile(camera);
    viewRoot.innerHTML = "";
    viewRoot.appendChild(refs.tile);

    player = new CameraWebRTCPlayer({
      tile: refs.tile,
      statusEl: refs.status,
      labelEl: refs.label,
      ipEl: refs.ip,
      modeEl: refs.mode,
      appendLog,
    });
    player.setCamera(camera);
    currentCamera = camera;
    appendLog(`view mounted: ${camera.camera_id}`);
    return;
  }

  if (cameraChanged(currentCamera, camera)) {
    player.setCamera(camera);
    currentCamera = camera;
    appendLog(`view updated: ${camera.camera_id}`);
  }
}

async function refreshViewConfig() {
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

    const params = new URLSearchParams(window.location.search);
    const requestedId = params.get("camera") || document.body.dataset.cameraId || "";
    const cameras = payload.cameras || [];

    const selected = cameras.find((camera) => camera.camera_id === requestedId) || cameras[0];
    if (!selected) {
      viewRoot.innerHTML = "<article class=\"tile offline\"><div class=\"offline-state\" style=\"opacity:1\">no cameras configured</div></article>";
      return;
    }

    if (selected.camera_id !== activeCameraId) {
      activeCameraId = selected.camera_id;
      if (player) {
        player.destroy();
        player = null;
      }
      currentCamera = null;
    }

    mountOrUpdatePlayer(selected);
  } catch (error) {
    appendLog(`config refresh failed: ${error.message}`);
  }
}

window.addEventListener("beforeunload", () => {
  if (player) {
    player.destroy();
  }
});

window.addEventListener("load", async () => {
  await refreshViewConfig();
  setInterval(refreshViewConfig, 30000);
});
