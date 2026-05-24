/// <reference types="vite/client" />

import type { CompatibilitySnapshot } from "@mixerlink/shared";

declare global {
  interface Window {
    mixerlink?: {
      scanCompatibility: () => Promise<CompatibilitySnapshot>;
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
