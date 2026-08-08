class CameraWebRTCPlayer {
  constructor({ tile, statusEl, labelEl, ipEl, modeEl, appendLog }) {
    this.tile = tile;
    this.statusEl = statusEl;
    this.labelEl = labelEl;
    this.ipEl = ipEl;
    this.modeEl = modeEl;
    this.appendLog = appendLog;

    this.camera = null;
    this.video = null;
    this.reader = null;

    this.state = "idle";
    this.destroyed = false;
    this.connectStartedAt = 0;
    this.lastProgressAt = 0;
    this.lastCurrentTime = 0;
    this.connectTimeoutMs = 20000;
    this.stallTimeoutMs = 15000;

    this.monitorTimer = null;
    this.reconnectTimer = null;
    this.retryCount = 0;
    this.attemptId = 0;
    this.activeAttemptId = 0;
  }

  setCamera(camera) {
    this.camera = camera;
    this.labelEl.textContent = camera.label;
    this.ipEl.textContent = camera.ip || "No IP";
    this.modeEl.textContent = "WebRTC";

    this.retryCount = 0;
    this.stopPlayback();
    this.startPlayback();
  }

  setStatus(state, text) {
    this.state = state;
    this.statusEl.textContent = text;
    this.tile.classList.toggle("offline", state !== "live");
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  clearMonitorTimer() {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }

  ensureVideoElement() {
    if (!this.video) {
      this.video = document.createElement("video");
      this.video.className = "frame frame-video";
      this.video.autoplay = true;
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.controls = false;

      this.video.addEventListener("playing", () => {
        this.lastProgressAt = Date.now();
        this.lastCurrentTime = this.video.currentTime || 0;
        this.setStatus("live", "live");
      });

      this.video.addEventListener("stalled", () => {
        this.appendLog(`stalled: ${this.camera?.camera_id || "unknown"}`);
      });

      this.tile.insertBefore(this.video, this.statusEl);
    }
  }

  closeReader() {
    if (this.reader) {
      try {
        this.reader.close();
      } catch {
        // Ignore close errors; we'll recreate the reader.
      }
      this.reader = null;
    }

    // Any future callback from a previous reader instance is stale.
    this.activeAttemptId = 0;
  }

  stopPlayback() {
    this.clearReconnectTimer();
    this.clearMonitorTimer();
    this.closeReader();

    if (this.video) {
      this.video.pause();
      this.video.removeAttribute("src");
      this.video.srcObject = null;
      this.video.load();
    }
  }

  scheduleReconnect(reason) {
    if (this.destroyed || !this.camera || !this.camera.active) {
      return;
    }

    if (this.reconnectTimer) {
      return;
    }

    this.closeReader();

    const delay = Math.min(10000, 1000 * Math.max(1, 2 ** this.retryCount));
    this.retryCount += 1;
    this.setStatus("reconnecting", `reconnecting (${Math.round(delay / 1000)}s)`);
    this.appendLog(`reconnect ${this.camera.camera_id}: ${reason}; retry=${this.retryCount}`);

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.startReader();
    }, delay);
  }

  startReader() {
    if (this.destroyed || !this.camera) {
      return;
    }

    if (!this.camera.active) {
      this.setStatus("inactive", "inactive");
      return;
    }

    if (!this.camera.whep_url) {
      this.setStatus("missing", "missing stream");
      return;
    }

    if (typeof MediaMTXWebRTCReader !== "function") {
      this.setStatus("error", "reader missing");
      this.appendLog("MediaMTXWebRTCReader is not available");
      return;
    }

    this.ensureVideoElement();
    this.closeReader();

    const attemptId = ++this.attemptId;
    this.activeAttemptId = attemptId;
    this.connectStartedAt = Date.now();
    this.lastProgressAt = Date.now();
    this.lastCurrentTime = 0;

    this.setStatus("connecting", "connecting");

    this.reader = new MediaMTXWebRTCReader({
      url: this.camera.whep_url,
      onError: (err) => {
        if (attemptId !== this.activeAttemptId) {
          return;
        }
        const msg = err?.message || String(err);
        this.appendLog(`error ${this.camera.camera_id}: ${msg}`);
        this.scheduleReconnect(msg);
      },
      onTrack: (evt) => {
        if (attemptId !== this.activeAttemptId) {
          return;
        }
        if (!this.video) {
          return;
        }
        this.video.srcObject = evt.streams[0];
        const maybePlay = this.video.play();
        if (maybePlay && typeof maybePlay.catch === "function") {
          maybePlay.catch(() => {
            this.appendLog(`autoplay blocked: ${this.camera.camera_id}`);
          });
        }
        this.setStatus("connecting", "buffering");
      },
    });

    this.clearMonitorTimer();
    this.monitorTimer = setInterval(() => {
      if (!this.video || !this.camera || this.destroyed) {
        return;
      }

      if (attemptId !== this.activeAttemptId) {
        return;
      }

      const now = Date.now();
      if (this.state === "connecting" && now - this.connectStartedAt > this.connectTimeoutMs) {
        this.setStatus("timeout", "timeout");
        this.scheduleReconnect("connect timeout");
        return;
      }

      if (this.state === "live") {
        const currentTime = this.video.currentTime || 0;
        if (currentTime > this.lastCurrentTime + 0.02) {
          this.lastCurrentTime = currentTime;
          this.lastProgressAt = now;
        }

        if (now - this.lastProgressAt > this.stallTimeoutMs) {
          this.setStatus("timeout", "timeout");
          this.scheduleReconnect("stream stalled");
        }
      }
    }, 1500);
  }

  startPlayback() {
    this.startReader();
  }

  destroy() {
    this.destroyed = true;
    this.stopPlayback();
    if (this.video && this.video.parentNode) {
      this.video.parentNode.removeChild(this.video);
    }
  }
}

window.CameraWebRTCPlayer = CameraWebRTCPlayer;
