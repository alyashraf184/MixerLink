import type { CompatibilitySnapshot } from "@mixerlink/shared";

type DetectedPlugin = CompatibilitySnapshot["plugins"][number];

const clientVersion = "0.1.0";

export type ScanCompatibilityOptions = {
  maxPluginsPerFolder?: number;
};

export function createEmptyCompatibilitySnapshot(): CompatibilitySnapshot {
  return {
    clientVersion,
    plugins: []
  };
}

export async function scanLocalCompatibility(options: ScanCompatibilityOptions = {}): Promise<CompatibilitySnapshot> {
  const maxPluginsPerFolder = options.maxPluginsPerFolder ?? 250;
  const warnings: string[] = [];
  const pluginFolders = getPluginSearchFolders();
  const detectedPluginFolders: string[] = [];
  const plugins = new Map<string, DetectedPlugin>();
  const daw = await detectFlStudio(warnings);

  const fs = await import("node:fs/promises");

  for (const folder of pluginFolders) {
    try {
      const entries = await fs.readdir(folder, { withFileTypes: true });
      detectedPluginFolders.push(folder);

      for (const entry of entries.slice(0, maxPluginsPerFolder)) {
        const plugin = detectPluginFromEntry(entry.name, entry.isDirectory());
        if (plugin) {
          plugins.set(`${plugin.format}:${plugin.name.toLowerCase()}`, plugin);
        }
      }
    } catch {
      warnings.push(`Skipped plugin folder: ${folder}`);
    }
  }

  return {
    clientVersion,
    daw,
    plugins: Array.from(plugins.values()).sort((a, b) => a.name.localeCompare(b.name)),
    scan: {
      scannedAt: new Date().toISOString(),
      pluginFolders: detectedPluginFolders,
      warnings
    }
  };
}

async function detectFlStudio(warnings: string[]): Promise<CompatibilitySnapshot["daw"]> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const candidates = getFlStudioSearchFolders();

  for (const folder of candidates) {
    try {
      const stat = await fs.stat(folder);
      if (!stat.isDirectory()) {
        continue;
      }

      return {
        name: "FL Studio",
        version: inferFlStudioVersion(path.basename(folder)),
        path: folder
      };
    } catch {
      continue;
    }
  }

  warnings.push("FL Studio install folder was not found in common Image-Line locations.");
  return undefined;
}

function getFlStudioSearchFolders(): string[] {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";

  return [
    `${programFiles}\\Image-Line\\FL Studio 2024`,
    `${programFiles}\\Image-Line\\FL Studio 21`,
    `${programFiles}\\Image-Line\\FL Studio 20`,
    `${programFiles}\\Image-Line\\FL Studio 12`,
    `${programFilesX86}\\Image-Line\\FL Studio 21`,
    `${programFilesX86}\\Image-Line\\FL Studio 20`,
    `${programFilesX86}\\Image-Line\\FL Studio 12`
  ];
}

function inferFlStudioVersion(folderName: string): string | undefined {
  const match = folderName.match(/FL Studio\s+(.+)$/i);
  return match?.[1];
}

function getPluginSearchFolders(): string[] {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const commonProgramFiles = process.env.CommonProgramFiles ?? `${programFiles}\\Common Files`;
  const commonProgramFilesX86 = process.env["CommonProgramFiles(x86)"] ?? `${programFilesX86}\\Common Files`;

  return [
    `${commonProgramFiles}\\VST3`,
    `${commonProgramFiles}\\CLAP`,
    `${programFiles}\\VstPlugins`,
    `${programFiles}\\Steinberg\\VstPlugins`,
    `${programFiles}\\Common Files\\VST2`,
    `${commonProgramFilesX86}\\VST3`,
    `${programFilesX86}\\VstPlugins`,
    `${programFilesX86}\\Steinberg\\VstPlugins`
  ];
}

function detectPluginFromEntry(entryName: string, isDirectory: boolean): DetectedPlugin | undefined {
  const lowerName = entryName.toLowerCase();

  if (isDirectory && lowerName.endsWith(".vst3")) {
    return createPlugin(entryName, "vst3");
  }

  if (isDirectory && lowerName.endsWith(".clap")) {
    return createPlugin(entryName, "clap");
  }

  if (!isDirectory && lowerName.endsWith(".dll")) {
    return createPlugin(entryName, "vst2");
  }

  return undefined;
}

function createPlugin(fileName: string, format: DetectedPlugin["format"]): DetectedPlugin {
  return {
    name: stripPluginExtension(fileName),
    format
  };
}

function stripPluginExtension(fileName: string): string {
  return fileName.replace(/\.(vst3|clap|dll)$/i, "");
}
