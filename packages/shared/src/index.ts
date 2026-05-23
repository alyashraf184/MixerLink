export type SessionCode = string;

export type Collaborator = {
  id: string;
  displayName: string;
  joinedAt: string;
  status: "connected" | "ready" | "disconnected";
};

export type CompatibilitySnapshot = {
  clientVersion: string;
  daw?: {
    name: "FL Studio";
    version?: string;
    path?: string;
  };
  plugins: Array<{
    name: string;
    vendor?: string;
    version?: string;
    format?: "vst2" | "vst3" | "clap" | "other";
  }>;
  missingPlugins?: Array<{
    name: string;
    vendor?: string;
    expectedVersion?: string;
  }>;
  scan?: {
    scannedAt: string;
    pluginFolders: string[];
    warnings: string[];
  };
};

export type ActivityEvent = {
  id: string;
  createdAt: string;
  type: "session.created" | "collaborator.joined" | "collaborator.left" | "compatibility.updated";
  message: string;
  collaboratorId?: string;
};

export type SessionState = {
  code: SessionCode;
  collaborators: Collaborator[];
  compatibility: Record<string, CompatibilitySnapshot>;
  activity: ActivityEvent[];
};
