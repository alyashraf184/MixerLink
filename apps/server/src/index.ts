import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "@mixerlink/protocol";
import type {
  ActivityEvent,
  BridgeOperation,
  BridgeState,
  Collaborator,
  CompatibilitySnapshot,
  SessionCode,
  SessionState
} from "@mixerlink/shared";

const port = Number(process.env.PORT ?? 4317);
const server = new WebSocketServer({ port });

type RoomMember = {
  socket: WebSocket;
  collaborator: Collaborator;
  compatibility?: CompatibilitySnapshot;
};

type Room = {
  code: SessionCode;
  members: Map<string, RoomMember>;
  bridge: BridgeState;
  activity: ActivityEvent[];
};

const rooms = new Map<SessionCode, Room>();
const socketRooms = new Map<WebSocket, SessionCode>();

function createSessionCode(): SessionCode {
  let code: SessionCode;

  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms.has(code));

  return code;
}

function createCollaborator(displayName: unknown): Collaborator {
  return {
    id: randomUUID(),
    displayName: normalizeDisplayName(displayName),
    joinedAt: new Date().toISOString(),
    status: "connected"
  };
}

function normalizeDisplayName(displayName: unknown): string {
  const normalized = String(displayName ?? "").trim();
  return normalized.length > 0 ? normalized.slice(0, 48) : "Guest";
}

function send(socket: WebSocket, message: ServerMessage): void {
  socket.send(JSON.stringify(message));
}

function sendError(socket: WebSocket, message: string): void {
  send(socket, {
    type: "session.error",
    payload: { message }
  });
}

function parseClientMessage(rawMessage: WebSocket.RawData): ClientMessage | undefined {
  try {
    const message = JSON.parse(rawMessage.toString()) as ClientMessage;

    if (typeof message !== "object" || message === null || !("type" in message)) {
      return undefined;
    }

    return message;
  } catch {
    return undefined;
  }
}

function getRoomState(room: Room): SessionState {
  const compatibility: SessionState["compatibility"] = {};

  for (const member of room.members.values()) {
    if (member.compatibility) {
      compatibility[member.collaborator.id] = member.compatibility;
    }
  }

  return {
    code: room.code,
    collaborators: Array.from(room.members.values(), (member) => member.collaborator),
    compatibility,
    bridge: room.bridge,
    activity: room.activity
  };
}

function addActivity(
  room: Room,
  type: ActivityEvent["type"],
  message: string,
  collaboratorId?: string
): void {
  room.activity = [
    {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      type,
      message,
      collaboratorId
    },
    ...room.activity
  ].slice(0, 30);
}

function broadcastRoomState(room: Room): void {
  const message: ServerMessage = {
    type: "session.state",
    payload: getRoomState(room)
  };

  for (const member of room.members.values()) {
    send(member.socket, message);
  }
}

function createBridgeState(): BridgeState {
  return {
    transport: "stopped",
    tempoBpm: 120,
    channelRack: {
      channels: [],
      stepCount: 16,
      capturedAt: new Date(0).toISOString()
    }
  };
}

function applyBridgeOperation(room: Room, operation: BridgeOperation, collaboratorId: string): string | undefined {
  const createdAt = new Date().toISOString();
  const lastOperation = {
    type: operation.type,
    collaboratorId,
    createdAt,
    operation
  };

  switch (operation.type) {
    case "transport.play":
      room.bridge = {
        ...room.bridge,
        transport: "playing",
        lastOperation
      };
      return "started playback";

    case "transport.stop":
      room.bridge = {
        ...room.bridge,
        transport: "stopped",
        lastOperation
      };
      return "stopped playback";

    case "tempo.changed": {
      const bpm = Math.round(Number(operation.payload.bpm) * 10) / 10;
      if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) {
        return undefined;
      }

      room.bridge = {
        ...room.bridge,
        tempoBpm: bpm,
        lastOperation
      };
      return `set tempo to ${bpm} BPM`;
    }

    case "channel_rack.snapshot": {
      if (!Array.isArray(operation.payload?.channels) || operation.payload.channels.length > 128) {
        return undefined;
      }

      room.bridge = {
        ...room.bridge,
        channelRack: operation.payload,
        lastOperation
      };
      return `shared ${operation.payload.channels.length} Channel Rack channels`;
    }

    case "channel_rack.channel.updated": {
      const channel = room.bridge.channelRack.channels.find((candidate) => candidate.index === operation.payload.index);
      if (!channel || typeof operation.payload.patch !== "object") {
        return undefined;
      }

      room.bridge = {
        ...room.bridge,
        channelRack: {
          ...room.bridge.channelRack,
          channels: room.bridge.channelRack.channels.map((candidate) =>
            candidate.index === channel.index ? { ...candidate, ...operation.payload.patch } : candidate
          ),
          capturedAt: createdAt
        },
        lastOperation
      };
      return `updated Channel Rack channel ${channel.name}`;
    }

    case "channel_rack.step.changed": {
      const channel = room.bridge.channelRack.channels.find((candidate) => candidate.index === operation.payload.index);
      if (!channel || !Number.isInteger(operation.payload.step) || operation.payload.step < 0 || operation.payload.step >= 64) {
        return undefined;
      }

      room.bridge = {
        ...room.bridge,
        channelRack: {
          ...room.bridge.channelRack,
          channels: room.bridge.channelRack.channels.map((candidate) => {
            if (candidate.index !== channel.index) {
              return candidate;
            }

            const steps = [...candidate.steps];
            steps[operation.payload.step] = operation.payload.active;
            return { ...candidate, steps };
          }),
          capturedAt: createdAt
        },
        lastOperation
      };
      return `${operation.payload.active ? "enabled" : "disabled"} step ${operation.payload.step + 1} on ${channel.name}`;
    }

    case "channel_rack.plugin_parameter.changed": {
      const channel = room.bridge.channelRack.channels.find((candidate) => candidate.index === operation.payload.index);
      const value = Number(operation.payload.value);
      if (!channel || !channel.supportedPlugin || !Number.isFinite(value) || value < 0 || value > 1) {
        return undefined;
      }

      room.bridge = {
        ...room.bridge,
        channelRack: {
          ...room.bridge.channelRack,
          channels: room.bridge.channelRack.channels.map((candidate) => {
            if (candidate.index !== channel.index) {
              return candidate;
            }

            return {
              ...candidate,
              pluginParameters: candidate.pluginParameters.map((parameter) =>
                parameter.index === operation.payload.parameterIndex ? { ...parameter, value } : parameter
              )
            };
          }),
          capturedAt: createdAt
        },
        lastOperation
      };
      return `updated ${operation.payload.parameterName} on ${channel.name}`;
    }
  }
}

function leaveCurrentRoom(socket: WebSocket): void {
  const code = socketRooms.get(socket);
  if (!code) {
    return;
  }

  const room = rooms.get(code);
  socketRooms.delete(socket);

  if (!room) {
    return;
  }

  for (const [collaboratorId, member] of room.members) {
    if (member.socket === socket) {
      addActivity(room, "collaborator.left", `${member.collaborator.displayName} left the session.`, collaboratorId);
      room.members.delete(collaboratorId);
      break;
    }
  }

  if (room.members.size === 0) {
    rooms.delete(code);
    return;
  }

  broadcastRoomState(room);
}

function leaveRoomByRequest(socket: WebSocket): void {
  const code = socketRooms.get(socket);
  leaveCurrentRoom(socket);

  if (code) {
    send(socket, {
      type: "session.left",
      payload: { code }
    });
  }
}

function joinRoom(socket: WebSocket, room: Room, displayName: unknown): void {
  leaveCurrentRoom(socket);

  const collaborator = createCollaborator(displayName);
  room.members.set(collaborator.id, {
    socket,
    collaborator
  });
  socketRooms.set(socket, room.code);
  addActivity(room, "collaborator.joined", `${collaborator.displayName} joined the session.`, collaborator.id);

  send(socket, {
    type: "session.joined",
    payload: {
      code: room.code,
      collaboratorId: collaborator.id
    }
  });
  broadcastRoomState(room);
}

function handleMessage(socket: WebSocket, message: ClientMessage): void {
  switch (message.type) {
    case "session.create": {
      const code = createSessionCode();
      const room: Room = {
        code,
        members: new Map(),
        bridge: createBridgeState(),
        activity: []
      };

      rooms.set(code, room);
      addActivity(room, "session.created", `Session ${code} was created.`);
      send(socket, {
        type: "session.created",
        payload: { code }
      });
      joinRoom(socket, room, message.payload?.displayName);
      return;
    }

    case "session.join": {
      const code = String(message.payload?.code ?? "").trim();
      const room = rooms.get(code);

      if (!room) {
        sendError(socket, "No active MixerLink session found for that code.");
        return;
      }

      joinRoom(socket, room, message.payload.displayName);
      return;
    }

    case "session.leave": {
      leaveRoomByRequest(socket);
      return;
    }

    case "compatibility.update": {
      const code = socketRooms.get(socket);
      const room = code ? rooms.get(code) : undefined;

      if (!room) {
        sendError(socket, "Join or create a session before sending compatibility updates.");
        return;
      }

      const member = Array.from(room.members.values()).find((roomMember) => roomMember.socket === socket);
      if (!member) {
        sendError(socket, "Session membership could not be found.");
        return;
      }

      member.compatibility = message.payload;
      addActivity(
        room,
        "compatibility.updated",
        `${member.collaborator.displayName} shared a compatibility snapshot.`,
        member.collaborator.id
      );
      broadcastRoomState(room);
      return;
    }

    case "bridge.operation": {
      const code = socketRooms.get(socket);
      const room = code ? rooms.get(code) : undefined;

      if (!room) {
        sendError(socket, "Join or create a session before sending bridge operations.");
        return;
      }

      const member = Array.from(room.members.values()).find((roomMember) => roomMember.socket === socket);
      if (!member) {
        sendError(socket, "Session membership could not be found.");
        return;
      }

      const activityMessage = applyBridgeOperation(room, message.payload, member.collaborator.id);
      if (!activityMessage) {
        sendError(socket, "Bridge operation was not valid.");
        return;
      }

      addActivity(
        room,
        "bridge.operation",
        `${member.collaborator.displayName} ${activityMessage}.`,
        member.collaborator.id
      );
      broadcastRoomState(room);
    }
  }
}

server.on("connection", (socket) => {
  send(socket, {
    type: "server.hello",
    payload: {
      app: "MixerLink",
      message: "Connected to MixerLink session relay."
    }
  });

  socket.on("message", (rawMessage) => {
    const message = parseClientMessage(rawMessage);

    if (!message) {
      sendError(socket, "MixerLink could not read that message.");
      return;
    }

    handleMessage(socket, message);
  });

  socket.on("close", () => {
    leaveCurrentRoom(socket);
  });
});

console.log(`MixerLink session server listening on ws://localhost:${port}`);
