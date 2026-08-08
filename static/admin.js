const cameraIdInput = document.getElementById("cameraId");
const cameraLabelInput = document.getElementById("cameraLabel");
const cameraPathInput = document.getElementById("cameraPath");
const cameraIpInput = document.getElementById("cameraIp");
const cameraActiveInput = document.getElementById("cameraActive");

const webrtcHostInput = document.getElementById("webrtcHost");
const webrtcPortInput = document.getElementById("webrtcPort");
const saveSettingsButton = document.getElementById("saveSettingsButton");
const refreshSettingsButton = document.getElementById("refreshSettingsButton");
const testRelayButton = document.getElementById("testRelayButton");
const settingsMessage = document.getElementById("settingsMessage");
const relayMessage = document.getElementById("relayMessage");

const addButton = document.getElementById("addButton");
const refreshButton = document.getElementById("refreshButton");
const message = document.getElementById("message");
const cameraList = document.getElementById("cameraList");

let camerasReadOnly = true;

function setMessage(text, isError = false) {
  message.textContent = text;
  message.style.color = isError ? "#ff5b5b" : "#00ff66";
}

function populateForm(camera) {
  cameraIdInput.value = camera.camera_id;
  cameraLabelInput.value = camera.label;
  cameraPathInput.value = camera.path || camera.camera_id;
  cameraIpInput.value = camera.ip || "";
  cameraActiveInput.checked = Boolean(camera.active);
}

function setSettingsMessage(text, isError = false) {
  settingsMessage.textContent = text;
  settingsMessage.style.color = isError ? "#ff5b5b" : "#00ff66";
}

function setRelayMessage(text, isError = false) {
  relayMessage.textContent = text;
  relayMessage.style.color = isError ? "#ff5b5b" : "#00ff66";
}

function formatRelayStatus(relay) {
  if (!relay) {
    return "relay status unavailable";
  }
  const state = relay.running ? "running" : "stopped";
  const pid = relay.pid ? `pid=${relay.pid}` : "pid=n/a";
  const err = relay.last_error ? `error=${relay.last_error}` : "";
  return [state, pid, err].filter(Boolean).join(" | ");
}

async function syncRelay(reason = "admin refresh") {
  try {
    const response = await fetch("/api/relay/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Relay sync failed");
    }

    setRelayMessage(formatRelayStatus(data.relay));
  } catch (error) {
    setRelayMessage(error.message, true);
  }
}

async function refreshSettings() {
  try {
    const response = await fetch("/api/settings", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Failed to fetch settings");
    }

    const settings = await response.json();
    webrtcHostInput.value = settings.webrtc_host || "";
    webrtcPortInput.value = settings.webrtc_port || 8889;
    setSettingsMessage("Settings loaded");
  } catch (error) {
    setSettingsMessage(error.message, true);
  }
}

async function saveSettings() {
  const payload = {
    webrtc_host: webrtcHostInput.value.trim(),
    webrtc_port: Number(webrtcPortInput.value || 8889),
  };

  try {
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Failed to save settings");
    }

    setSettingsMessage("Settings saved");
    setRelayMessage(formatRelayStatus(data.relay));
    await refreshCameras();
    await syncRelay("settings saved");
  } catch (error) {
    setSettingsMessage(error.message, true);
  }
}

async function testRelay() {
  const cameraId = cameraIdInput.value.trim();
  const query = cameraId ? `?camera=${encodeURIComponent(cameraId)}` : "";

  try {
    const response = await fetch(`/api/relay/check${query}`, { cache: "no-store" });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Relay test failed");
    }

    const details = [
      `host=${data.host}`,
      `port=${data.port}`,
      `tcp=${data.tcp_ok ? "ok" : "fail"}`,
    ];

    if (data.whep_url) {
      details.push(`whep=${data.whep_url}`);
    }

    setRelayMessage(details.join(" | "));
  } catch (error) {
    setRelayMessage(error.message, true);
  }
}

async function refreshCameras() {
  try {
    const response = await fetch("/api/cameras");
    if (!response.ok) {
      throw new Error("Failed to fetch cameras");
    }

    const data = await response.json();
    camerasReadOnly = Boolean(data.read_only);
    addButton.disabled = camerasReadOnly;
    const cameras = (data.cameras || []).slice().sort((a, b) => a.camera_id.localeCompare(b.camera_id));

    if (data.config_error) {
      setMessage(`Config error: ${data.config_error}`, true);
    } else if (camerasReadOnly) {
      setMessage("cameras.json is read-only; edit the file manually and press Refresh.");
    }

    cameraList.innerHTML = "";

    cameras.forEach((camera) => {
      const item = document.createElement("article");
      item.className = "camera-item";

      const info = document.createElement("div");
      info.innerHTML = `<strong>${camera.label}</strong><div>${camera.camera_id}</div><div>path: ${camera.path || camera.camera_id}</div><div>${camera.ip || "No IP"}</div><div>${camera.active ? "active" : "inactive"}</div>`;

      const controls = document.createElement("div");
      controls.className = "camera-item-controls";

      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.textContent = "Edit";
      editButton.addEventListener("click", () => populateForm(camera));

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.textContent = "Delete";
      deleteButton.disabled = camerasReadOnly;
      deleteButton.addEventListener("click", async () => {
        if (camerasReadOnly) {
          setMessage("cameras.json is read-only; delete entries in the file manually.", true);
          return;
        }
        try {
          const delRes = await fetch(`/api/cameras/${encodeURIComponent(camera.camera_id)}`, {
            method: "DELETE",
          });
          if (!delRes.ok) {
            throw new Error("Delete failed");
          }
          setMessage(`Deleted ${camera.camera_id}`);
          await refreshCameras();
        } catch (error) {
          setMessage(error.message, true);
        }
      });

      controls.appendChild(editButton);
      controls.appendChild(deleteButton);

      item.appendChild(info);
      item.appendChild(controls);
      cameraList.appendChild(item);
    });

    if (cameras.length > 0 && !cameraIdInput.value) {
      populateForm(cameras[0]);
    }
  } catch (error) {
    setMessage(error.message, true);
  }
}

async function saveCamera() {
  if (camerasReadOnly) {
    setMessage("cameras.json is read-only; edit the file manually and press Refresh.", true);
    return;
  }

  const camera = {
    camera_id: cameraIdInput.value.trim(),
    label: cameraLabelInput.value.trim(),
    path: cameraPathInput.value.trim(),
    ip: cameraIpInput.value.trim(),
    active: cameraActiveInput.checked,
  };

  if (!camera.camera_id) {
    setMessage("Camera ID is required", true);
    return;
  }

  try {
    const response = await fetch("/api/cameras", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(camera),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Save failed");
    }

    setMessage(`${data.status}: ${camera.camera_id}`);
    await refreshCameras();
    await syncRelay(`camera ${data.status}: ${camera.camera_id}`);
  } catch (error) {
    setMessage(error.message, true);
  }
}

addButton.addEventListener("click", saveCamera);
refreshButton.addEventListener("click", async () => {
  await Promise.all([refreshSettings(), refreshCameras()]);
  await syncRelay("admin refresh button");
});
saveSettingsButton.addEventListener("click", saveSettings);
refreshSettingsButton.addEventListener("click", async () => {
  await refreshSettings();
  await syncRelay("admin refresh settings");
});
testRelayButton.addEventListener("click", testRelay);

window.addEventListener("load", async () => {
  await Promise.all([refreshSettings(), refreshCameras()]);
  await syncRelay("admin page load");

  if (camerasReadOnly) {
    addButton.disabled = true;
  }
});
