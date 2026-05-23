import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ClientMessage, ServerMessage } from "@mixerlink/protocol";
import type { CompatibilitySnapshot, SessionState } from "@mixerlink/shared";
import "./styles.css";

const relayUrl = "ws://localhost:4317";

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
  const [joinCode, setJoinCode] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "connected" | "offline">("connecting");
  const [session, setSession] = useState<SessionState | null>(null);
  const [ownCollaboratorId, setOwnCollaboratorId] = useState<string | null>(null);
  const [notice, setNotice] = useState("Start or join a session when the relay is running.");
  const [copiedSessionCode, setCopiedSessionCode] = useState(false);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [isScanningCompatibility, setIsScanningCompatibility] = useState(false);

  useEffect(() => {
    const socket = new WebSocket(relayUrl);
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      setConnectionStatus("connected");
      setNotice("Connected to the MixerLink relay.");
    });

    socket.addEventListener("close", () => {
      setConnectionStatus("offline");
      setNotice("Relay offline. Start the server, then refresh this app.");
    });

    socket.addEventListener("message", (event) => {
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
      socket.close();
    };
  }, []);

  useEffect(() => {
    localStorage.setItem("mixerlink.displayName", displayName);
  }, [displayName]);

  const canSend = connectionStatus === "connected";
  const collaboratorCount = useMemo(() => session?.collaborators.length ?? 0, [session]);
  const hasSharedCompatibility = Boolean(ownCollaboratorId && session?.compatibility[ownCollaboratorId]);

  function send(message: ClientMessage) {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      setNotice("Relay is not connected yet.");
      return;
    }

    socketRef.current.send(JSON.stringify(message));
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
          ? `Scan found ${snapshot.plugins.length} plugins across ${snapshot.scan?.pluginFolders.length ?? 0} folders.`
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
                                {compatibility.scan.pluginFolders.length} folders scanned /{" "}
                                {compatibility.scan.warnings.length} warnings
                              </p>
                              {compatibility.scan.pluginFolders.length > 0 ? (
                                <details>
                                  <summary>Scanned folders</summary>
                                  <ul>
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
                              <li key={`${collaborator.id}-${plugin.name}`} className="matched">{plugin.name}</li>
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

createRoot(document.getElementById("root")!).render(<App />);
