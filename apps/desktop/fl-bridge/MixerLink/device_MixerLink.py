# name=MixerLink Bridge
# supportedDevices=MixerLink

import mixer
import midi
import transport
import ui

MIDI_CC = 176
COMMAND_CC = 20
TEMPO_LSB_CC = 21
TEMPO_MSB_CC = 22

COMMAND_PLAY = 1
COMMAND_STOP = 2
COMMAND_TEMPO = 3

pending_tempo_lsb = 0
pending_tempo_msb = 0

print("MixerLink Bridge loaded")
print("MixerLink Bridge MIDI-only mode")


def _current_tempo():
    try:
        tempo = float(mixer.getCurrentTempo())
        if tempo > 1000:
            tempo = tempo / 1000.0
        return round(tempo, 1)
    except Exception:
        return 120.0


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
    except Exception as error:
        print("MixerLink command failed: %s" % error)


def OnInit():
    print("MixerLink Bridge OnInit")
    ui.setHintMsg("MixerLink Bridge ready")


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
