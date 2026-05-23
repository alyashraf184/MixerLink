# MixerLink Architecture

## Components

### Desktop App

The user-facing app. It manages session creation/joining, collaborator presence, compatibility display, project selection, activity logs, and later FL Studio bridge controls.

### Session Server

A lightweight realtime relay. It creates room codes, tracks users, validates basic messages, and broadcasts session events to peers in the same room.

### Shared Packages

Shared TypeScript contracts keep the desktop app, server, scanner, and future bridge aligned.

### Scanner

Local helpers for detecting FL Studio, installed plugins, selected project files, sample paths, and checksums.

### FL Bridge

Future integration layer for syncing supported actions with FL Studio. This may use a combination of plugin SDK, MIDI scripting, and controlled companion workflows.

## Realtime Model

MixerLink should send structured operations rather than opaque full-project snapshots.

Examples:

- `session.created`
- `session.joined`
- `compatibility.updated`
- `transport.play`
- `transport.stop`
- `tempo.changed`
- `midi.note_added`

## First Technical Target

Two app clients can connect to the same local server room, see each other, and exchange compatibility metadata.
