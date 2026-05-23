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
    path?: string;
    source?: "system" | "custom";
  }>;
  missingPlugins?: Array<{
    name: string;
    vendor?: string;
    expectedVersion?: string;
  }>;
  scan?: {
    scannedAt: string;
    pluginFolders: string[];
    customPluginFolders: string[];
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

export type PluginCompatibilityIssue = {
  pluginName: string;
  ownerCollaboratorId: string;
  otherCollaboratorId: string;
  kind: "missing" | "version-mismatch" | "format-mismatch";
  ownerValue?: string;
  otherValue?: string;
};

export type CompatibilityComparison = {
  sharedPluginCount: number;
  missing: PluginCompatibilityIssue[];
  versionMismatches: PluginCompatibilityIssue[];
  formatMismatches: PluginCompatibilityIssue[];
};

export function compareCompatibilitySnapshots(
  ownerCollaboratorId: string,
  ownerSnapshot: CompatibilitySnapshot,
  otherCollaboratorId: string,
  otherSnapshot: CompatibilitySnapshot
): CompatibilityComparison {
  const ownerPlugins = indexPlugins(ownerSnapshot);
  const otherPlugins = indexPlugins(otherSnapshot);
  const missing: PluginCompatibilityIssue[] = [];
  const versionMismatches: PluginCompatibilityIssue[] = [];
  const formatMismatches: PluginCompatibilityIssue[] = [];
  let sharedPluginCount = 0;

  for (const [pluginKey, ownerPlugin] of ownerPlugins) {
    const otherPlugin = otherPlugins.get(pluginKey);

    if (!otherPlugin) {
      missing.push({
        pluginName: ownerPlugin.name,
        ownerCollaboratorId,
        otherCollaboratorId,
        kind: "missing"
      });
      continue;
    }

    sharedPluginCount += 1;

    if (ownerPlugin.version && otherPlugin.version && ownerPlugin.version !== otherPlugin.version) {
      versionMismatches.push({
        pluginName: ownerPlugin.name,
        ownerCollaboratorId,
        otherCollaboratorId,
        kind: "version-mismatch",
        ownerValue: ownerPlugin.version,
        otherValue: otherPlugin.version
      });
    }

    if (ownerPlugin.format && otherPlugin.format && ownerPlugin.format !== otherPlugin.format) {
      formatMismatches.push({
        pluginName: ownerPlugin.name,
        ownerCollaboratorId,
        otherCollaboratorId,
        kind: "format-mismatch",
        ownerValue: ownerPlugin.format,
        otherValue: otherPlugin.format
      });
    }
  }

  return {
    sharedPluginCount,
    missing,
    versionMismatches,
    formatMismatches
  };
}

export function normalizePluginName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(vst2|vst3|clap|x64|64bit|64-bit)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function indexPlugins(snapshot: CompatibilitySnapshot): Map<string, CompatibilitySnapshot["plugins"][number]> {
  const plugins = new Map<string, CompatibilitySnapshot["plugins"][number]>();

  for (const plugin of snapshot.plugins) {
    const key = normalizePluginName(plugin.name);
    if (key) {
      plugins.set(key, plugin);
    }
  }

  return plugins;
}
