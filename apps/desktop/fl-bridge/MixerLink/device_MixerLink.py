# name=MixerLink Bridge
# supportedDevices=MixerLink

import json
import os
import time
import urllib.error
import urllib.request

import channels
import device
import midi
import mixer
import plugins
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
LOCAL_OPERATION_PATH = os.path.join(BRIDGE_DIR, "last-local-operation.json")

MIDI_CC = 176
COMMAND_CC = 20
TEMPO_LSB_CC = 21
TEMPO_MSB_CC = 22
REPORT_COMMAND_CC = 30
REPORT_TEMPO_LSB_CC = 31
REPORT_TEMPO_MSB_CC = 32

COMMAND_PLAY = 1
COMMAND_STOP = 2
COMMAND_TEMPO = 3

CHANNEL_SCAN_INTERVAL_SECONDS = 0.35
COMMAND_POLL_INTERVAL_SECONDS = 0.2
RUNTIME_WRITE_INTERVAL_SECONDS = 1.0
HTTP_TIMEOUT_SECONDS = 0.2
STEP_COUNT = 16
MAX_PLUGIN_PARAMETERS = 24

# Parameter replication is intentionally allowlisted. Parameter indices are
# checked against names on the receiving FL Studio instance before applying.
SUPPORTED_PLUGIN_NAMES = {
    "3x osc",
    "flex",
    "fl keys",
    "fpc",
    "fruity dx10",
    "fruity granulizer",
    "fruity slicer",
    "minisynth",
    "sytrus",
}

pending_tempo_lsb = 0
pending_tempo_msb = 0
last_reported_playing = None
last_reported_tempo = None
last_runtime_write_at = 0
last_state_check_at = 0
last_command_poll_at = 0
last_event_id = 0
last_channel_state_key = None
applying_remote = False

print("MixerLink Bridge loaded")
print("MixerLink Bridge channel rack mode")


def _midi_message(data1, data2):
    return MIDI_CC + (data1 << 8) + ((data2 & 127) << 16)


def _send_report_cc(data1, data2):
    try:
        device.midiOutMsg(_midi_message(data1, data2))
        return True
    except Exception as error:
        print("MixerLink MIDI report failed: %s" % error)
        return False


def _current_tempo():
    try:
        tempo = float(mixer.getCurrentTempo())
        if tempo > 1000:
            tempo = tempo / 1000.0
        return round(tempo, 1)
    except Exception:
        return 120.0


def _current_playing():
    try:
        return bool(transport.isPlaying())
    except Exception:
        return False


def _normalize_plugin_name(value):
    return " ".join(str(value or "").lower().replace("-", " ").split())


def _channel_type_name(value):
    names = {
        0: "sampler",
        1: "hybrid",
        2: "generator",
        3: "layer",
        4: "audio-clip",
        5: "automation-clip",
    }
    return names.get(int(value), "unknown")


def _call_channel(function, index, *arguments):
    return function(index, *arguments)


def _call_plugin(function, arguments):
    return function(*arguments)


def _get_plugin_name(index):
    try:
        if not bool(_call_plugin(plugins.isValid, (index, -1))):
            return ""
        return str(_call_plugin(plugins.getPluginName, (index, -1, 0)))
    except Exception:
        return ""


def _get_plugin_parameters(index, plugin_name):
    if _normalize_plugin_name(plugin_name) not in SUPPORTED_PLUGIN_NAMES:
        return []

    result = []
    try:
        count = int(_call_plugin(plugins.getParamCount, (index, -1)))
    except Exception:
        return result

    for parameter_index in range(min(count, MAX_PLUGIN_PARAMETERS)):
        try:
            name = str(_call_plugin(plugins.getParamName, (parameter_index, index, -1)))
            value = round(float(_call_plugin(plugins.getParamValue, (parameter_index, index, -1))), 6)
            display_value = ""
            try:
                display_value = str(
                    _call_plugin(plugins.getParamValueString, (parameter_index, index, -1))
                )
            except Exception:
                pass
            result.append(
                {
                    "index": parameter_index,
                    "name": name,
                    "value": value,
                    "displayValue": display_value,
                }
            )
        except Exception:
            continue

    return result


def _read_channel(index):
    plugin_name = _get_plugin_name(index)
    steps = []

    for step in range(STEP_COUNT):
        try:
            steps.append(bool(_call_channel(channels.getGridBit, index, step)))
        except Exception:
            steps.append(False)

    try:
        channel_type = _channel_type_name(_call_channel(channels.getChannelType, index))
    except Exception:
        channel_type = "unknown"

    def read(function, default, *arguments):
        try:
            return _call_channel(function, index, *arguments)
        except Exception:
            return default

    return {
        "index": index,
        "name": str(read(channels.getChannelName, "Channel %s" % (index + 1))),
        "color": int(read(channels.getChannelColor, 0)),
        "type": channel_type,
        "pluginName": plugin_name or None,
        "supportedPlugin": _normalize_plugin_name(plugin_name) in SUPPORTED_PLUGIN_NAMES,
        "muted": bool(read(channels.isChannelMuted, False)),
        "solo": bool(read(channels.isChannelSolo, False)),
        "volume": round(float(read(channels.getChannelVolume, 0.8, 0)), 6),
        "pan": round(float(read(channels.getChannelPan, 0.0)), 6),
        "pitch": round(float(read(channels.getChannelPitch, 0.0, 0)), 6),
        "selected": bool(read(channels.isChannelSelected, False)),
        "targetMixerTrack": int(read(channels.getTargetFxTrack, 0)),
        "steps": steps,
        "pluginParameters": _get_plugin_parameters(index, plugin_name),
    }


def _channel_rack_state():
    try:
        count = min(int(channels.channelCount()), 128)
    except Exception:
        count = 0

    rack_channels = []
    for index in range(count):
        try:
            rack_channels.append(_read_channel(index))
        except Exception as error:
            print("MixerLink channel %s scan failed: %s" % (index, error))

    return {
        "channels": rack_channels,
        "stepCount": STEP_COUNT,
        "capturedAt": _iso_now(),
    }


def _state_key(channel_rack):
    stable = {
        "channels": channel_rack.get("channels", []),
        "stepCount": channel_rack.get("stepCount", STEP_COUNT),
    }
    return json.dumps(stable, sort_keys=True, separators=(",", ":"))


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


def _iso_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _write_local_operation(operation):
    if operation["type"] == "transport.play":
        return _send_report_cc(REPORT_COMMAND_CC, COMMAND_PLAY)

    if operation["type"] == "transport.stop":
        return _send_report_cc(REPORT_COMMAND_CC, COMMAND_STOP)

    if operation["type"] == "tempo.changed":
        bpm = operation["payload"]["bpm"]
        tempo_tenths = int(round(bpm * 10))
        lsb = tempo_tenths & 127
        msb = (tempo_tenths >> 7) & 127
        return (
            _send_report_cc(REPORT_TEMPO_LSB_CC, lsb)
            and _send_report_cc(REPORT_TEMPO_MSB_CC, msb)
            and _send_report_cc(REPORT_COMMAND_CC, COMMAND_TEMPO)
        )

    if _safe_request("POST", "/operation", {"operation": operation}):
        return True

    return _write_json_file(
        LOCAL_OPERATION_PATH,
        {
            "operation": operation,
            "createdAt": time.time(),
        },
    )


def _write_runtime(channel_rack=None, force=False):
    global last_runtime_write_at

    now = time.time()
    if not force and now - last_runtime_write_at < RUNTIME_WRITE_INTERVAL_SECONDS:
        return

    last_runtime_write_at = now
    if channel_rack is None:
        channel_rack = _channel_rack_state()

    payload = {
        "script": "MixerLink Bridge",
        "playing": _current_playing(),
        "tempoBpm": _current_tempo(),
        "lastSeenAt": _iso_now(),
        "channelRack": channel_rack,
    }
    _write_json_file(RUNTIME_PATH, payload)
    _safe_request("POST", "/fl/state", payload)


def _plugin_matches(index, expected_plugin_name):
    if not expected_plugin_name:
        return True
    return _normalize_plugin_name(_get_plugin_name(index)) == _normalize_plugin_name(expected_plugin_name)


def _set_channel_property(index, key, value):
    if key == "name":
        _call_channel(channels.setChannelName, index, str(value)[:64])
    elif key == "color":
        _call_channel(channels.setChannelColor, index, int(value))
    elif key == "muted":
        _call_channel(channels.muteChannel, index, 1 if value else 0)
    elif key == "solo":
        _call_channel(channels.soloChannel, index, 1 if value else 0)
    elif key == "volume":
        _call_channel(channels.setChannelVolume, index, max(0.0, min(1.0, float(value))), midi.PIM_None)
    elif key == "pan":
        _call_channel(channels.setChannelPan, index, max(-1.0, min(1.0, float(value))), midi.PIM_None)
    elif key == "pitch":
        _call_channel(channels.setChannelPitch, index, max(-1.0, min(1.0, float(value))), 0, midi.PIM_None)
    elif key == "selected":
        _call_channel(channels.selectChannel, index, 1 if value else 0)
    elif key == "targetMixerTrack":
        _call_channel(channels.setTargetFxTrack, index, max(0, min(127, int(value))))


def _apply_channel_snapshot(remote_channel):
    index = int(remote_channel.get("index", -1))
    try:
        count = int(channels.channelCount())
    except Exception:
        count = 0

    if index < 0 or index >= count or not _plugin_matches(index, remote_channel.get("pluginName")):
        return

    for key in (
        "name",
        "color",
        "muted",
        "solo",
        "volume",
        "pan",
        "pitch",
        "selected",
        "targetMixerTrack",
    ):
        if key in remote_channel:
            try:
                _set_channel_property(index, key, remote_channel[key])
            except Exception:
                pass

    for step, active in enumerate(remote_channel.get("steps", [])[:STEP_COUNT]):
        try:
            _call_channel(channels.setGridBit, index, step, 1 if active else 0)
        except Exception:
            pass

    if not remote_channel.get("supportedPlugin"):
        return

    current_plugin_name = _get_plugin_name(index)
    for parameter in remote_channel.get("pluginParameters", [])[:MAX_PLUGIN_PARAMETERS]:
        _apply_plugin_parameter(
            index,
            current_plugin_name,
            parameter.get("index"),
            parameter.get("name"),
            parameter.get("value"),
        )


def _apply_plugin_parameter(index, expected_plugin_name, parameter_index, parameter_name, value):
    if _normalize_plugin_name(expected_plugin_name) not in SUPPORTED_PLUGIN_NAMES:
        return
    if not _plugin_matches(index, expected_plugin_name):
        return

    parameter_index = int(parameter_index)
    if parameter_index < 0 or parameter_index >= MAX_PLUGIN_PARAMETERS:
        return

    actual_name = str(_call_plugin(plugins.getParamName, (parameter_index, index, -1)))
    if str(parameter_name) != actual_name:
        return

    _call_plugin(
        plugins.setParamValue,
        (max(0.0, min(1.0, float(value))), parameter_index, index, -1, midi.PIM_None),
    )


def _apply_operation(operation):
    global applying_remote, last_channel_state_key, last_reported_playing, last_reported_tempo

    operation_type = operation.get("type")
    payload = operation.get("payload", {})
    applying_remote = True

    try:
        if operation_type == "transport.play":
            if not bool(transport.isPlaying()):
                transport.start()
            last_reported_playing = True
        elif operation_type == "transport.stop":
            if bool(transport.isPlaying()):
                transport.stop()
            last_reported_playing = False
        elif operation_type == "tempo.changed":
            _set_tempo(float(payload.get("bpm")))
            last_reported_tempo = _current_tempo()
        elif operation_type == "channel_rack.snapshot":
            for remote_channel in payload.get("channels", []):
                _apply_channel_snapshot(remote_channel)
        elif operation_type == "channel_rack.channel.updated":
            index = int(payload.get("index", -1))
            if index >= 0 and _plugin_matches(index, payload.get("expectedPluginName")):
                for key, value in payload.get("patch", {}).items():
                    _set_channel_property(index, key, value)
        elif operation_type == "channel_rack.step.changed":
            index = int(payload.get("index", -1))
            step = int(payload.get("step", -1))
            if index >= 0 and 0 <= step < STEP_COUNT and _plugin_matches(index, payload.get("expectedPluginName")):
                _call_channel(channels.setGridBit, index, step, 1 if payload.get("active") else 0)
        elif operation_type == "channel_rack.plugin_parameter.changed":
            _apply_plugin_parameter(
                int(payload.get("index", -1)),
                payload.get("pluginName"),
                payload.get("parameterIndex"),
                payload.get("parameterName"),
                payload.get("value"),
            )

        if operation_type.startswith("channel_rack."):
            current = _channel_rack_state()
            last_channel_state_key = _state_key(current)
            _write_runtime(current, True)
            ui.setHintMsg("MixerLink: Channel Rack updated")
    except Exception as error:
        print("MixerLink operation failed: %s" % error)
    finally:
        applying_remote = False


def _poll_commands():
    global last_command_poll_at, last_event_id

    now = time.time()
    if now - last_command_poll_at < COMMAND_POLL_INTERVAL_SECONDS:
        return
    last_command_poll_at = now

    payload = _read_json_file(COMMANDS_PATH)
    if not payload:
        return

    for event in payload.get("events", []):
        event_id = int(event.get("id", 0))
        if event_id <= last_event_id:
            continue
        last_event_id = event_id
        operation = event.get("operation")
        if isinstance(operation, dict):
            _apply_operation(operation)


def _set_tempo(bpm):
    try:
        if bpm < 20 or bpm > 300:
            return
        current = _current_tempo()
        delta_tenths = int(round((bpm - current) * 10))
        step = 1 if delta_tenths > 0 else -1
        for _ in range(min(abs(delta_tenths), 2800)):
            transport.globalTransport(midi.FPT_TempoJog, step, midi.PME_System)
    except Exception as error:
        print("MixerLink tempo failed: %s" % error)


def _scan_local_changes(force=False):
    global last_state_check_at, last_channel_state_key

    if applying_remote:
        return

    now = time.time()
    if not force and now - last_state_check_at < CHANNEL_SCAN_INTERVAL_SECONDS:
        return
    last_state_check_at = now

    channel_rack = _channel_rack_state()
    channel_state_key = _state_key(channel_rack)
    if last_channel_state_key is None:
        last_channel_state_key = channel_state_key
    elif channel_state_key != last_channel_state_key:
        last_channel_state_key = channel_state_key
        _write_local_operation({"type": "channel_rack.snapshot", "payload": channel_rack})
        ui.setHintMsg("MixerLink: Channel Rack shared")

    _write_runtime(channel_rack, force)


def _publish_transport_changes():
    global last_reported_playing, last_reported_tempo

    if applying_remote:
        return

    playing = _current_playing()
    tempo = _current_tempo()
    if last_reported_playing is None:
        last_reported_playing = playing
    if last_reported_tempo is None:
        last_reported_tempo = tempo

    if playing != last_reported_playing:
        last_reported_playing = playing
        _write_local_operation({"type": "transport.play" if playing else "transport.stop"})

    if abs(tempo - last_reported_tempo) >= 0.1:
        last_reported_tempo = tempo
        _write_local_operation({"type": "tempo.changed", "payload": {"bpm": tempo}})


def _remember_current_state():
    global last_reported_playing, last_reported_tempo
    last_reported_playing = _current_playing()
    last_reported_tempo = _current_tempo()
    _scan_local_changes(True)
    _send_current_state_report(last_reported_playing, last_reported_tempo)


def _send_current_state_report(playing, tempo):
    transport_sent = _write_local_operation({"type": "transport.play" if playing else "transport.stop"})
    tempo_sent = _write_local_operation({"type": "tempo.changed", "payload": {"bpm": tempo}})
    return transport_sent and tempo_sent


def OnInit():
    print("MixerLink Bridge OnInit")
    ui.setHintMsg("MixerLink Bridge ready")
    _remember_current_state()


def OnIdle():
    _poll_commands()
    _publish_transport_changes()
    _scan_local_changes()


def OnRefresh(flags):
    _scan_local_changes()


def OnDirtyChannel(index, flags):
    _scan_local_changes()


def OnUpdateBeatIndicator(value):
    _publish_transport_changes()


def OnDoFullRefresh():
    _scan_local_changes(True)


def OnProjectLoad(status):
    _remember_current_state()


def OnMidiMsg(event):
    _handle_midi_event(event, "midi")


def OnControlChange(event):
    _handle_midi_event(event, "cc")


def OnNoteOn(event):
    _handle_midi_event(event, "note")


def _handle_midi_event(event, source):
    global pending_tempo_lsb, pending_tempo_msb

    try:
        status = int(event.status) & 240
        data1 = int(event.data1)
        data2 = int(event.data2) & 127
        if status != MIDI_CC:
            return

        if data1 == TEMPO_LSB_CC:
            pending_tempo_lsb = data2
            event.handled = True
            return

        if data1 == TEMPO_MSB_CC:
            pending_tempo_msb = data2
            event.handled = True
            return

        if data1 == COMMAND_CC:
            if data2 == COMMAND_PLAY:
                _apply_operation({"type": "transport.play"})
            elif data2 == COMMAND_STOP:
                _apply_operation({"type": "transport.stop"})
            elif data2 == COMMAND_TEMPO:
                tempo_tenths = pending_tempo_lsb + (pending_tempo_msb * 128)
                _apply_operation({"type": "tempo.changed", "payload": {"bpm": tempo_tenths / 10.0}})
            event.handled = True
    except Exception as error:
        print("MixerLink MIDI failed: %s" % error)
        event.handled = True
