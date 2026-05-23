# MixerLink Product Plan

## Product Shape

MixerLink is a standalone desktop app for collaborative FL Studio sessions. Users create or join rooms with a short code, verify that their local environments match, exchange project assets, and eventually mirror supported FL Studio actions between connected collaborators.

## Core User Flow

1. Open MixerLink.
2. Start a session or join an existing one.
3. Share or enter a six-digit room code.
4. Compare FL Studio version, plugin list, and project assets.
5. Mark collaborators as ready.
6. Sync supported session events.

## MVP Scope

- Desktop app shell.
- Session creation/joining.
- WebSocket-based realtime server.
- Connected user list.
- Compatibility metadata exchange.
- Activity feed.
- Local scanner placeholders.

## Later Scope

- FL Studio version detection.
- Common VST folder scanning.
- Project package and sample sync.
- FL bridge prototype.
- Transport and tempo sync.
- MIDI note/event sync where FL APIs allow it.
- Chat, voice, host controls, permissions, and recovery.

## Non-Goals For MVP

- Full native FL Studio project synchronization.
- Reverse engineering FL project internals.
- Third-party plugin state replication.
- Low-latency audio streaming.
