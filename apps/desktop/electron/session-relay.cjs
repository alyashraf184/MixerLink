const { randomUUID } = require("node:crypto");
const { WebSocketServer } = require("ws");

const rooms = new Map();
const socketRooms = new Map();

function startSessionRelay(port) {
  const relay = new WebSocketServer({ host: "0.0.0.0", port });

  relay.on("connection", (socket) => {
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

  relay.on("listening", () => {
    console.log(`MixerLink embedded relay listening on ws://0.0.0.0:${port}`);
  });

  relay.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.log(`MixerLink relay port ${port} is already in use; using existing relay.`);
      return;
    }

    console.error(error);
  });

  return relay;
}

function createSessionCode() {
  let code;

  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms.has(code));

  return code;
}

function createCollaborator(displayName) {
  return {
    id: randomUUID(),
    displayName: normalizeDisplayName(displayName),
    joinedAt: new Date().toISOString(),
    status: "connected"
  };
}

function normalizeDisplayName(displayName) {
  const normalized = String(displayName ?? "").trim();
  return normalized.length > 0 ? normalized.slice(0, 48) : "Guest";
}

function send(socket, message) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function sendError(socket, message) {
  send(socket, {
    type: "session.error",
    payload: { message }
  });
}

function parseClientMessage(rawMessage) {
  try {
    const message = JSON.parse(rawMessage.toString());

    if (typeof message !== "object" || message === null || typeof message.type !== "string") {
      return undefined;
    }

    return message;
  } catch {
    return undefined;
  }
}

function getRoomState(room) {
  const compatibility = {};

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

function addActivity(room, type, message, collaboratorId) {
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

function broadcastRoomState(room) {
  const message = {
    type: "session.state",
    payload: getRoomState(room)
  };

  for (const member of room.members.values()) {
    send(member.socket, message);
  }
}

function createBridgeState() {
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

function applyBridgeOperation(room, operation, collaboratorId) {
  const createdAt = new Date().toISOString();
  const lastOperation = {
    type: operation?.type,
    collaboratorId,
    createdAt,
    operation
  };

  switch (operation?.type) {
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
      const bpm = Math.round(Number(operation.payload?.bpm) * 10) / 10;
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
      const channel = room.bridge.channelRack.channels.find((candidate) => candidate.index === operation.payload?.index);
      if (!channel || !operation.payload?.patch || typeof operation.payload.patch !== "object") {
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
      const channel = room.bridge.channelRack.channels.find((candidate) => candidate.index === operation.payload?.index);
      const step = Number(operation.payload?.step);
      if (!channel || !Number.isInteger(step) || step < 0 || step >= 64) {
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
            steps[step] = Boolean(operation.payload.active);
            return { ...candidate, steps };
          }),
          capturedAt: createdAt
        },
        lastOperation
      };
      return `${operation.payload.active ? "enabled" : "disabled"} step ${step + 1} on ${channel.name}`;
    }

    case "channel_rack.plugin_parameter.changed": {
      const channel = room.bridge.channelRack.channels.find((candidate) => candidate.index === operation.payload?.index);
      const value = Number(operation.payload?.value);
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

    default:
      return undefined;
  }
}

function leaveCurrentRoom(socket) {
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

function leaveRoomByRequest(socket) {
  const code = socketRooms.get(socket);
  leaveCurrentRoom(socket);

  if (code) {
    send(socket, {
      type: "session.left",
      payload: { code }
    });
  }
}

function joinRoom(socket, room, displayName) {
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

function handleMessage(socket, message) {
  switch (message.type) {
    case "session.create": {
      const code = createSessionCode();
      const room = {
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

      joinRoom(socket, room, message.payload?.displayName);
      return;
    }

    case "session.leave":
      leaveRoomByRequest(socket);
      return;

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

module.exports = {
  startSessionRelay
};
