# name=MixerLink Bridge
# url=https://github.com/alyashraf184/MixerLink

import json
import os
import time
import urllib.error
import urllib.request

import mixer
import transport
import ui

BRIDGE_URL = "http://127.0.0.1:4318"
BRIDGE_DIR = os.path.join(
    os.path.expanduser("~"),
    "Documents",
    "Image-Line",
    "FL Studio",
    "Settings",
    "MixerLink",
)
COMMANDS_PATH = os.path.join(BRIDGE_DIR, "commands.json")
RUNTIME_PATH = os.path.join(BRIDGE_DIR, "runtime.json")
POLL_INTERVAL_SECONDS = 0.2
POST_INTERVAL_SECONDS = 0.25
HTTP_TIMEOUT_SECONDS = 0.35

last_event_id = 0
last_poll_at = 0
last_post_at = 0
last_hello_at = 0
last_playing = None
last_tempo = None
applying_remote = False


def _request_json(method, path, payload=None):
    data = None
    headers = {"Content-Type": "application/json"}

    if payload is not None:
        data = json.dumps(payload).encode("utf-8")

    request = urllib.request.Request(BRIDGE_URL + path, data=data, headers=headers, method=method)

    with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
        raw = response.read().decode("utf-8")
        return json.loads(raw) if raw else {}


def _safe_request(method, path, payload=None):
    try:
        return _request_json(method, path, payload)
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError, TypeError):
        return None


def _read_json_file(file_path):
    try:
        with open(file_path, "r") as file:
            return json.load(file)
    except (IOError, OSError, ValueError):
        return None


def _write_json_file(file_path, payload):
    try:
        if not os.path.isdir(BRIDGE_DIR):
            os.makedirs(BRIDGE_DIR)

        temp_path = file_path + ".tmp"
        with open(temp_path, "w") as file:
            json.dump(payload, file)
        os.replace(temp_path, file_path)
        return True
    except (IOError, OSError, ValueError):
        return False


def _current_state():
    return {
        "playing": bool(transport.isPlaying()),
        "tempoBpm": round(float(mixer.getCurrentTempo()), 1),
    }


def _send_hello(force=False):
    global last_hello_at

    now = time.time()
    if not force and now - last_hello_at < 2.0:
        return

    last_hello_at = now
    state = _current_state()
    _safe_request(
        "POST",
        "/fl/hello",
        {
            "script": "MixerLink Bridge",
            "playing": state["playing"],
            "tempoBpm": state["tempoBpm"],
        },
    )
    _write_runtime_state()


def _apply_operation(operation):
    global applying_remote, last_playing, last_tempo

    operation_type = operation.get("type")
    applying_remote = True

    try:
        if operation_type == "transport.play":
            if not bool(transport.isPlaying()):
                transport.start()
            last_playing = True
            ui.setHintMsg("MixerLink: play")
        elif operation_type == "transport.stop":
            transport.stop()
            last_playing = False
            ui.setHintMsg("MixerLink: stop")
        elif operation_type == "tempo.changed":
            bpm = float(operation.get("payload", {}).get("bpm"))
            if 20 <= bpm <= 300:
                mixer.setCurrentTempo(bpm)
                last_tempo = round(bpm, 1)
                ui.setHintMsg("MixerLink: tempo %.1f BPM" % bpm)
    finally:
        applying_remote = False


def _poll_mixerlink():
    global last_event_id

    payload = _safe_request("GET", "/events?after=%s" % last_event_id)
    if not payload:
        payload = _read_json_file(COMMANDS_PATH)

    if not payload:
        return

    for event in payload.get("events", []):
        event_id = int(event.get("id", 0))
        operation = event.get("operation")

        if event_id > last_event_id:
            last_event_id = event_id

        if isinstance(operation, dict):
            _apply_operation(operation)


def _post_operation(operation):
    if not _safe_request("POST", "/operation", {"operation": operation}):
        _write_json_file(
            os.path.join(BRIDGE_DIR, "last-local-operation.json"),
            {
                "operation": operation,
                "createdAt": time.time(),
            },
        )


def _write_runtime_state():
    state = _current_state()
    _write_json_file(
        RUNTIME_PATH,
        {
            "script": "MixerLink Bridge",
            "playing": state["playing"],
            "tempoBpm": state["tempoBpm"],
            "lastSeenAt": _iso_now(),
        },
    )


def _post_state():
    state = _current_state()
    _write_runtime_state()
    _safe_request("POST", "/fl/state", state)


def _iso_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _detect_local_changes():
    global last_playing, last_tempo, last_post_at

    if applying_remote:
        return

    now = time.time()
    if now - last_post_at < POST_INTERVAL_SECONDS:
        return

    state = _current_state()
    playing = state["playing"]
    tempo = state["tempoBpm"]

    if last_playing is None:
        last_playing = playing

    if last_tempo is None:
        last_tempo = tempo

    if playing != last_playing:
        last_playing = playing
        last_post_at = now
        _post_operation({"type": "transport.play" if playing else "transport.stop"})
        _post_state()
        return

    if abs(tempo - last_tempo) >= 0.1:
        last_tempo = tempo
        last_post_at = now
        _post_operation({"type": "tempo.changed", "payload": {"bpm": tempo}})
        _post_state()


def OnInit():
    global last_playing, last_tempo

    state = _current_state()
    last_playing = state["playing"]
    last_tempo = state["tempoBpm"]
    _send_hello(True)
    ui.setHintMsg("MixerLink Bridge ready")


def OnIdle():
    global last_poll_at

    now = time.time()

    _send_hello(False)

    if now - last_poll_at >= POLL_INTERVAL_SECONDS:
        last_poll_at = now
        _poll_mixerlink()

    _detect_local_changes()
