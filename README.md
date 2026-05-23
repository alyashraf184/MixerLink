# MixerLink

Live collaboration for FL Studio sessions.

MixerLink is planned as a desktop companion app that lets producers start or join shared sessions, compare FL Studio/plugin/sample compatibility, exchange project assets, and eventually sync supported live edits through an FL Studio bridge.

## First Milestone

The first working milestone is a session foundation:

- Start a session and generate a six-digit room code.
- Join a session using that code.
- Show connected collaborators.
- Exchange local compatibility metadata.
- Relay real-time session events through a backend server.

## Repository Layout

```txt
apps/
  desktop/   Desktop client app.
  server/    WebSocket session relay.

packages/
  shared/    Shared TypeScript schemas and event types.
  scanner/   Local FL Studio/plugin/sample detection helpers.
  protocol/  Realtime message contracts.

docs/
  product-plan.md
  architecture.md
  fl-bridge-research.md
```

## Status

Initialized project skeleton. Implementation starts with the shared protocol and local session server.
