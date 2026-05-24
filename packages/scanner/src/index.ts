import type { CompatibilitySnapshot } from "@mixerlink/shared";

type DetectedPlugin = CompatibilitySnapshot["plugins"][number];
type DetectedProjectFile = NonNullable<CompatibilitySnapshot["projectFiles"]>[number];

const clientVersion = "0.1.0";

export type ScanCompatibilityOptions = {
  maxPluginsPerFolder?: number;
  maxProjectFilesPerFolder?: number;
  maxDepth?: number;
  customFlStudioFolders?: string[];
  userDataFolders?: string[];
  projectFolders?: string[];
  customPluginFolders?: string[];
};

export function createEmptyCompatibilitySnapshot(): CompatibilitySnapshot {
  return {
    clientVersion,
    plugins: []
  };
}

export async function scanLocalCompatibility(options: ScanCompatibilityOptions = {}): Promise<CompatibilitySnapshot> {
  const maxPluginsPerFolder = options.maxPluginsPerFolder ?? 1000;
  const maxProjectFilesPerFolder = options.maxProjectFilesPerFolder ?? 500;
  const maxDepth = options.maxDepth ?? 4;
  const warnings: string[] = [];
  const customFlStudioFolders = dedupePaths(options.customFlStudioFolders ?? []);
  const flStudioFolders = dedupePaths([...customFlStudioFolders, ...getFlStudioSearchFolders()]);
  const userDataFolders = dedupePaths([...(options.userDataFolders ?? []), ...getFlStudioUserDataFolders()]);
  const projectFolders = dedupePaths(options.projectFolders ?? []);
  const systemPluginFolders = getPluginSearchFolders();
  const customPluginFolders = dedupePaths(options.customPluginFolders ?? []);
  const pluginFolders = [...systemPluginFolders, ...customPluginFolders];
  const detectedFlStudioFolders: string[] = [];
  const detectedUserDataFolders: string[] = [];
  const detectedProjectFolders: string[] = [];
  const detectedPluginFolders: string[] = [];
  const projectFiles = new Map<string, DetectedProjectFile>();
  const plugins = new Map<string, DetectedPlugin>();
  const daw = await detectFlStudio(flStudioFolders, detectedFlStudioFolders, warnings);

  for (const folder of userDataFolders) {
    try {
      const folderProjectFiles = await scanProjectFolder(folder, {
        maxDepth,
        maxFiles: maxProjectFilesPerFolder,
        source: "user-data"
      });
      detectedUserDataFolders.push(folder);

      for (const projectFile of folderProjectFiles) {
        projectFiles.set(projectFile.path.toLowerCase(), projectFile);
      }
    } catch {
      warnings.push(`Skipped FL Studio user data folder: ${folder}`);
    }
  }

  for (const folder of projectFolders) {
    try {
      const folderProjectFiles = await scanProjectFolder(folder, {
        maxDepth,
        maxFiles: maxProjectFilesPerFolder,
        source: "project"
      });
      detectedProjectFolders.push(folder);

      for (const projectFile of folderProjectFiles) {
        projectFiles.set(projectFile.path.toLowerCase(), projectFile);
      }
    } catch {
      warnings.push(`Skipped project folder: ${folder}`);
    }
  }

  for (const folder of pluginFolders) {
    const source = customPluginFolders.includes(folder) ? "custom" : "system";

    try {
      const folderPlugins = await scanPluginFolder(folder, {
        maxDepth,
        maxPlugins: maxPluginsPerFolder,
        source
      });
      detectedPluginFolders.push(folder);

      for (const plugin of folderPlugins) {
        plugins.set(`${plugin.format}:${plugin.name.toLowerCase()}:${plugin.path ?? ""}`, plugin);
      }
    } catch (error) {
      warnings.push(`Skipped plugin folder: ${folder}`);
    }
  }

  return {
    clientVersion,
    daw,
    projectFiles: Array.from(projectFiles.values()).sort((a, b) => a.name.localeCompare(b.name)),
    plugins: Array.from(plugins.values()).sort((a, b) => a.name.localeCompare(b.name)),
    scan: {
      scannedAt: new Date().toISOString(),
      flStudioFolders: detectedFlStudioFolders,
      customFlStudioFolders,
      userDataFolders: detectedUserDataFolders,
      projectFolders: detectedProjectFolders,
      pluginFolders: detectedPluginFolders,
      customPluginFolders,
      warnings
    }
  };
}

type ScanPluginFolderOptions = {
  maxDepth: number;
  maxPlugins: number;
  source: NonNullable<DetectedPlugin["source"]>;
};

type ScanProjectFolderOptions = {
  maxDepth: number;
  maxFiles: number;
  source: NonNullable<DetectedProjectFile["source"]>;
};

async function scanProjectFolder(rootFolder: string, options: ScanProjectFolderOptions): Promise<DetectedProjectFile[]> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const projectFiles: DetectedProjectFile[] = [];

  async function walk(folder: string, depth: number): Promise<void> {
    if (depth > options.maxDepth || projectFiles.length >= options.maxFiles) {
      return;
    }

    const entries = await fs.readdir(folder, { withFileTypes: true });

    for (const entry of entries) {
      if (projectFiles.length >= options.maxFiles) {
        return;
      }

      const fullPath = path.join(folder, entry.name);

      if (entry.isFile()) {
        const type = detectProjectFileType(entry.name);

        if (type) {
          projectFiles.push({
            name: entry.name,
            path: fullPath,
            type,
            source: options.source
          });
        }

        continue;
      }

      if (entry.isDirectory() && !shouldSkipProjectFolder(entry.name)) {
        try {
          await walk(fullPath, depth + 1);
        } catch {
          continue;
        }
      }
    }
  }

  await walk(rootFolder, 0);
  return projectFiles;
}

async function scanPluginFolder(rootFolder: string, options: ScanPluginFolderOptions): Promise<DetectedPlugin[]> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const plugins: DetectedPlugin[] = [];

  async function walk(folder: string, depth: number): Promise<void> {
    if (depth > options.maxDepth || plugins.length >= options.maxPlugins) {
      return;
    }

    const entries = await fs.readdir(folder, { withFileTypes: true });

    for (const entry of entries) {
      if (plugins.length >= options.maxPlugins) {
        return;
      }

      const fullPath = path.join(folder, entry.name);
      const plugin = detectPluginFromEntry(entry.name, entry.isDirectory(), fullPath, options.source);

      if (plugin) {
        plugins.push(plugin);
        continue;
      }

      if (entry.isDirectory() && !isPluginBundleName(entry.name)) {
        try {
          await walk(fullPath, depth + 1);
        } catch {
          continue;
        }
      }
    }
  }

  await walk(rootFolder, 0);
  return plugins;
}

async function detectFlStudio(
  candidates: string[],
  detectedFlStudioFolders: string[],
  warnings: string[]
): Promise<CompatibilitySnapshot["daw"]> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  let daw: CompatibilitySnapshot["daw"];

  for (const folder of candidates) {
    try {
      const stat = await fs.stat(folder);
      if (!stat.isDirectory()) {
        continue;
      }

      detectedFlStudioFolders.push(folder);
      daw ??= {
        name: "FL Studio",
        version: inferFlStudioVersion(path.basename(folder)),
        path: folder
      };
    } catch {
      continue;
    }
  }

  if (daw) {
    return daw;
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

function getFlStudioUserDataFolders(): string[] {
  const userProfile = process.env.USERPROFILE;
  const documents = userProfile ? `${userProfile}\\Documents` : undefined;

  return documents
    ? [
        `${documents}\\Image-Line`,
        `${documents}\\Image-Line\\FL Studio`,
        `${documents}\\Image-Line\\Data\\FL Studio`
      ]
    : [];
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

function detectProjectFileType(fileName: string): DetectedProjectFile["type"] | undefined {
  const lowerName = fileName.toLowerCase();

  if (lowerName.endsWith(".flp")) {
    return "project";
  }

  if (lowerName.endsWith(".zip")) {
    return "archive";
  }

  if (lowerName.endsWith(".fst")) {
    return "preset";
  }

  if (/\.(wav|mp3|ogg|flac|aif|aiff)$/i.test(lowerName)) {
    return "audio";
  }

  if (/\.(mid|midi)$/i.test(lowerName)) {
    return "midi";
  }

  return undefined;
}

function shouldSkipProjectFolder(folderName: string): boolean {
  return new Set(["node_modules", ".git", "release", "dist", "build"]).has(folderName.toLowerCase());
}

function detectPluginFromEntry(
  entryName: string,
  isDirectory: boolean,
  fullPath: string,
  source: NonNullable<DetectedPlugin["source"]>
): DetectedPlugin | undefined {
  const lowerName = entryName.toLowerCase();

  if (isDirectory && lowerName.endsWith(".vst3")) {
    return createPlugin(entryName, "vst3", fullPath, source);
  }

  if (isDirectory && lowerName.endsWith(".clap")) {
    return createPlugin(entryName, "clap", fullPath, source);
  }

  if (!isDirectory && lowerName.endsWith(".dll")) {
    return createPlugin(entryName, "vst2", fullPath, source);
  }

  return undefined;
}

function createPlugin(
  fileName: string,
  format: DetectedPlugin["format"],
  fullPath: string,
  source: NonNullable<DetectedPlugin["source"]>
): DetectedPlugin {
  const name = stripPluginExtension(fileName);

  return {
    name: stripVersionSuffix(name),
    vendor: inferVendorFromPath(fullPath),
    version: inferVersionFromName(name),
    format,
    path: fullPath,
    source
  };
}

function stripPluginExtension(fileName: string): string {
  return fileName.replace(/\.(vst3|clap|dll)$/i, "");
}

function stripVersionSuffix(name: string): string {
  return name.replace(/\s+(v|version)?\d+(?:\.\d+){1,3}$/i, "").trim();
}

function inferVersionFromName(name: string): string | undefined {
  const match = name.match(/\b(?:v|version)?(\d+(?:\.\d+){1,3})\b/i);
  return match?.[1];
}

function inferVendorFromPath(pluginPath: string): string | undefined {
  const parts = pluginPath.split(/[\\/]+/).filter(Boolean);
  const pluginFile = parts.at(-1);
  const parent = parts.at(-2);

  if (!parent || !pluginFile) {
    return undefined;
  }

  const genericFolders = new Set(["vst3", "vstplugins", "vst2", "clap", "common files", "steinberg"]);
  return genericFolders.has(parent.toLowerCase()) ? undefined : parent;
}

function isPluginBundleName(name: string): boolean {
  return /\.(vst3|clap)$/i.test(name);
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const folder of paths) {
    const normalized = folder.trim();
    const key = normalized.toLowerCase();

    if (normalized && !seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }

  return result;
}
