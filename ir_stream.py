#!/usr/bin/env python3
from __future__ import annotations

import argparse
import atexit
import json
import logging
import re
import shutil
import socket
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, render_template, request


CONFIG_PATH = Path(__file__).resolve().parent / "cameras.json"
SETTINGS_PATH = Path(__file__).resolve().parent / "settings.json"
CAMERA_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{1,32}$")
READ_ONLY_CAMERAS_ERROR = "cameras.json is read-only; edit the file manually"


@dataclass
class AppConfig:
	host: str
	port: int
	debug_log: bool
	webrtc_port: int = 8889
	mediamtx_bin: str = "mediamtx"


def default_settings() -> dict[str, Any]:
	return {
		"webrtc_host": "",
		"webrtc_port": 8889,
	}


def load_settings() -> dict[str, Any]:
	defaults = default_settings()
	if not SETTINGS_PATH.exists():
		save_settings(defaults)
		return defaults

	try:
		payload = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
	except (json.JSONDecodeError, OSError):
		save_settings(defaults)
		return defaults

	if not isinstance(payload, dict):
		save_settings(defaults)
		return defaults

	settings = defaults | payload
	settings["webrtc_host"] = str(settings.get("webrtc_host", "")).strip()
	try:
		settings["webrtc_port"] = int(settings.get("webrtc_port", defaults["webrtc_port"]))
	except (TypeError, ValueError):
		settings["webrtc_port"] = defaults["webrtc_port"]

	return settings


def save_settings(settings: dict[str, Any]) -> None:
	cleaned = {
		"webrtc_host": str(settings.get("webrtc_host", "")).strip(),
		"webrtc_port": int(settings.get("webrtc_port", 8889)),
	}
	SETTINGS_PATH.write_text(json.dumps(cleaned, indent=2), encoding="utf-8")


def normalize_camera(raw: dict[str, Any]) -> dict[str, Any]:
	camera_id = str(raw.get("camera_id", "")).strip()
	if not CAMERA_ID_PATTERN.match(camera_id):
		raise ValueError("camera_id must match ^[a-zA-Z0-9_-]{1,32}$")

	label = str(raw.get("label", camera_id)).strip() or camera_id
	ip = str(raw.get("ip", "")).strip()
	active = bool(raw.get("active", False))
	path = str(raw.get("path") or camera_id).strip("/") or camera_id

	return {
		"camera_id": camera_id,
		"label": label,
		"ip": ip,
		"active": active,
		"path": path,
	}


def load_cameras() -> list[dict[str, Any]]:
	if not CONFIG_PATH.exists():
		raise ValueError(f"{CONFIG_PATH.name} not found")

	try:
		payload = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
	except json.JSONDecodeError as exc:
		raise ValueError(f"invalid JSON in {CONFIG_PATH.name}: {exc.msg}") from exc
	except OSError as exc:
		raise ValueError(f"failed reading {CONFIG_PATH.name}: {exc}") from exc

	if not isinstance(payload, list):
		raise ValueError(f"{CONFIG_PATH.name} must contain a JSON array")

	cameras: list[dict[str, Any]] = []
	seen_ids: set[str] = set()
	for idx, item in enumerate(payload):
		if not isinstance(item, dict):
			raise ValueError(f"camera entry at index {idx} must be an object")
		try:
			camera = normalize_camera(item)
		except ValueError as exc:
			raise ValueError(f"camera entry at index {idx}: {exc}") from exc
		if camera["camera_id"] in seen_ids:
			raise ValueError(f"duplicate camera_id '{camera['camera_id']}'")
		seen_ids.add(camera["camera_id"])
		cameras.append(camera)

	return cameras


def build_stream_urls(camera: dict[str, Any], cfg: AppConfig, settings: dict[str, Any]) -> dict[str, Any]:
	direct_ip = camera.get("ip", "").strip()
	relay_host = str(settings.get("webrtc_host", "")).strip()
	port = int(settings.get("webrtc_port", cfg.webrtc_port))
	path = camera.get("path", camera.get("camera_id", "")).strip("/")

	target_host = relay_host or direct_ip

	if not target_host or not path:
		return {
			"whep_url": "",
			"direct_whep_url": "",
			"relay_enabled": bool(relay_host),
		}

	return {
		"whep_url": f"http://{target_host}:{port}/{path}/whep",
		"direct_whep_url": f"http://{direct_ip}:{cfg.webrtc_port}/{path}/whep" if direct_ip else "",
		"relay_enabled": bool(relay_host),
	}


def serialize_camera(camera: dict[str, Any], cfg: AppConfig, settings: dict[str, Any]) -> dict[str, Any]:
	return {
		**camera,
		**build_stream_urls(camera, cfg, settings),
	}


def tcp_check(host: str, port: int, timeout_s: float = 2.0) -> bool:
	if not host:
		return False
	try:
		with socket.create_connection((host, port), timeout=timeout_s):
			return True
	except OSError:
		return False


def build_mediamtx_relay_config(cameras: list[dict[str, Any]], webrtc_port: int) -> str:
	lines: list[str] = [
		"# Auto-generated relay config",
		"# Run on main machine: mediamtx mediamtx-relay.yml",
		"webrtc: true",
		f"webrtcAddress: :{webrtc_port}",
		"webrtcLocalUDPAddress: :8189",
		"hls: false",
		"rtsp: true",
		"paths:",
	]

	for camera in cameras:
		if not camera.get("active", False):
			continue

		cam_id = str(camera.get("camera_id", "")).strip()
		path = str(camera.get("path", cam_id)).strip("/")
		ip = str(camera.get("ip", "")).strip()

		if not cam_id or not path or not ip:
			continue

		lines.extend(
			[
				f"  {path}:",
				f"    source: rtsp://{ip}:8554/{path}",
				"    sourceOnDemand: no",
				"    rtspTransport: tcp",
			]
		)

	return "\n".join(lines) + "\n"


class RelayManager:
	def __init__(self, cfg: AppConfig, cameras: list[dict[str, Any]], settings_loader) -> None:
		self.cfg = cfg
		self.cameras = cameras
		self.settings_loader = settings_loader
		self.config_path = Path(__file__).resolve().parent / "mediamtx-relay.yml"
		self._process: subprocess.Popen[str] | None = None
		self._lock = threading.Lock()
		self._log_thread: threading.Thread | None = None
		self._last_error = ""
		self._last_sync_reason = ""
		atexit.register(self.stop)

	def _resolve_binary(self) -> str | None:
		if Path(self.cfg.mediamtx_bin).exists():
			return self.cfg.mediamtx_bin
		return shutil.which(self.cfg.mediamtx_bin)

	def _log_stream_output(self, process: subprocess.Popen[str]) -> None:
		if process.stdout is None:
			return
		for line in process.stdout:
			msg = line.rstrip()
			if msg:
				logging.info("[relay] %s", msg)

	def _write_config(self) -> str:
		settings = self.settings_loader()
		port = int(settings.get("webrtc_port", self.cfg.webrtc_port))
		content = build_mediamtx_relay_config(self.cameras, port)
		self.config_path.write_text(content, encoding="utf-8")
		return content

	def _running(self) -> bool:
		return self._process is not None and self._process.poll() is None

	def _stop_locked(self) -> None:
		if not self._running():
			self._process = None
			return
		assert self._process is not None
		self._process.terminate()
		try:
			self._process.wait(timeout=5)
		except subprocess.TimeoutExpired:
			self._process.kill()
			self._process.wait(timeout=3)
		logging.info("Relay process stopped")
		self._process = None

	def stop(self) -> None:
		with self._lock:
			self._stop_locked()

	def sync(self, reason: str, restart: bool = True) -> dict[str, Any]:
		with self._lock:
			self._last_sync_reason = reason
			content = self._write_config()

			if restart and self._running():
				self._stop_locked()

			if not self._running():
				binary = self._resolve_binary()
				if not binary:
					self._last_error = "mediamtx binary not found"
					logging.error("Relay sync failed: %s", self._last_error)
					return self.status(config_content=content)

				try:
					self._process = subprocess.Popen(
						[binary, str(self.config_path)],
						stdout=subprocess.PIPE,
						stderr=subprocess.STDOUT,
						text=True,
						bufsize=1,
					)
				except OSError as exc:
					self._process = None
					self._last_error = str(exc)
					logging.error("Relay start failed: %s", self._last_error)
					return self.status(config_content=content)

				self._last_error = ""
				self._log_thread = threading.Thread(
					target=self._log_stream_output,
					args=(self._process,),
					daemon=True,
				)
				self._log_thread.start()
				logging.info("Relay process started with config %s", self.config_path)

			return self.status(config_content=content)

	def status(self, config_content: str | None = None) -> dict[str, Any]:
		settings = self.settings_loader()
		relay_host = str(settings.get("webrtc_host", "")).strip()
		port = int(settings.get("webrtc_port", self.cfg.webrtc_port))
		return {
			"running": self._running(),
			"pid": self._process.pid if self._running() and self._process else None,
			"config_path": str(self.config_path),
			"relay_host": relay_host,
			"webrtc_port": port,
			"last_error": self._last_error,
			"last_sync_reason": self._last_sync_reason,
			"config_content": config_content,
		}


def create_app(cfg: AppConfig) -> Flask:
	app = Flask(__name__)
	app.config["APP_CFG"] = cfg

	cameras: list[dict[str, Any]] = []
	cameras_config_error = ""
	settings = load_settings()

	def reload_cameras_from_disk() -> None:
		nonlocal cameras_config_error
		try:
			loaded = load_cameras()
		except ValueError as exc:
			cameras.clear()
			cameras_config_error = str(exc)
			logging.error("Camera config error: %s", cameras_config_error)
			return

		cameras.clear()
		cameras.extend(loaded)
		cameras_config_error = ""

	reload_cameras_from_disk()

	relay_manager = RelayManager(cfg, cameras, load_settings)
	app.config["RELAY_MANAGER"] = relay_manager

	def get_camera_index(camera_id: str) -> int:
		for index, camera in enumerate(cameras):
			if camera["camera_id"] == camera_id:
				return index
		return -1

	@app.get("/")
	def index() -> str:
		return render_template("index.html", page_title="CCTV Grid")

	@app.get("/admin")
	def admin() -> str:
		return render_template("admin.html", page_title="CCTV Admin")

	@app.get("/view")
	def view() -> str:
		camera_id = request.args.get("camera", "", type=str)
		return render_template("view.html", page_title="Camera View", camera_id=camera_id)

	@app.get("/api/meta")
	def api_meta() -> Any:
		reload_cameras_from_disk()
		return jsonify(
			{
				"debug_log": cfg.debug_log,
				"stream_protocol": "webrtc",
				"relay_host": settings.get("webrtc_host", ""),
				"webrtc_port": int(settings.get("webrtc_port", cfg.webrtc_port)),
				"relay_enabled": bool(str(settings.get("webrtc_host", "")).strip()),
				"cameras_read_only": True,
				"cameras_count": len(cameras),
				"cameras_config_error": cameras_config_error,
			}
		)

	@app.get("/api/settings")
	def api_get_settings() -> Any:
		nonlocal settings
		settings = load_settings()
		return jsonify(settings)

	@app.post("/api/settings")
	def api_save_settings() -> Any:
		nonlocal settings
		data = request.get_json(silent=True) or {}
		host = str(data.get("webrtc_host", "")).strip()
		try:
			port = int(data.get("webrtc_port", cfg.webrtc_port))
		except (TypeError, ValueError):
			return jsonify({"error": "webrtc_port must be a number"}), 400

		if port < 1 or port > 65535:
			return jsonify({"error": "webrtc_port must be between 1 and 65535"}), 400

		settings = {
			"webrtc_host": host,
			"webrtc_port": port,
		}
		save_settings(settings)
		logging.info("Relay settings updated: host=%s port=%s", host or "<direct-camera>", port)
		relay_status = relay_manager.sync("settings updated", restart=True)
		return jsonify({
			**settings,
			"relay": relay_status,
		})

	@app.get("/api/cameras")
	def api_get_cameras() -> Any:
		nonlocal settings
		reload_cameras_from_disk()
		settings = load_settings()
		return jsonify(
			{
				"cameras": [serialize_camera(camera, cfg, settings) for camera in cameras],
				"read_only": True,
				"config_error": cameras_config_error,
			}
		)

	@app.get("/api/relay/check")
	def api_relay_check() -> Any:
		nonlocal settings
		reload_cameras_from_disk()
		settings = load_settings()

		camera_id = request.args.get("camera", "", type=str).strip()
		selected_camera = None
		if camera_id:
			for cam in cameras:
				if cam["camera_id"] == camera_id:
					selected_camera = cam
					break
			if selected_camera is None:
				return jsonify({"error": f"camera '{camera_id}' not found"}), 404

		relay_host = str(settings.get("webrtc_host", "")).strip()
		port = int(settings.get("webrtc_port", cfg.webrtc_port))
		host = relay_host or (selected_camera.get("ip", "").strip() if selected_camera else "")

		whep_url = ""
		if selected_camera:
			whep_url = build_stream_urls(selected_camera, cfg, settings).get("whep_url", "")

		return jsonify(
			{
				"host": host,
				"port": port,
				"relay_enabled": bool(relay_host),
				"tcp_ok": tcp_check(host, port) if host else False,
				"whep_url": whep_url,
			}
		)

	@app.get("/api/relay/config")
	def api_relay_config() -> Any:
		nonlocal settings
		reload_cameras_from_disk()
		settings = load_settings()
		port = int(settings.get("webrtc_port", cfg.webrtc_port))
		content = build_mediamtx_relay_config(cameras, port)
		return jsonify(
			{
				"filename": "mediamtx-relay.yml",
				"webrtc_port": port,
				"relay_host": str(settings.get("webrtc_host", "")).strip(),
				"content": content,
			}
		)

	@app.post("/api/relay/sync")
	def api_relay_sync() -> Any:
		reload_cameras_from_disk()
		data = request.get_json(silent=True) or {}
		reason = str(data.get("reason", "manual sync")).strip() or "manual sync"
		restart = bool(data.get("restart", False))
		relay_status = relay_manager.sync(reason, restart=restart)
		return jsonify({
			"status": "ok",
			"relay": relay_status,
			"cameras_config_error": cameras_config_error,
		})

	@app.post("/api/cameras")
	def api_upsert_camera() -> Any:
		return jsonify({"error": READ_ONLY_CAMERAS_ERROR}), 403

	@app.delete("/api/cameras/<camera_id>")
	def api_delete_camera(camera_id: str) -> Any:
		return jsonify({"error": READ_ONLY_CAMERAS_ERROR}), 403

	return app


def parse_args() -> AppConfig:
	parser = argparse.ArgumentParser(description="Simple 4-camera CCTV viewer backend")
	parser.add_argument("--host", default="127.0.0.1", help="Flask bind host (default: 127.0.0.1)")
	parser.add_argument("--port", default=5000, type=int, help="Flask bind port (default: 5000)")
	parser.add_argument(
		"--debug-log",
		action="store_true",
		help="Enable backend debug logging and frontend debug overlay",
	)
	parser.add_argument(
		"--stream-protocol",
		default="webrtc",
		choices=["webrtc", "hls"],
		help=argparse.SUPPRESS,
	)
	parser.add_argument("--webrtc-port", default=8889, type=int, help="MediaMTX WebRTC HTTP port")
	parser.add_argument(
		"--mediamtx-bin",
		default="mediamtx",
		help="Path or command name for MediaMTX binary",
	)

	args = parser.parse_args()
	return AppConfig(
		host=args.host,
		port=args.port,
		debug_log=args.debug_log,
		webrtc_port=args.webrtc_port,
		mediamtx_bin=args.mediamtx_bin,
	)


def main() -> None:
	cfg = parse_args()
	logging.basicConfig(
		level=logging.DEBUG if cfg.debug_log else logging.INFO,
		format="%(asctime)s %(levelname)s %(message)s",
	)

	app = create_app(cfg)
	relay_manager: RelayManager = app.config["RELAY_MANAGER"]
	relay_status = relay_manager.sync("startup", restart=True)
	if relay_status.get("running"):
		logging.info("Relay manager is running with PID %s", relay_status.get("pid"))
	else:
		logging.error("Relay manager failed to start: %s", relay_status.get("last_error"))
	logging.info("Starting CCTV backend on http://%s:%s", cfg.host, cfg.port)
	logging.info("Stream mode: WebRTC")
	app.run(host=cfg.host, port=cfg.port, debug=False)


if __name__ == "__main__":
	main()
