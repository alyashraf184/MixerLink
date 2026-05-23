import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "@mixerlink/protocol";
import type { ActivityEvent, Collaborator, CompatibilitySnapshot, SessionCode, SessionState } from "@mixerlink/shared";

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

function createCollaborator(displayName: string): Collaborator {
  return {
    id: randomUUID(),
    displayName: normalizeDisplayName(displayName),
    joinedAt: new Date().toISOString(),
    status: "connected"
  };
}

function normalizeDisplayName(displayName: string): string {
  const normalized = displayName.trim();
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

function joinRoom(socket: WebSocket, room: Room, displayName: string): void {
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
        activity: []
      };

      rooms.set(code, room);
      addActivity(room, "session.created", `Session ${code} was created.`);
      send(socket, {
        type: "session.created",
        payload: { code }
      });
      joinRoom(socket, room, message.payload.displayName);
      return;
    }

    case "session.join": {
      const code = message.payload.code.trim();
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
