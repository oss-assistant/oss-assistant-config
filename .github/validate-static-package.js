const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const errors = [];

const allowedTopLevelItems = new Set([
  ".github",
  "README.md",
  "config",
  "configurator",
  "images",
]);

const requiredFiles = [
  "config/recycle-device-catalog.json",
  "config/assets-manifest.json",
  "configurator/index.html",
  "configurator/app.js",
  "configurator/styles.css",
];

const forbiddenNames = new Set([
  ".env",
  "Extension",
  "archive",
  "archives",
  "background.js",
  "content.js",
  "manifest.json",
  "scripts",
  "server.js",
]);

const backupOrTempPattern = /(^|[-_.])(backup|backups|temp|tmp|output|outputs)([-_.]|$)/i;

function addError(message) {
  errors.push(message);
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function relativeFromRoot(absolutePath) {
  return toPosix(path.relative(repoRoot, absolutePath));
}

function requireFile(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    addError(`Missing required file: ${relativePath}`);
    return;
  }

  const stat = fs.lstatSync(absolutePath);
  if (!stat.isFile()) {
    addError(`Required path is not a file: ${relativePath}`);
  }
}

function readJson(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  try {
    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    addError(`Invalid JSON in ${relativePath}: ${error.message}`);
    return null;
  }
}

function scanDirectory(absoluteDir) {
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    if (entry.name === ".git") {
      continue;
    }

    const absolutePath = path.join(absoluteDir, entry.name);
    const relativePath = relativeFromRoot(absolutePath);

    if (absoluteDir === repoRoot && !allowedTopLevelItems.has(entry.name)) {
      addError(`Unexpected top-level item: ${entry.name}`);
    }

    if (forbiddenNames.has(entry.name)) {
      addError(`Forbidden file or folder present: ${relativePath}`);
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith(".zip")) {
      addError(`Forbidden zip file present: ${relativePath}`);
    }

    if (backupOrTempPattern.test(entry.name)) {
      addError(`Forbidden archive/temp/backup/output path present: ${relativePath}`);
    }

    if (entry.isDirectory()) {
      scanDirectory(absolutePath);
    }
  }
}

function validateAssetPath(assetPath, label) {
  if (typeof assetPath !== "string" || assetPath.trim() === "") {
    addError(`${label} path must be a non-empty string`);
    return;
  }

  const lowerPath = assetPath.toLowerCase();
  const hasDriveLetter = /^[a-z]:/i.test(assetPath);

  if (!assetPath.startsWith("images/")) {
    addError(`${label} path must start with images/: ${assetPath}`);
  }

  if (path.isAbsolute(assetPath) || assetPath.startsWith("/") || assetPath.startsWith("\\\\")) {
    addError(`${label} path must be relative: ${assetPath}`);
  }

  if (hasDriveLetter) {
    addError(`${label} path must not contain a drive letter: ${assetPath}`);
  }

  if (assetPath.includes("\\")) {
    addError(`${label} path must use forward slashes: ${assetPath}`);
  }

  if (assetPath.split("/").includes("..")) {
    addError(`${label} path must not contain ..: ${assetPath}`);
  }

  if (
    lowerPath.startsWith("file://") ||
    lowerPath.startsWith("http://") ||
    lowerPath.startsWith("https://")
  ) {
    addError(`${label} path must not be a URL: ${assetPath}`);
  }

  const resolvedPath = path.resolve(repoRoot, assetPath);
  if (!resolvedPath.startsWith(repoRoot + path.sep)) {
    addError(`${label} path escapes repository root: ${assetPath}`);
    return;
  }

  if (!fs.existsSync(resolvedPath)) {
    addError(`${label} file does not exist: ${assetPath}`);
    return;
  }

  if (!fs.lstatSync(resolvedPath).isFile()) {
    addError(`${label} path is not a real file: ${assetPath}`);
  }
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    addError("assets-manifest.json must contain a JSON object");
    return;
  }

  if (!Array.isArray(manifest.deviceImages)) {
    addError("assets-manifest.json deviceImages must be an array");
  }

  if (!Array.isArray(manifest.helpImages)) {
    addError("assets-manifest.json helpImages must be an array");
  }

  for (const [collectionName, collection] of [
    ["deviceImages", manifest.deviceImages],
    ["helpImages", manifest.helpImages],
  ]) {
    if (!Array.isArray(collection)) {
      continue;
    }

    collection.forEach((asset, index) => {
      if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
        addError(`${collectionName}[${index}] must be an object`);
        return;
      }

      validateAssetPath(asset.path, `${collectionName}[${index}]`);
    });
  }
}

function validateConfiguratorMode() {
  const appPath = path.join(repoRoot, "configurator/app.js");
  const appSource = fs.readFileSync(appPath, "utf8");
  const staticMode = 'const CONFIGURATOR_MODE = "static";';
  const localMode = 'const CONFIGURATOR_MODE = "local";';

  if (!appSource.includes(staticMode)) {
    addError(`configurator/app.js must contain: ${staticMode}`);
  }

  if (appSource.includes(localMode)) {
    addError(`configurator/app.js must not contain: ${localMode}`);
  }
}

console.log("Validating OSS Assistant static config package");

scanDirectory(repoRoot);

for (const requiredFile of requiredFiles) {
  requireFile(requiredFile);
}

const catalog = readJson("config/recycle-device-catalog.json");
if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
  addError("recycle-device-catalog.json must contain a JSON object");
}

const manifest = readJson("config/assets-manifest.json");
validateManifest(manifest);
validateConfiguratorMode();

if (errors.length > 0) {
  console.error("\nValidation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("Validation passed");
