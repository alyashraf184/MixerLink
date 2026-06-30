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
    executablePath?: string;
  };
  projectFiles?: Array<{
    name: string;
    path: string;
    type: "project" | "archive" | "preset" | "audio" | "midi";
    source?: "project" | "user-data";
  }>;
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
    flStudioFolders: string[];
    customFlStudioFolders: string[];
    userDataFolders: string[];
    projectFolders: string[];
    pluginFolders: string[];
    customPluginFolders: string[];
    warnings: string[];
  };
};

export type ActivityEvent = {
  id: string;
  createdAt: string;
  type:
    | "session.created"
    | "collaborator.joined"
    | "collaborator.left"
    | "compatibility.updated"
    | "bridge.operation";
  message: string;
  collaboratorId?: string;
};

export type BridgeOperation =
  | {
      type: "transport.play" | "transport.stop";
      payload?: {
        positionBeats?: number;
      };
    }
  | {
      type: "tempo.changed";
      payload: {
        bpm: number;
      };
    }
  | {
      type: "channel_rack.snapshot";
      payload: ChannelRackState;
    }
  | {
      type: "channel_rack.channel.updated";
      payload: {
        index: number;
        expectedPluginName?: string;
        patch: Partial<
          Pick<
            ChannelRackChannel,
            "name" | "color" | "muted" | "solo" | "volume" | "pan" | "pitch" | "selected" | "targetMixerTrack"
          >
        >;
      };
    }
  | {
      type: "channel_rack.step.changed";
      payload: {
        index: number;
        expectedPluginName?: string;
        step: number;
        active: boolean;
      };
    }
  | {
      type: "channel_rack.plugin_parameter.changed";
      payload: {
        index: number;
        pluginName: string;
        parameterIndex: number;
        parameterName: string;
        value: number;
      };
    };

export type ChannelRackPluginParameter = {
  index: number;
  name: string;
  value: number;
  displayValue?: string;
};

export type ChannelRackChannel = {
  index: number;
  name: string;
  color: number;
  type: "sampler" | "hybrid" | "generator" | "layer" | "audio-clip" | "automation-clip" | "unknown";
  pluginName?: string;
  supportedPlugin: boolean;
  muted: boolean;
  solo: boolean;
  volume: number;
  pan: number;
  pitch: number;
  selected: boolean;
  targetMixerTrack: number;
  steps: boolean[];
  pluginParameters: ChannelRackPluginParameter[];
};

export type ChannelRackState = {
  channels: ChannelRackChannel[];
  stepCount: number;
  capturedAt: string;
};

export type BridgeState = {
  transport: "playing" | "stopped";
  tempoBpm: number;
  channelRack: ChannelRackState;
  lastOperation?: {
    type: BridgeOperation["type"];
    collaboratorId: string;
    createdAt: string;
    operation?: BridgeOperation;
  };
};

export type SessionState = {
  code: SessionCode;
  collaborators: Collaborator[];
  compatibility: Record<string, CompatibilitySnapshot>;
  bridge: BridgeState;
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
