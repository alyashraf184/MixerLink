import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ClientMessage, ServerMessage } from "@mixerlink/protocol";
import {
  compareCompatibilitySnapshots,
  type CompatibilityComparison,
  type CompatibilitySnapshot,
  type SessionState
} from "@mixerlink/shared";
import "./styles.css";

const defaultRelayUrl = "ws://localhost:4317";

const mockCompatibilitySnapshot: CompatibilitySnapshot = {
  clientVersion: "0.1.0",
  daw: {
    name: "FL Studio",
    version: "21.2 mock scan"
  },
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

      const message = JSON.parse(event.data) as ServerMessage;

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
    if (!window.mixerlink) {
      return;
    }

    Promise.all([
      window.mixerlink.getLocalRelayUrls(),
      window.mixerlink.getCustomFlStudioFolders(),
      window.mixerlink.getUserDataFolders(),
      window.mixerlink.getProjectFolders(),
      window.mixerlink.getCustomPluginFolders()
    ])
      .then(([nextLocalRelayUrls, nextFlStudioFolders, nextUserDataFolders, nextProjectFolders, nextPluginFolders]) => {
        setLocalRelayUrls(nextLocalRelayUrls);
        setCustomFlStudioFolders(nextFlStudioFolders);
        setUserDataFolders(nextUserDataFolders);
        setProjectFolders(nextProjectFolders);
        setCustomPluginFolders(nextPluginFolders);
      })
      .catch(() => {
        setLocalRelayUrls([defaultRelayUrl]);
        setCustomFlStudioFolders([]);
        setUserDataFolders([]);
        setProjectFolders([]);
        setCustomPluginFolders([]);
      });
  }, []);

  const canSend = connectionStatus === "connected";
  const collaboratorCount = useMemo(() => session?.collaborators.length ?? 0, [session]);
  const hasSharedCompatibility = Boolean(ownCollaboratorId && session?.compatibility[ownCollaboratorId]);
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

  async function shareCompatibility() {
    setIsScanningCompatibility(true);

    try {
      const snapshot = window.mixerlink
        ? await window.mixerlink.scanCompatibility()
        : mockCompatibilitySnapshot;

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
      setNotice(
        `Compatibility scan failed: ${error instanceof Error ? error.message : "MixerLink could not read local plugin folders."}`
      );
    } finally {
      setIsScanningCompatibility(false);
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

  return (
    <main className="app-shell">
      <div className="starfield" aria-hidden="true">
        <span className="stars stars-small" />
        <span className="stars stars-medium" />
        <span className="stars stars-large" />
      </div>
      <section className="hero">
        <div className="top-line">
          <p className="eyebrow">MixerLink</p>
          <span className={`connection-pill ${connectionStatus}`}>{connectionStatus}</span>
        </div>
        <h1>Live collaboration for FL Studio sessions.</h1>
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
              disabled={!canSend || !session || isScanningCompatibility}
              onClick={shareCompatibility}
            >
              {isScanningCompatibility
                ? "Scanning..."
                : hasSharedCompatibility
                  ? "Refresh Compatibility"
                  : "Share Compatibility"}
            </button>
            <button type="button" className="secondary danger" disabled={!canSend || !session} onClick={leaveSession}>
              Leave Session
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
        </div>
      </section>
      <section className={`status-panel ${session ? "session-live" : ""}`}>
        <div className="panel-heading">
          <h2>{session ? `Session ${session.code}` : "Session Foundation"}</h2>
          <span>{collaboratorCount} connected</span>
        </div>
        <p>{notice}</p>
        {session ? (
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
        ) : null}
      </section>
    </main>
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
