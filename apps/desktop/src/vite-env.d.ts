/// <reference types="vite/client" />

import type { CompatibilitySnapshot } from "@mixerlink/shared";

declare global {
  interface Window {
    mixerlink?: {
      scanCompatibility: () => Promise<CompatibilitySnapshot>;
      launchFlStudio: (executablePath?: string) => Promise<{ ok: true }>;
      openProjectInFlStudio: (request: { projectPath: string; executablePath?: string }) => Promise<{ ok: true }>;
      revealPath: (targetPath: string) => Promise<{ ok: true }>;
      queueBridgeOperation: (operation: import("@mixerlink/shared").BridgeOperation) => Promise<{ ok: true; id: number }>;
      getFlBridgeStatus: () => Promise<{ installed: boolean; installPath: string; bridgeUrl: string }>;
      installFlBridgeScript: () => Promise<{ installed: boolean; installPath: string; bridgeUrl: string }>;
      onBridgeOperationFromFl: (
        callback: (operation: import("@mixerlink/shared").BridgeOperation) => void
      ) => () => void;
      getLocalRelayUrls: () => Promise<string[]>;
      getCustomFlStudioFolders: () => Promise<string[]>;
      addCustomFlStudioFolder: () => Promise<string[]>;
      removeCustomFlStudioFolder: (folder: string) => Promise<string[]>;
      getUserDataFolders: () => Promise<string[]>;
      addUserDataFolder: () => Promise<string[]>;
      removeUserDataFolder: (folder: string) => Promise<string[]>;
      getProjectFolders: () => Promise<string[]>;
      addProjectFolder: () => Promise<string[]>;
      removeProjectFolder: (folder: string) => Promise<string[]>;
      getCustomPluginFolders: () => Promise<string[]>;
      addCustomPluginFolder: () => Promise<string[]>;
      removeCustomPluginFolder: (folder: string) => Promise<string[]>;
    };
  }
}
