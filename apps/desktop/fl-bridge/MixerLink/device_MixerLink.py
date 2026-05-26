# name=MixerLink Bridge
# supportedDevices=MixerLink

import mixer
import midi
import device
import time
import transport
import ui

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

pending_tempo_lsb = 0
pending_tempo_msb = 0
last_reported_playing = None
last_reported_tempo = None
last_runtime_write_at = 0
last_state_check_at = 0

print("MixerLink Bridge loaded")
print("MixerLink Bridge bidirectional mode")


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


def _write_runtime(force=False):
    global last_runtime_write_at

    now = time.time()
    if not force and now - last_runtime_write_at < 1:
        return

    last_runtime_write_at = now
    playing = _current_playing()
    tempo = _current_tempo()
    if force and _send_current_state_report(playing, tempo):
        print("MixerLink reported state tempo=%.1f playing=%s" % (tempo, playing))
    elif not force:
        _send_current_state_report(playing, tempo)


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
        lsb_sent = _send_report_cc(REPORT_TEMPO_LSB_CC, lsb)
        msb_sent = _send_report_cc(REPORT_TEMPO_MSB_CC, msb)
        command_sent = _send_report_cc(REPORT_COMMAND_CC, COMMAND_TEMPO)
        return lsb_sent and msb_sent and command_sent

    return False


def _send_current_state_report(playing, tempo):
    transport_sent = _write_local_operation({"type": "transport.play" if playing else "transport.stop"})
    tempo_sent = _write_local_operation({"type": "tempo.changed", "payload": {"bpm": tempo}})
    return transport_sent and tempo_sent


def _remember_current_state():
    global last_reported_playing, last_reported_tempo

    last_reported_playing = _current_playing()
    last_reported_tempo = _current_tempo()
    _write_runtime(True)


def _set_tempo(bpm):
    try:
        current = _current_tempo()
        delta_tenths = int(round((bpm - current) * 10))
        step = 1 if delta_tenths > 0 else -1
        print("MixerLink tempo target=%.1f current=%.1f delta=%s" % (bpm, current, delta_tenths))

        for _ in range(min(abs(delta_tenths), 2800)):
            transport.globalTransport(midi.FPT_TempoJog, step, midi.PME_System)
    except Exception as error:
        print("MixerLink tempo failed: %s" % error)


def _apply_command(command):
    global pending_tempo_lsb, pending_tempo_msb

    try:
        if command == COMMAND_PLAY:
            if not bool(transport.isPlaying()):
                transport.start()
            ui.setHintMsg("MixerLink: play")
            print("MixerLink play")
        elif command == COMMAND_STOP:
            if bool(transport.isPlaying()):
                transport.stop()
            ui.setHintMsg("MixerLink: stop")
            print("MixerLink stop")
        elif command == COMMAND_TEMPO:
            tempo_tenths = pending_tempo_lsb + (pending_tempo_msb * 128)
            bpm = tempo_tenths / 10.0
            if 20 <= bpm <= 300:
                _set_tempo(bpm)
                ui.setHintMsg("MixerLink: tempo %.1f BPM" % bpm)
                print("MixerLink tempo %.1f" % bpm)
        _remember_current_state()
    except Exception as error:
        print("MixerLink command failed: %s" % error)


def _publish_local_changes():
    global last_state_check_at, last_reported_playing, last_reported_tempo

    now = time.time()
    if now - last_state_check_at < 0.2:
        return

    last_state_check_at = now
    playing = _current_playing()
    tempo = _current_tempo()

    if last_reported_playing is None or last_reported_tempo is None:
        last_reported_playing = playing
        last_reported_tempo = tempo
        _write_runtime(True)
        return

    if playing != last_reported_playing:
        operation = {"type": "transport.play" if playing else "transport.stop"}
        last_reported_playing = playing
        reported = _write_local_operation(operation)
        print("MixerLink local %s reported=%s" % (operation["type"], reported))
        ui.setHintMsg("MixerLink: reported %s" % operation["type"])

    if abs(tempo - last_reported_tempo) >= 0.1:
        last_reported_tempo = tempo
        reported = _write_local_operation({"type": "tempo.changed", "payload": {"bpm": tempo}})
        print("MixerLink local tempo %.1f reported=%s" % (tempo, reported))
        ui.setHintMsg("MixerLink: reported tempo %.1f" % tempo)

    _write_runtime()


def OnInit():
    print("MixerLink Bridge OnInit")
    ui.setHintMsg("MixerLink Bridge ready")
    _remember_current_state()


def OnIdle():
    _publish_local_changes()


def OnRefresh(flags):
    _publish_local_changes()


def OnUpdateBeatIndicator(value):
    _publish_local_changes()


def OnDoFullRefresh():
    _publish_local_changes()


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
        print("MixerLink %s status=%s data1=%s data2=%s" % (source, status, data1, data2))

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
            _apply_command(data2)
            event.handled = True
    except Exception as error:
        print("MixerLink MIDI failed: %s" % error)
        event.handled = True
