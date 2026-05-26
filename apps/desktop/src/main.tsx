import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ClientMessage, ServerMessage } from "@mixerlink/protocol";
import {
  compareCompatibilitySnapshots,
  type BridgeState,
  type BridgeOperation,
  type CompatibilityComparison,
  type CompatibilitySnapshot,
  type SessionState
} from "@mixerlink/shared";
import "./styles.css";

const defaultRelayUrl = "ws://localhost:4317";

type FlBridgeStatus = {
  installed: boolean;
  scriptOutdated?: boolean;
  installPath: string;
  legacyInstalled?: boolean;
  legacyInstallPath?: string;
  commandPath?: string;
  runtimePath?: string;
  bridgeUrl: string;
  runtime?: FlBridgeRuntime;
};

type FlBridgeRuntime = {
  connected: boolean;
  lastSeenAt?: string;
  playing?: boolean;
  tempoBpm?: number;
  script?: string;
};

type LocalBridgeChange = {
  operation: BridgeOperation;
  receivedAt: string;
};

const mockCompatibilitySnapshot: CompatibilitySnapshot = {
  clientVersion: "0.1.0",
  daw: {
    name: "FL Studio",
    version: "21.2 mock scan",
    executablePath: "C:\\Program Files\\Image-Line\\FL Studio 21\\FL64.exe"
  },
  projectFiles: [
    {
      name: "Demo Session.flp",
      path: "C:\\Users\\Producer\\Documents\\Image-Line\\FL Studio\\Projects\\Demo Session.flp",
      type: "project",
      source: "user-data"
    }
  ],
  plugins: [
    {
      name: "Fruity Parametric EQ 2",
      vendor: "Image-Line",
      format: "other"
    },
    {
      name: "FLEX",
      vendor: "Image-Line",
      format: "other"
    },
    {
      name: "Serum",
      vendor: "Xfer Records",
      format: "vst3"
    }
  ],
  missingPlugins: [
    {
      name: "Valhalla VintageVerb",
      vendor: "Valhalla DSP"
    }
  ]
};

function App() {
  const socketRef = useRef<WebSocket | null>(null);
  const appliedBridgeOperationRef = useRef<string | null>(null);
  const [sessionMode, setSessionMode] = useState<"start" | "join">("start");
  const [displayName, setDisplayName] = useState(() => localStorage.getItem("mixerlink.displayName") ?? "Producer");
  const [relayUrl, setRelayUrl] = useState(() => localStorage.getItem("mixerlink.relayUrl") ?? defaultRelayUrl);
  const [relayInput, setRelayInput] = useState(relayUrl);
  const [localRelayUrls, setLocalRelayUrls] = useState<string[]>([defaultRelayUrl]);
  const [joinCode, setJoinCode] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "connected" | "offline">("connecting");
  const [session, setSession] = useState<SessionState | null>(null);
  const [ownCollaboratorId, setOwnCollaboratorId] = useState<string | null>(null);
  const [notice, setNotice] = useState("Start or join a session when the relay is running.");
  const [copiedSessionCode, setCopiedSessionCode] = useState(false);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [isScanningCompatibility, setIsScanningCompatibility] = useState(false);
  const [customFlStudioFolders, setCustomFlStudioFolders] = useState<string[]>([]);
  const [userDataFolders, setUserDataFolders] = useState<string[]>([]);
  const [projectFolders, setProjectFolders] = useState<string[]>([]);
  const [customPluginFolders, setCustomPluginFolders] = useState<string[]>([]);
  const [localSnapshot, setLocalSnapshot] = useState<CompatibilitySnapshot | null>(null);
  const [bridgeTempoInput, setBridgeTempoInput] = useState("120");
  const [localBridgeState, setLocalBridgeState] = useState<BridgeState>({ transport: "stopped", tempoBpm: 120 });
  const [localBridgeLastChange, setLocalBridgeLastChange] = useState<LocalBridgeChange | null>(null);
  const [flBridgeStatus, setFlBridgeStatus] = useState<FlBridgeStatus | null>(null);
  const [flBridgeRuntime, setFlBridgeRuntime] = useState<FlBridgeRuntime | null>(null);
  const [isDetectionOpen, setIsDetectionOpen] = useState(false);

  useEffect(() => {
    let isCurrentSocket = true;
    setConnectionStatus("connecting");
    setSession(null);
    setOwnCollaboratorId(null);
    setNotice(`Connecting to ${relayUrl}...`);

    const socket = new WebSocket(relayUrl);
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      if (!isCurrentSocket) {
        return;
      }

      setConnectionStatus("connected");
      setNotice(`Connected to ${relayUrl}.`);
    });

    socket.addEventListener("close", () => {
      if (!isCurrentSocket) {
        return;
      }

      setConnectionStatus("offline");
      setNotice(`Relay offline at ${relayUrl}. Check the address and firewall, then retry.`);
    });

    socket.addEventListener("message", (event) => {
      if (!isCurrentSocket) {
        return;
      }

      let message: ServerMessage;

      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        setNotice("Relay sent a message MixerLink could not read.");
        return;
      }

      switch (message.type) {
        case "server.hello":
          setNotice(message.payload.message);
          break;
        case "session.created":
          setJoinCode(message.payload.code);
          setNotice(`Session ${message.payload.code} created.`);
          break;
        case "session.joined":
          setOwnCollaboratorId(message.payload.collaboratorId);
          setNotice(`Joined session ${message.payload.code}.`);
          break;
        case "session.state":
          setSession(message.payload);
          setIsCreatingSession(false);
          break;
        case "session.left":
          setSession(null);
          setOwnCollaboratorId(null);
          setNotice(`Left session ${message.payload.code}.`);
          break;
        case "session.error":
          setIsCreatingSession(false);
          setNotice(message.payload.message);
          break;
      }
    });

    return () => {
      isCurrentSocket = false;
      socket.close();
    };
  }, [relayUrl]);

  useEffect(() => {
    localStorage.setItem("mixerlink.displayName", displayName);
  }, [displayName]);

  useEffect(() => {
    localStorage.setItem("mixerlink.relayUrl", relayUrl);
  }, [relayUrl]);

  useEffect(() => {
    const tempoBpm = session?.bridge.tempoBpm ?? localBridgeState.tempoBpm;

    if (tempoBpm) {
      setBridgeTempoInput(String(tempoBpm));
    }
  }, [localBridgeState.tempoBpm, session?.bridge.tempoBpm]);

  useEffect(() => {
    const mixerlink = window.mixerlink;

    if (!mixerlink) {
      return;
    }

    Promise.all([
      mixerlink.getLocalRelayUrls(),
      mixerlink.getCustomFlStudioFolders(),
      mixerlink.getUserDataFolders(),
      mixerlink.getProjectFolders(),
      mixerlink.getCustomPluginFolders(),
      mixerlink.getFlBridgeStatus()
    ])
      .then(async ([
        nextLocalRelayUrls,
        nextFlStudioFolders,
        nextUserDataFolders,
        nextProjectFolders,
        nextPluginFolders,
        nextFlBridgeStatus
      ]) => {
        setLocalRelayUrls(nextLocalRelayUrls);
        setCustomFlStudioFolders(nextFlStudioFolders);
        setUserDataFolders(nextUserDataFolders);
        setProjectFolders(nextProjectFolders);
        setCustomPluginFolders(nextPluginFolders);

        if (!nextFlBridgeStatus.installed || nextFlBridgeStatus.scriptOutdated) {
          try {
            const installedStatus = await mixerlink.installFlBridgeScript();
            setFlBridgeStatus(installedStatus);
            setFlBridgeRuntime(installedStatus.runtime ?? null);
            setLocalBridgeState((state) => applyFlBridgeRuntimeToState(state, installedStatus.runtime));
            setNotice(
              nextFlBridgeStatus.scriptOutdated
                ? "MixerLink Bridge script updated. Restart FL Studio once to load the new bridge."
                : "MixerLink Bridge script installed. Select 'MixerLink Bridge' in FL Studio MIDI settings."
            );
            return;
          } catch {
            setFlBridgeStatus(nextFlBridgeStatus);
            setFlBridgeRuntime(nextFlBridgeStatus.runtime ?? null);
            return;
          }
        }

        setFlBridgeStatus(nextFlBridgeStatus);
        setFlBridgeRuntime(nextFlBridgeStatus.runtime ?? null);
        setLocalBridgeState((state) => applyFlBridgeRuntimeToState(state, nextFlBridgeStatus.runtime));
      })
      .catch(() => {
        setLocalRelayUrls([defaultRelayUrl]);
        setCustomFlStudioFolders([]);
        setUserDataFolders([]);
        setProjectFolders([]);
        setCustomPluginFolders([]);
        setFlBridgeStatus(null);
        setFlBridgeRuntime(null);
      });
  }, []);

  useEffect(() => {
    if (!window.mixerlink?.onFlBridgeRuntime) {
      return;
    }

    return window.mixerlink.onFlBridgeRuntime((runtime) => {
      setFlBridgeRuntime(runtime);
      setLocalBridgeState((state) => applyFlBridgeRuntimeToState(state, runtime));
    });
  }, []);

  useEffect(() => {
    if (!window.mixerlink?.getFlBridgeRuntime) {
      return;
    }

    const interval = window.setInterval(() => {
      window.mixerlink?.getFlBridgeRuntime()
        .then((runtime) => {
          setFlBridgeRuntime(runtime);
          setLocalBridgeState((state) => applyFlBridgeRuntimeToState(state, runtime));
        })
        .catch(() => undefined);
    }, 1500);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!window.mixerlink?.onBridgeOperationFromFl) {
      return;
    }

    return window.mixerlink.onBridgeOperationFromFl((operation) => {
      setLocalBridgeState((state) => applyBridgeOperationToState(state, operation));
      setLocalBridgeLastChange({ operation, receivedAt: new Date().toISOString() });

      if (socketRef.current?.readyState !== WebSocket.OPEN) {
        setNotice(`FL Studio ${describeBridgeOperation(operation)} locally. Join a room to share it.`);
        return;
      }

      socketRef.current.send(
        JSON.stringify({
          type: "bridge.operation",
          payload: operation
        } satisfies ClientMessage)
      );
      setNotice(`FL Studio sent ${operation.type} to the room.`);
    });
  }, []);

  useEffect(() => {
    if (!session?.bridge.lastOperation || session.bridge.lastOperation.collaboratorId === ownCollaboratorId) {
      return;
    }

    const operation = createBridgeOperationFromState(session);
    const operationKey = `${session.bridge.lastOperation.createdAt}:${session.bridge.lastOperation.type}`;

    if (!operation || appliedBridgeOperationRef.current === operationKey) {
      return;
    }

    appliedBridgeOperationRef.current = operationKey;
    queueBridgeOperationForFl(operation);
  }, [ownCollaboratorId, session]);

  const canSend = connectionStatus === "connected";
  const collaboratorCount = useMemo(() => session?.collaborators.length ?? 0, [session]);
  const hasSharedCompatibility = Boolean(ownCollaboratorId && session?.compatibility[ownCollaboratorId]);
  const canControlBridge = Boolean(window.mixerlink) || (canSend && Boolean(session));
  const compatibilityReports = useMemo(() => {
    if (!session || !ownCollaboratorId) {
      return [];
    }

    const ownSnapshot = session.compatibility[ownCollaboratorId];
    if (!ownSnapshot) {
      return [];
    }

    return session.collaborators
      .filter((collaborator) => collaborator.id !== ownCollaboratorId)
      .map((collaborator) => {
        const otherSnapshot = session.compatibility[collaborator.id];

        return {
          collaborator,
          comparison: otherSnapshot
            ? compareCompatibilitySnapshots(ownCollaboratorId, ownSnapshot, collaborator.id, otherSnapshot)
            : undefined
        };
      });
  }, [ownCollaboratorId, session]);

  function send(message: ClientMessage) {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      setNotice("Relay is not connected yet.");
      return;
    }

    socketRef.current.send(JSON.stringify(message));
  }

  function normalizeRelayUrl(value: string) {
    const trimmed = value.trim();
    const candidate = /^wss?:\/\//i.test(trimmed) ? trimmed : `ws://${trimmed}`;
    const parsed = new URL(candidate);

    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new Error("Relay address must use ws:// or wss://.");
    }

    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  }

  function applyRelayUrl() {
    try {
      const nextRelayUrl = normalizeRelayUrl(relayInput);
      setRelayInput(nextRelayUrl);

      if (nextRelayUrl === relayUrl) {
        setNotice(`Already using ${nextRelayUrl}.`);
        return;
      }

      setRelayUrl(nextRelayUrl);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Relay address is not valid.");
    }
  }

  async function copyRelayUrl(url: string) {
    await navigator.clipboard.writeText(url);
    setNotice(`Copied ${url}. Share this with your collaborator if you are hosting.`);
  }

  function createSession() {
    setIsCreatingSession(true);
    window.setTimeout(() => setIsCreatingSession(false), 1800);
    send({
      type: "session.create",
      payload: {
        displayName
      }
    });
  }

  function joinSession() {
    send({
      type: "session.join",
      payload: {
        code: joinCode,
        displayName
      }
    });
  }

  function sendBridgeOperation(operation: BridgeOperation) {
    if (socketRef.current?.readyState === WebSocket.OPEN && session) {
      socketRef.current.send(
        JSON.stringify({
          type: "bridge.operation",
          payload: operation
        } satisfies ClientMessage)
      );
    }

    queueBridgeOperationForFl(operation);
  }

  async function queueBridgeOperationForFl(operation: BridgeOperation) {
    try {
      const queued = await window.mixerlink?.queueBridgeOperation(operation);
      setNotice(
        queued
          ? `Queued ${operation.type} for FL Studio${session ? " and sent it to the room" : ""}.`
          : `Sent ${operation.type} to the room.`
      );
    } catch {
      setNotice("MixerLink could not queue that operation for the local FL bridge.");
    }
  }

  async function installFlBridgeScript() {
    if (!window.mixerlink) {
      setNotice("FL Studio bridge installation is available in the desktop app.");
      return;
    }

    try {
      const status = await window.mixerlink.installFlBridgeScript();
      setFlBridgeStatus(status);
      setFlBridgeRuntime(status.runtime ?? null);
      setLocalBridgeState((state) => applyFlBridgeRuntimeToState(state, status.runtime));
      setNotice("MixerLink Bridge script installed. Select 'MixerLink Bridge' in FL Studio MIDI settings.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "MixerLink could not install the FL Studio bridge script.");
    }
  }

  function syncTempo() {
    const bpm = Math.round(Number(bridgeTempoInput));

    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) {
      setNotice("Tempo must be between 20 and 300 BPM.");
      return;
    }

    sendBridgeOperation({
      type: "tempo.changed",
      payload: { bpm }
    });
  }

  async function scanLocalCompatibility() {
    setIsScanningCompatibility(true);

    try {
      const snapshot = window.mixerlink
        ? await window.mixerlink.scanCompatibility()
        : mockCompatibilitySnapshot;

      setLocalSnapshot(snapshot);
      setNotice(
        window.mixerlink
          ? `Scan found ${snapshot.plugins.length} plugins and ${snapshot.projectFiles?.length ?? 0} project files.`
          : "Browser preview scanned mock compatibility data."
      );
      return snapshot;
    } catch (error) {
      setNotice(
        `Compatibility scan failed: ${error instanceof Error ? error.message : "MixerLink could not read local plugin folders."}`
      );
      return undefined;
    } finally {
      setIsScanningCompatibility(false);
    }
  }

  async function shareCompatibility() {
    const snapshot = localSnapshot ?? (await scanLocalCompatibility());

    if (!snapshot) {
      return;
    }

    try {
      send({
        type: "compatibility.update",
        payload: snapshot
      });
      setNotice(
        window.mixerlink
          ? `Scan found ${snapshot.plugins.length} plugins and ${snapshot.projectFiles?.length ?? 0} project files.`
          : "Browser preview shared mock compatibility data."
      );
    } catch (error) {
      setNotice(`Compatibility share failed: ${error instanceof Error ? error.message : "Relay rejected the snapshot."}`);
    }
  }

  async function launchFlStudio() {
    if (!window.mixerlink) {
      setNotice("FL Studio launch is available in the desktop app.");
      return;
    }

    try {
      await window.mixerlink.launchFlStudio(localSnapshot?.daw?.executablePath);
      setNotice("FL Studio launch requested.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "FL Studio could not be launched.");
    }
  }

  async function openProject(projectPath: string) {
    if (!window.mixerlink) {
      setNotice("Project launch is available in the desktop app.");
      return;
    }

    try {
      await window.mixerlink.openProjectInFlStudio({
        projectPath,
        executablePath: localSnapshot?.daw?.executablePath
      });
      setNotice("Project open requested in FL Studio.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Project could not be opened.");
    }
  }

  async function revealPath(targetPath: string) {
    if (!window.mixerlink) {
      return;
    }

    try {
      await window.mixerlink.revealPath(targetPath);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Path could not be shown.");
    }
  }

  async function addPluginFolder() {
    if (!window.mixerlink) {
      setNotice("Folder settings are available in the desktop app.");
      return;
    }

    const folders = await window.mixerlink.addCustomPluginFolder();
    setCustomPluginFolders(folders);
    setNotice(folders.length > 0 ? "Custom plugin folder list updated." : "No custom plugin folder selected.");
  }

  async function removePluginFolder(folder: string) {
    if (!window.mixerlink) {
      return;
    }

    const folders = await window.mixerlink.removeCustomPluginFolder(folder);
    setCustomPluginFolders(folders);
    setNotice("Custom plugin folder removed.");
  }

  async function addFlStudioFolder() {
    if (!window.mixerlink) {
      setNotice("Folder settings are available in the desktop app.");
      return;
    }

    const folders = await window.mixerlink.addCustomFlStudioFolder();
    setCustomFlStudioFolders(folders);
    setNotice(folders.length > 0 ? "FL Studio folder list updated." : "No FL Studio folder selected.");
  }

  async function removeFlStudioFolder(folder: string) {
    if (!window.mixerlink) {
      return;
    }

    const folders = await window.mixerlink.removeCustomFlStudioFolder(folder);
    setCustomFlStudioFolders(folders);
    setNotice("FL Studio folder removed.");
  }

  async function addUserDataFolder() {
    if (!window.mixerlink) {
      setNotice("Folder settings are available in the desktop app.");
      return;
    }

    const folders = await window.mixerlink.addUserDataFolder();
    setUserDataFolders(folders);
    setNotice(folders.length > 0 ? "User data folder list updated." : "No user data folder selected.");
  }

  async function removeUserDataFolder(folder: string) {
    if (!window.mixerlink) {
      return;
    }

    const folders = await window.mixerlink.removeUserDataFolder(folder);
    setUserDataFolders(folders);
    setNotice("User data folder removed.");
  }

  async function addProjectFolder() {
    if (!window.mixerlink) {
      setNotice("Folder settings are available in the desktop app.");
      return;
    }

    const folders = await window.mixerlink.addProjectFolder();
    setProjectFolders(folders);
    setNotice(folders.length > 0 ? "Project folder list updated." : "No project folder selected.");
  }

  async function removeProjectFolder(folder: string) {
    if (!window.mixerlink) {
      return;
    }

    const folders = await window.mixerlink.removeProjectFolder(folder);
    setProjectFolders(folders);
    setNotice("Project folder removed.");
  }

  function leaveSession() {
    send({
      type: "session.leave"
    });
  }

  async function copySessionCode() {
    if (!session) {
      return;
    }

    await navigator.clipboard.writeText(session.code);
    setCopiedSessionCode(true);
    window.setTimeout(() => setCopiedSessionCode(false), 1400);
  }

  const sessionControls = (
    <section className="control-panel">
      <div className="panel-heading">
        <h2>{session ? "Room" : "Start"}</h2>
        <span>{sessionMode}</span>
      </div>
      <div className="mode-tabs" role="tablist" aria-label="Session mode">
        <button
          type="button"
          className={`create-tab ${sessionMode === "start" ? "active" : ""}`}
          role="tab"
          aria-selected={sessionMode === "start"}
          onClick={() => setSessionMode("start")}
        >
          Create
        </button>
        <button
          type="button"
          className={`join-tab ${sessionMode === "join" ? "active" : ""}`}
          role="tab"
          aria-selected={sessionMode === "join"}
          onClick={() => setSessionMode("join")}
        >
          Join
        </button>
      </div>
      <div className={`mode-content ${isCreatingSession ? "creating" : ""}`} key={sessionMode}>
        <div className="session-form">
          <label>
            Display name
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </label>
          <label>
            Relay address
            <span className="relay-input-row">
              <input
                spellCheck={false}
                value={relayInput}
                onChange={(event) => setRelayInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    applyRelayUrl();
                  }
                }}
              />
              <button type="button" className="secondary compact" onClick={applyRelayUrl}>
                Connect
              </button>
            </span>
          </label>
          {localRelayUrls.length > 0 ? (
            <div className="relay-address-list">
              <span>Your relay addresses</span>
              <div>
                {localRelayUrls.map((url) => (
                  <button
                    type="button"
                    className={url === relayUrl ? "active" : ""}
                    key={url}
                    onClick={() => {
                      setRelayInput(url);
                      setRelayUrl(url);
                    }}
                    onDoubleClick={() => copyRelayUrl(url)}
                    title="Click to use this relay. Double-click to copy it."
                  >
                    {url}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {(sessionMode === "join" || session) ? (
            <label>
              Session code
              <span className="code-input-row">
                <input
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="123456"
                  readOnly={sessionMode === "start" && Boolean(session)}
                  value={session?.code ?? joinCode}
                  onChange={(event) => setJoinCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                />
                {session ? (
                  <button
                    type="button"
                    className="copy-icon-button"
                    aria-label={copiedSessionCode ? "Session code copied" : "Copy session code"}
                    title={copiedSessionCode ? "Copied" : "Copy session code"}
                    onClick={copySessionCode}
                  >
                    <span aria-hidden="true" />
                  </button>
                ) : null}
              </span>
            </label>
          ) : null}
        </div>
        <div className="actions">
          {sessionMode === "start" ? (
            <button
              type="button"
              className={isCreatingSession ? "starting-session" : ""}
              disabled={!canSend || isCreatingSession}
              onClick={createSession}
            >
              {isCreatingSession ? "Creating..." : "Start Session"}
            </button>
          ) : (
            <button type="button" disabled={!canSend || joinCode.length !== 6} onClick={joinSession}>
              Join Session
            </button>
          )}
          <button
            type="button"
            className="secondary"
            disabled={isScanningCompatibility}
            onClick={scanLocalCompatibility}
          >
            {isScanningCompatibility ? "Scanning..." : "Scan Local Setup"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!canSend || !session || isScanningCompatibility}
            onClick={shareCompatibility}
          >
            {isScanningCompatibility
              ? "Scanning..."
              : hasSharedCompatibility
                ? "Refresh Compatibility"
                : "Share Compatibility"}
          </button>
          {session ? (
            <button type="button" className="secondary danger" disabled={!canSend} onClick={leaveSession}>
              Leave Session
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );

  const detectionPanel = (
    <aside className={`folder-panel detection-drawer ${isDetectionOpen ? "open" : ""}`} aria-hidden={!isDetectionOpen}>
      <div className="panel-heading">
        <h2>Detection</h2>
        <button type="button" className="secondary compact" onClick={() => setIsDetectionOpen(false)}>
          Close
        </button>
      </div>
      <div className="folder-manager">
        <FolderPicker
          title="FL Studio"
          emptyText="No custom FL Studio folders added."
          folders={customFlStudioFolders}
          addLabel="Add FL Studio Folder"
          onAdd={addFlStudioFolder}
          onRemove={removeFlStudioFolder}
        />
        <FolderPicker
          title="User data"
          emptyText="No user data folders added."
          folders={userDataFolders}
          addLabel="Add User Data Folder"
          onAdd={addUserDataFolder}
          onRemove={removeUserDataFolder}
        />
        <FolderPicker
          title="Projects"
          emptyText="No project folders added."
          folders={projectFolders}
          addLabel="Add Project Folder"
          onAdd={addProjectFolder}
          onRemove={removeProjectFolder}
        />
        <FolderPicker
          title="Plugins"
          emptyText="No custom plugin folders added."
          folders={customPluginFolders}
          addLabel="Add Plugin Folder"
          onAdd={addPluginFolder}
          onRemove={removePluginFolder}
        />
      </div>
    </aside>
  );

  if (!session) {
    return (
      <main className="app-shell lobby-mode">
        <div className="animated-stage" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
        <section className="lobby-layout">
          <div className="lobby-hero">
            <p className="eyebrow logo-wordmark">MixerLink</p>
            <h1>Collaborative control for FL Studio sessions</h1>
            <p className="lobby-copy">Create a room, connect FL Studio, and keep transport and compatibility in one focused workspace.</p>
            <div className="lobby-status-row">
              <span className={`connection-pill ${connectionStatus}`}>{connectionStatus}</span>
              <span>{flBridgeStatus?.installed ? "MIDI bridge ready" : "FL bridge pending"}</span>
            </div>
          </div>
          <div className="lobby-card">
            {sessionControls}
          </div>
          <div className="lobby-side">
            <p className="notice-line">{notice}</p>
            <FlStatePanel
              localBridgeState={localBridgeState}
              lastChange={localBridgeLastChange}
              flBridgeRuntime={flBridgeRuntime}
            />
            <LocalIntegrationPanel
              snapshot={localSnapshot}
              isScanning={isScanningCompatibility}
              onScan={scanLocalCompatibility}
              onLaunchFlStudio={launchFlStudio}
              onOpenProject={openProject}
              onRevealPath={revealPath}
            />
            <button type="button" className="secondary" onClick={() => setIsDetectionOpen(true)}>
              Detection Folders
            </button>
          </div>
        </section>
        {isDetectionOpen ? <button type="button" className="drawer-backdrop" aria-label="Close detection" onClick={() => setIsDetectionOpen(false)} /> : null}
        {detectionPanel}
      </main>
    );
  }

  return (
    <main className="app-shell session-mode">
      <div className="animated-stage" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
      <header className="app-header">
        <div className="top-line">
          <div>
            <p className="eyebrow logo-wordmark">MixerLink</p>
            <h1>Room {session.code}</h1>
          </div>
          <div className="header-status">
            <span className={`connection-pill ${connectionStatus}`}>{connectionStatus}</span>
            <span>{collaboratorCount} connected</span>
            <button type="button" className="secondary compact" onClick={() => setIsDetectionOpen(true)}>
              Detection
            </button>
          </div>
        </div>
      </header>
      <div className="session-workspace">
        <aside className="session-rail">
          {sessionControls}
        </aside>
        <section className="status-panel session-live">
          <div className="panel-heading">
            <h2>Session Workspace</h2>
            <span>{Object.keys(session.compatibility).length} shared</span>
          </div>
          <p className="notice-line">{notice}</p>
          <div className="session-panels">
            <LocalIntegrationPanel
              snapshot={localSnapshot}
              isScanning={isScanningCompatibility}
              onScan={scanLocalCompatibility}
              onLaunchFlStudio={launchFlStudio}
              onOpenProject={openProject}
              onRevealPath={revealPath}
            />
            <BridgeControlPanel
              canControl={canControlBridge}
              flBridgeStatus={flBridgeStatus}
              flBridgeRuntime={flBridgeRuntime}
              tempoInput={bridgeTempoInput}
              onTempoInputChange={setBridgeTempoInput}
              onPlay={() => sendBridgeOperation({ type: "transport.play" })}
              onStop={() => sendBridgeOperation({ type: "transport.stop" })}
              onSyncTempo={syncTempo}
              onInstallBridge={installFlBridgeScript}
            />
            <FlStatePanel
              localBridgeState={localBridgeState}
              lastChange={localBridgeLastChange}
              sessionBridgeState={session.bridge}
              flBridgeRuntime={flBridgeRuntime}
            />
          </div>
          <div className="session-grid">
            <section className="session-section">
              <div className="section-heading">
                <h3>Collaborators</h3>
                <span>{session.collaborators.length}</span>
              </div>
              <ul className="collaborator-list">
                {session.collaborators.map((collaborator) => {
                  const compatibility = session.compatibility[collaborator.id];

                  return (
                    <li key={collaborator.id}>
                      <div>
                        <span>
                          {collaborator.displayName}
                          {collaborator.id === ownCollaboratorId ? " (you)" : ""}
                        </span>
                        <small>
                          {compatibility
                            ? `${compatibility.plugins.length} plugins shared`
                            : "waiting for compatibility"}
                        </small>
                      </div>
                      <strong>{collaborator.status}</strong>
                    </li>
                  );
                })}
              </ul>
            </section>
            <section className="session-section">
              <div className="section-heading">
                <h3>Compatibility</h3>
                <span>{Object.keys(session.compatibility).length} shared</span>
              </div>
              {ownCollaboratorId && session.compatibility[ownCollaboratorId] ? (
                <CompatibilityReportList reports={compatibilityReports} />
              ) : (
                <p className="empty-compatibility">Share your compatibility scan to compare with collaborators.</p>
              )}
              <div className="compatibility-list">
                {session.collaborators.map((collaborator) => {
                  const compatibility = session.compatibility[collaborator.id];

                  return (
                    <article key={collaborator.id} className="compatibility-card">
                      <div className="compatibility-card-heading">
                        <span>{collaborator.displayName}</span>
                        <small>{compatibility ? "snapshot shared" : "pending"}</small>
                      </div>
                      {compatibility ? (
                        <>
                          <p>{compatibility.daw?.name ?? "DAW unknown"} / {compatibility.daw?.version ?? "version unknown"}</p>
                          {compatibility.scan ? (
                            <div className="scan-details">
                              <p>
                                {compatibility.scan.pluginFolders.length} plugin folders /{" "}
                                {compatibility.scan.projectFolders.length + compatibility.scan.userDataFolders.length} file folders /{" "}
                                {compatibility.scan.warnings.length} warnings
                              </p>
                              {compatibility.daw ? (
                                <p>{compatibility.daw.version ? `FL Studio ${compatibility.daw.version}` : "FL Studio"} detected</p>
                              ) : null}
                              {compatibility.scan.customPluginFolders.length > 0 ? (
                                <p>{compatibility.scan.customPluginFolders.length} custom folders included</p>
                              ) : null}
                              {compatibility.projectFiles && compatibility.projectFiles.length > 0 ? (
                                <details>
                                  <summary>Project files</summary>
                                  <ul>
                                    {compatibility.projectFiles.slice(0, 40).map((file) => (
                                      <li key={file.path}>{file.name} ({file.type})</li>
                                    ))}
                                  </ul>
                                </details>
                              ) : null}
                              {compatibility.scan.pluginFolders.length > 0 ? (
                                <details>
                                  <summary>Scanned folders</summary>
                                  <ul>
                                    {compatibility.scan.flStudioFolders.map((folder) => (
                                      <li key={folder}>{folder}</li>
                                    ))}
                                    {compatibility.scan.userDataFolders.map((folder) => (
                                      <li key={folder}>{folder}</li>
                                    ))}
                                    {compatibility.scan.projectFolders.map((folder) => (
                                      <li key={folder}>{folder}</li>
                                    ))}
                                    {compatibility.scan.pluginFolders.map((folder) => (
                                      <li key={folder}>{folder}</li>
                                    ))}
                                  </ul>
                                </details>
                              ) : null}
                              {compatibility.scan.warnings.length > 0 ? (
                                <details>
                                  <summary>Warnings</summary>
                                  <ul>
                                    {compatibility.scan.warnings.map((warning) => (
                                      <li key={warning}>{warning}</li>
                                    ))}
                                  </ul>
                                </details>
                              ) : null}
                            </div>
                          ) : null}
                          <ul className="plugin-pill-list">
                            {compatibility.plugins.map((plugin) => (
                              <li
                                key={`${collaborator.id}-${plugin.name}-${plugin.path ?? ""}`}
                                className={plugin.source === "custom" ? "custom" : "matched"}
                                title={plugin.path}
                              >
                                {plugin.name}
                                {plugin.version ? ` ${plugin.version}` : ""}
                              </li>
                            ))}
                            {(compatibility.missingPlugins ?? []).map((plugin) => (
                              <li key={`${collaborator.id}-${plugin.name}`} className="missing">{plugin.name}</li>
                            ))}
                          </ul>
                        </>
                      ) : (
                        <p>No compatibility data yet.</p>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
            <section className="session-section activity-section">
              <div className="section-heading">
                <h3>Activity</h3>
                <span>{session.activity.length}</span>
              </div>
              <ol className="activity-feed">
                {session.activity.map((event) => (
                  <li key={event.id}>
                    <span>{event.message}</span>
                    <time dateTime={event.createdAt}>
                      {new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </time>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        </section>
      </div>
      {isDetectionOpen ? <button type="button" className="drawer-backdrop" aria-label="Close detection" onClick={() => setIsDetectionOpen(false)} /> : null}
      {detectionPanel}
    </main>
  );

}

function createBridgeOperationFromState(session: SessionState): BridgeOperation | undefined {
  switch (session.bridge.lastOperation?.type) {
    case "transport.play":
      return { type: "transport.play" };
    case "transport.stop":
      return { type: "transport.stop" };
    case "tempo.changed":
      return {
        type: "tempo.changed",
        payload: {
          bpm: session.bridge.tempoBpm
        }
      };
    default:
      return undefined;
  }
}

function applyFlBridgeRuntimeToState(state: BridgeState, runtime?: FlBridgeRuntime | null): BridgeState {
  return {
    transport: typeof runtime?.playing === "boolean" ? (runtime.playing ? "playing" : "stopped") : state.transport,
    tempoBpm: typeof runtime?.tempoBpm === "number" ? Math.round(runtime.tempoBpm) : state.tempoBpm,
    lastOperation: state.lastOperation
  };
}

function applyBridgeOperationToState(state: BridgeState, operation: BridgeOperation): BridgeState {
  switch (operation.type) {
    case "transport.play":
      return {
        ...state,
        transport: "playing"
      };
    case "transport.stop":
      return {
        ...state,
        transport: "stopped"
      };
    case "tempo.changed":
      return {
        ...state,
        tempoBpm: Math.round(Number(operation.payload.bpm))
      };
    default:
      return state;
  }
}

function describeBridgeOperation(operation: BridgeOperation): string {
  switch (operation.type) {
    case "transport.play":
      return "started playback";
    case "transport.stop":
      return "stopped playback";
    case "tempo.changed":
      return `set tempo to ${Math.round(Number(operation.payload.bpm))} BPM`;
    default:
      return "updated the bridge";
  }
}

function formatBridgeTimestamp(value?: string): string {
  if (!value) {
    return "Waiting";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Waiting";
  }

  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function FlStatePanel({
  localBridgeState,
  lastChange,
  sessionBridgeState,
  flBridgeRuntime
}: {
  localBridgeState: BridgeState;
  lastChange?: LocalBridgeChange | null;
  sessionBridgeState?: BridgeState;
  flBridgeRuntime: FlBridgeRuntime | null;
}) {
  const flConnected = Boolean(flBridgeRuntime?.connected);
  const sessionMatches =
    !sessionBridgeState ||
    (sessionBridgeState.transport === localBridgeState.transport && sessionBridgeState.tempoBpm === localBridgeState.tempoBpm);

  return (
    <section className="fl-state-panel">
      <div className="section-heading">
        <h3>FL Studio State</h3>
        <span>{flConnected ? "receiving" : "waiting"}</span>
      </div>
      <dl className="bridge-metrics">
        <div>
          <dt>Transport</dt>
          <dd>{localBridgeState.transport}</dd>
        </div>
        <div>
          <dt>Tempo</dt>
          <dd>{localBridgeState.tempoBpm} BPM</dd>
        </div>
        <div>
          <dt>Last Seen</dt>
          <dd>{formatBridgeTimestamp(flBridgeRuntime?.lastSeenAt)}</dd>
        </div>
      </dl>
      <div className="fl-state-change">
        <span>{lastChange ? describeBridgeOperation(lastChange.operation) : "No FL changes received yet"}</span>
        <time dateTime={lastChange?.receivedAt}>{formatBridgeTimestamp(lastChange?.receivedAt)}</time>
      </div>
      {sessionBridgeState ? (
        <dl className="bridge-metrics compact">
          <div>
            <dt>Room Transport</dt>
            <dd>{sessionBridgeState.transport}</dd>
          </div>
          <div>
            <dt>Room Tempo</dt>
            <dd>{sessionBridgeState.tempoBpm} BPM</dd>
          </div>
          <div>
            <dt>Room Match</dt>
            <dd>{sessionMatches ? "yes" : "no"}</dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}

function BridgeControlPanel({
  canControl,
  flBridgeStatus,
  flBridgeRuntime,
  tempoInput,
  onTempoInputChange,
  onPlay,
  onStop,
  onSyncTempo,
  onInstallBridge
}: {
  canControl: boolean;
  flBridgeStatus: FlBridgeStatus | null;
  flBridgeRuntime: FlBridgeRuntime | null;
  tempoInput: string;
  onTempoInputChange: (value: string) => void;
  onPlay: () => void;
  onStop: () => void;
  onSyncTempo: () => void;
  onInstallBridge: () => void;
}) {
  const flConnected = Boolean(flBridgeRuntime?.connected);
  const midiReady = Boolean(flBridgeStatus?.installed);
  const bridgeStatusLabel = flConnected ? "FL online" : midiReady ? "MIDI ready" : "FL offline";

  return (
    <section className="bridge-panel">
      <div className="section-heading">
        <h3>Bridge Sync</h3>
        <span>{bridgeStatusLabel}</span>
      </div>
      <div className="bridge-install-row">
        <div>
          <strong>
            {flConnected
              ? `FL Studio connected${typeof flBridgeRuntime?.tempoBpm === "number" ? ` at ${flBridgeRuntime.tempoBpm} BPM` : ""}`
              : flBridgeStatus?.installed
                ? "MIDI bridge ready"
                : "FL script not installed"}
          </strong>
          <small>
            {flConnected
              ? `Loaded script: ${flBridgeRuntime?.script ?? "MixerLink Bridge"}`
              : flBridgeStatus?.installed
                ? "Commands are sent over MIDI; local FL transport and tempo changes sync back automatically."
                : "Install the bundled MIDI script, restart FL Studio, then select MixerLink Bridge in MIDI settings."}
          </small>
        </div>
        <button type="button" className="secondary compact" onClick={onInstallBridge}>
          {flBridgeStatus?.installed ? "Reinstall" : "Install"}
        </button>
      </div>
      <div className="transport-strip">
        <button type="button" disabled={!canControl} onClick={onPlay}>
          Play
        </button>
        <button type="button" className="secondary" disabled={!canControl} onClick={onStop}>
          Stop
        </button>
        <label>
          Tempo
          <span className="tempo-control">
            <input
              className="tempo-number-input"
              inputMode="numeric"
              max="300"
              min="20"
              step="1"
              type="number"
              value={tempoInput}
              onChange={(event) => onTempoInputChange(event.target.value.replace(/[^\d]/g, "").slice(0, 3))}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  onSyncTempo();
                }
              }}
            />
            <button type="button" className="secondary" disabled={!canControl} onClick={onSyncTempo}>
              Send Tempo
            </button>
          </span>
        </label>
      </div>
    </section>
  );
}

function LocalIntegrationPanel({
  snapshot,
  isScanning,
  onScan,
  onLaunchFlStudio,
  onOpenProject,
  onRevealPath
}: {
  snapshot: CompatibilitySnapshot | null;
  isScanning: boolean;
  onScan: () => void;
  onLaunchFlStudio: () => void;
  onOpenProject: (projectPath: string) => void;
  onRevealPath: (targetPath: string) => void;
}) {
  const projects = (snapshot?.projectFiles ?? []).filter((projectFile) => projectFile.type === "project");
  const latestProjects = projects.slice(0, 6);

  return (
    <section className="local-integration">
      <div className="section-heading">
        <h3>FL Studio</h3>
        <span>{snapshot?.daw ? "detected" : "local"}</span>
      </div>
      {snapshot ? (
        <>
          <div className="fl-detection-card">
            <div>
              <strong>{snapshot.daw?.version ? `FL Studio ${snapshot.daw.version}` : "FL Studio"}</strong>
              <small>{snapshot.daw?.path ?? "Install folder not detected"}</small>
            </div>
            <button type="button" className="secondary compact" onClick={onLaunchFlStudio}>
              Launch
            </button>
          </div>
          {latestProjects.length > 0 ? (
            <div className="project-launcher">
              <div className="section-heading compact-heading">
                <h3>Projects</h3>
                <span>{projects.length}</span>
              </div>
              <ul>
                {latestProjects.map((projectFile) => (
                  <li key={projectFile.path}>
                    <div>
                      <strong>{projectFile.name}</strong>
                      <small>{projectFile.path}</small>
                    </div>
                    <span className="project-actions">
                      <button type="button" className="secondary compact" onClick={() => onRevealPath(projectFile.path)}>
                        Show
                      </button>
                      <button type="button" className="compact" onClick={() => onOpenProject(projectFile.path)}>
                        Open
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="empty-compatibility">No `.flp` files found yet. Add a project folder or user data folder, then scan.</p>
          )}
        </>
      ) : (
        <div className="fl-detection-card empty">
          <div>
            <strong>Scan this machine</strong>
            <small>Find FL Studio, plugins, and project files before sharing a session.</small>
          </div>
          <button type="button" className="secondary compact" disabled={isScanning} onClick={onScan}>
            {isScanning ? "Scanning..." : "Scan"}
          </button>
        </div>
      )}
    </section>
  );
}

function FolderPicker({
  title,
  emptyText,
  folders,
  addLabel,
  onAdd,
  onRemove
}: {
  title: string;
  emptyText: string;
  folders: string[];
  addLabel: string;
  onAdd: () => void;
  onRemove: (folder: string) => void;
}) {
  return (
    <section className="folder-picker">
      <div className="folder-picker-heading">
        <h2>{title}</h2>
        <button type="button" className="secondary compact" onClick={onAdd}>
          {addLabel}
        </button>
      </div>
      {folders.length > 0 ? (
        <ul>
          {folders.map((folder) => (
            <li key={folder}>
              <span>{folder}</span>
              <button
                type="button"
                className="remove-folder-button"
                aria-label={`Remove ${folder}`}
                onClick={() => onRemove(folder)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>{emptyText}</p>
      )}
    </section>
  );
}

function CompatibilityReportList({
  reports
}: {
  reports: Array<{
    collaborator: SessionState["collaborators"][number];
    comparison?: CompatibilityComparison;
  }>;
}) {
  if (reports.length === 0) {
    return <p className="empty-compatibility">Waiting for another collaborator to join.</p>;
  }

  return (
    <div className="comparison-list">
      {reports.map(({ collaborator, comparison }) => {
        if (!comparison) {
          return (
            <article key={collaborator.id} className="comparison-card pending">
              <strong>{collaborator.displayName}</strong>
              <span>Waiting for their scan</span>
            </article>
          );
        }

        const issueCount =
          comparison.missing.length + comparison.versionMismatches.length + comparison.formatMismatches.length;

        return (
          <article key={collaborator.id} className={`comparison-card ${issueCount === 0 ? "ready" : "issues"}`}>
            <div>
              <strong>{collaborator.displayName}</strong>
              <span>{issueCount === 0 ? "Ready to open together" : `${issueCount} possible issues`}</span>
            </div>
            <dl>
              <div>
                <dt>Matched</dt>
                <dd>{comparison.sharedPluginCount}</dd>
              </div>
              <div>
                <dt>Missing</dt>
                <dd>{comparison.missing.length}</dd>
              </div>
              <div>
                <dt>Versions</dt>
                <dd>{comparison.versionMismatches.length}</dd>
              </div>
              <div>
                <dt>Formats</dt>
                <dd>{comparison.formatMismatches.length}</dd>
              </div>
            </dl>
            {issueCount > 0 ? (
              <details>
                <summary>View issues</summary>
                <ul>
                  {comparison.missing.slice(0, 8).map((issue) => (
                    <li key={`missing-${issue.pluginName}`}>{issue.pluginName} is missing for {collaborator.displayName}</li>
                  ))}
                  {comparison.versionMismatches.slice(0, 6).map((issue) => (
                    <li key={`version-${issue.pluginName}`}>
                      {issue.pluginName} version differs: you have {issue.ownerValue}, {collaborator.displayName} has{" "}
                      {issue.otherValue}
                    </li>
                  ))}
                  {comparison.formatMismatches.slice(0, 6).map((issue) => (
                    <li key={`format-${issue.pluginName}`}>
                      {issue.pluginName} format differs: you have {issue.ownerValue}, {collaborator.displayName} has{" "}
                      {issue.otherValue}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
