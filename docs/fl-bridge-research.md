# FL Studio Bridge Research

This document will track what MixerLink can safely and reliably control inside FL Studio.

## Research Questions

- Can we detect the running FL Studio version reliably?
- Which FL Studio actions can be observed through MIDI scripting?
- Which actions can be controlled through MIDI scripting?
- Which project or plugin state can a native plugin observe?
- Can tempo and transport be synchronized cleanly?
- Can MIDI note edits be mirrored without fragile UI automation?
- Which actions are impossible without official Image-Line support?

## Working Assumption

MixerLink should avoid reverse engineering and UI automation for the MVP. The first FL bridge should focus on supported or low-risk integrations such as transport, tempo, MIDI, and selected parameter sync.
