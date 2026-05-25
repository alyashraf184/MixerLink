# name=MixerLink Bridge
# url=https://github.com/alyashraf184/MixerLink

import json
import time
import urllib.error
import urllib.request

import mixer
import transport
import ui

BRIDGE_URL = "http://127.0.0.1:4318"
POLL_INTERVAL_SECONDS = 0.2
POST_INTERVAL_SECONDS = 0.25

last_event_id = 0
last_poll_at = 0
last_post_at = 0
last_playing = None
last_tempo = None
applying_remote = False


def _request_json(method, path, payload=None, timeout=0.08):
    data = None
    headers = {"Content-Type": "application/json"}

    if payload is not None:
        data = json.dumps(payload).encode("utf-8")

    request = urllib.request.Request(BRIDGE_URL + path, data=data, headers=headers, method=method)

    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read().decode("utf-8")
        return json.loads(raw) if raw else {}


def _apply_operation(operation):
    global applying_remote, last_playing, last_tempo

    operation_type = operation.get("type")
    applying_remote = True

    try:
        if operation_type == "transport.play":
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

    payload = _request_json("GET", "/events?after=%s" % last_event_id)

    for event in payload.get("events", []):
        event_id = int(event.get("id", 0))
        operation = event.get("operation")

        if event_id > last_event_id:
            last_event_id = event_id

        if isinstance(operation, dict):
            _apply_operation(operation)


def _post_operation(operation):
    _request_json("POST", "/operation", {"operation": operation})


def _detect_local_changes():
    global last_playing, last_tempo, last_post_at

    if applying_remote:
        return

    now = time.time()
    if now - last_post_at < POST_INTERVAL_SECONDS:
        return

    playing = bool(transport.isPlaying())
    tempo = round(float(mixer.getCurrentTempo()), 1)

    if last_playing is None:
        last_playing = playing

    if last_tempo is None:
        last_tempo = tempo

    if playing != last_playing:
        last_playing = playing
        last_post_at = now
        _post_operation({"type": "transport.play" if playing else "transport.stop"})
        return

    if abs(tempo - last_tempo) >= 0.1:
        last_tempo = tempo
        last_post_at = now
        _post_operation({"type": "tempo.changed", "payload": {"bpm": tempo}})


def OnInit():
    global last_playing, last_tempo

    last_playing = bool(transport.isPlaying())
    last_tempo = round(float(mixer.getCurrentTempo()), 1)
    ui.setHintMsg("MixerLink Bridge ready")


def OnIdle():
    global last_poll_at

    now = time.time()

    try:
        if now - last_poll_at >= POLL_INTERVAL_SECONDS:
            last_poll_at = now
            _poll_mixerlink()

        _detect_local_changes()
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError, TypeError):
        return
