const fs = require("fs/promises");
const path = require("path");

const workspaceRoot = path.resolve(__dirname, "..");
const rootDirs = ["packages", "apps"];
const tsExtensions = new Set([".ts", ".tsx"]);
const generatedExtensions = [".js", ".js.map", ".d.ts"];
const skipDirs = new Set(["node_modules", ".git", ".turbo", "coverage"]);
const dependencyMarkers = new Set(["node_modules", ".pnpm"]);

function isDependencyPath(dirPath) {
  const relativePath = path.relative(workspaceRoot, dirPath);
  if (!relativePath || relativePath === "." || relativePath.startsWith("..")) {
    return false;
  }

  return relativePath.split(path.sep).some((segment) => dependencyMarkers.has(segment));
}

async function removeGeneratedFilesFromDir(dir) {
  if (isDependencyPath(dir)) {
    return;
  }

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) {
        if (entry.name === "dist") {
          const distPath = path.join(dir, entry.name);
          if (isDependencyPath(distPath)) {
            return;
          }

          await fs.rm(distPath, { recursive: true, force: true });
          console.log(`Removed ${path.relative(workspaceRoot, distPath)}`);
          return;
        }

        if (skipDirs.has(entry.name)) {
          return;
        }

        await removeGeneratedFilesFromDir(path.join(dir, entry.name));
        return;
      }

      if (!entry.isFile()) {
        return;
      }

      const extension = path.extname(entry.name);
      if (!tsExtensions.has(extension)) {
        return;
      }

      const baseName = path.basename(entry.name, extension);
      const dirPath = path.dirname(path.join(dir, entry.name));

      await Promise.all(
        generatedExtensions.map(async (generatedExt) => {
          const generatedPath = path.join(dirPath, `${baseName}${generatedExt}`);
          try {
            await fs.rm(generatedPath);
            console.log(`Removed ${path.relative(workspaceRoot, generatedPath)}`);
          } catch (error) {
            if (error?.code !== "ENOENT") {
              throw error;
            }
          }
        }),
      );
    }),
  );
}

async function main() {
  await Promise.all(
    rootDirs.map(async (rootDir) => {
      const resolved = path.join(workspaceRoot, rootDir);
      await removeGeneratedFilesFromDir(resolved);
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

