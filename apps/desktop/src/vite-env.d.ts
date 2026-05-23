/// <reference types="vite/client" />

import type { CompatibilitySnapshot } from "@mixerlink/shared";

declare global {
  interface Window {
    mixerlink?: {
      scanCompatibility: () => Promise<CompatibilitySnapshot>;
    };
  }
}
