# MixerLink

MixerLink is a Windows desktop companion for collaborative FL Studio sessions. It lets producers join a shared room, compare their local setups, and synchronize supported FL Studio actions over a local network.

> MixerLink is currently a LAN prototype. It does not yet provide hosted internet sessions, audio streaming, full project synchronization, or plugin-state replication.

## What It Does

- Creates and joins sessions using six-digit room codes.
- Shows connected collaborators and room activity.
- Detects FL Studio installations, versions, projects, plugin folders, and common plugin formats.
- Compares plugin availability, versions, and formats between collaborators.
- Launches FL Studio and opens detected `.flp` projects.
- Synchronizes play, stop, and tempo changes between supported FL Studio instances.
- Installs and monitors the bundled FL Studio MIDI bridge script.

## How It Works

Each desktop app starts an embedded WebSocket relay on port `4317`. One producer hosts the room and shares the LAN relay address shown in MixerLink. Other producers connect to that address and enter the room code.

MixerLink exchanges structured room state through the relay:

- collaborator presence
- compatibility snapshots
- activity events
- transport and tempo operations

The FL Studio bridge is a Python MIDI script. MixerLink sends play, stop, and tempo commands through a virtual MIDI port named `MixerLink`; the script applies those commands in FL Studio and reports local FL Studio changes back to the room.

## Requirements

- Windows
- Node.js 20 or newer for development
- FL Studio for bridge features
- A bidirectional virtual MIDI port named `MixerLink`

Both collaborators must be able to reach the host on TCP port `4317`. Windows Firewall may need to allow MixerLink on private networks.

## Getting Started

Install dependencies:

```powershell
npm.cmd install
```

Run the desktop app in development:

```powershell
npm.cmd run desktop
```

Build the unpacked Windows desktop app:

```powershell
npm.cmd run desktop:dist
```

The packaged application is written to:

```text
apps/desktop/release/win-unpacked/
```

## Connecting Two Computers

1. Start MixerLink on both computers.
2. On the host, create a session and copy one of the displayed LAN relay addresses.
3. On the second computer, replace the default relay address with the host address.
4. Enter the host's six-digit room code.
5. Run and share compatibility scans.
6. Configure the `MixerLink` virtual MIDI port in FL Studio to enable transport and tempo sync.

MixerLink automatically copies its bridge script to:

```text
Documents/Image-Line/FL Studio/Settings/Hardware/MixerLink/
```

After the first install or an update, restart FL Studio and select **MixerLink Bridge** in FL Studio's MIDI settings.

## Repository Layout

```text
apps/
  desktop/   Electron and React desktop app, embedded relay, and FL bridge.
  server/    Standalone WebSocket session relay.

packages/
  shared/    Shared session models and compatibility comparison helpers.
  scanner/   Local FL Studio, plugin, and project detection.
  protocol/  Client/server realtime message contracts.

docs/
  product-plan.md
  architecture.md
  fl-bridge-research.md
```

## Current Scope and Next Steps

The current bridge supports:

- transport play
- transport stop
- tempo changes from 20 to 300 BPM

The next priorities are:

1. Validate bidirectional synchronization across two physical computers.
2. Make virtual MIDI setup and diagnostics easier.
3. Improve relay reconnect, firewall, and bridge error handling.
4. Add a hosted relay option for internet sessions.
5. Explore project and sample transfer plus additional FL Studio operations that can be implemented safely.

## Development Checks

```powershell
npm.cmd run typecheck
npm.cmd run build
```

See [the product plan](docs/product-plan.md), [architecture notes](docs/architecture.md), and [FL bridge research](docs/fl-bridge-research.md) for more background.
