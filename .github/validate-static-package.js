const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const errors = [];
const warnings = [];

const allowedTopLevelItems = new Set([
  ".github",
  "README.md",
  "config",
  "configurator",
  "images",
  "staging",
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

const requiredCatalogTopLevelKeys = [
  "schemaVersion",
  "revision",
  "devices",
  "categoryHelp",
  "validationProfiles",
  "generatedMaterialFilters",
];

const allowedCatalogTopLevelKeys = new Set([
  ...requiredCatalogTopLevelKeys,
  "runtimeContract",
]);

const allowedRuntimeContractKeys = new Set([
  "contractVersion",
  "minExtensionVersion",
  "supportedCapabilities",
  "blockedCapabilities",
  "fieldPolicy",
]);

const supportedRuntimeContractVersions = new Set([1]);

const knownRuntimeCapabilities = new Set([
  "visualOverlay",
  "remoteAdditionsDebug",
  "remoteAdditionsAuto",
  "remoteMaterialPreview",
  "remoteMaterialDebug",
  "resolvedApplyPlan",
]);

const forbiddenRuntimeControlCapabilities = new Set([
  "arbitraryJs",
  "domSelectors",
  "regexValidation",
  "ossNavigation",
  "clipboard",
  "labelsBarcodes",
  "dashboardApi",
  "camFlow",
  "rewriteMap",
  "generatedMaterialFiltersRuntime",
]);

const allowedFieldPolicyValues = new Set([
  "safe",
  "debug-only",
  "risky",
  "blocked",
]);

const knownFieldPolicyKeys = new Set([
  "deviceId",
  "categoryId",
  "displayName",
  "imagePath",
  "helpImagePath",
  "warningText",
  "materialId",
  "legacyMaterialIds",
  "validationProfileId",
  "enabled",
  "generatedMaterialFilters",
  "schemaVersion",
  "revision",
  "runtimeContract",
  "categoryHelp",
  "validationProfiles",
]);

const localOnlyOrForbiddenSafeFieldPolicyKeys = new Set([
  "legacyMaterialIds",
  "generatedMaterialFilters",
  "validationProfiles",
  "categoryHelp",
  "runtimeContract",
  "arbitraryJs",
  "domSelectors",
  "regexValidation",
  "ossNavigation",
  "clipboard",
  "labelsBarcodes",
  "dashboardApi",
  "camFlow",
  "rewriteMap",
]);

function addError(message) {
  errors.push(message);
}

function addWarning(message) {
  warnings.push(message);
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
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

function isSemverLike(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

function validateRuntimeContractStringArray(contract, key) {
  if (contract[key] === undefined) {
    return;
  }

  if (!Array.isArray(contract[key])) {
    addError(`runtimeContract.${key} must be an array of strings`);
    return;
  }

  contract[key].forEach((capability, index) => {
    if (typeof capability !== "string" || !capability.trim()) {
      addError(`runtimeContract.${key}[${index}] must be a non-empty string`);
      return;
    }

    if (key === "supportedCapabilities" && forbiddenRuntimeControlCapabilities.has(capability)) {
      addError(`runtimeContract.supportedCapabilities must not include forbidden runtime-control capability: ${capability}`);
      return;
    }

    if (!knownRuntimeCapabilities.has(capability) && !forbiddenRuntimeControlCapabilities.has(capability)) {
      addWarning(`runtimeContract.${key} contains unknown future capability requiring review: ${capability}`);
    }

    if (key === "blockedCapabilities" && knownRuntimeCapabilities.has(capability)) {
      addWarning(`runtimeContract.blockedCapabilities blocks a currently known capability: ${capability}`);
    }
  });
}

function validateRuntimeContractFieldPolicy(fieldPolicy) {
  if (fieldPolicy === undefined) {
    return;
  }

  if (!isPlainObject(fieldPolicy)) {
    addError("runtimeContract.fieldPolicy must be an object");
    return;
  }

  for (const [fieldName, policy] of Object.entries(fieldPolicy)) {
    if (!allowedFieldPolicyValues.has(policy)) {
      addError(`runtimeContract.fieldPolicy.${fieldName} must be one of: ${Array.from(allowedFieldPolicyValues).join(", ")}`);
    }

    if (!knownFieldPolicyKeys.has(fieldName)) {
      addWarning(`runtimeContract.fieldPolicy contains unknown field requiring review: ${fieldName}`);
    }

    if (policy === "safe" && localOnlyOrForbiddenSafeFieldPolicyKeys.has(fieldName)) {
      addError(`runtimeContract.fieldPolicy.${fieldName} must not mark local-only or forbidden runtime-control fields as safe`);
    }
  }
}

function validateRuntimeContract(runtimeContract) {
  if (runtimeContract === undefined) {
    return;
  }

  if (!isPlainObject(runtimeContract)) {
    addError("runtimeContract must be an object when present");
    return;
  }

  for (const key of Object.keys(runtimeContract)) {
    if (!allowedRuntimeContractKeys.has(key)) {
      addWarning(`runtimeContract contains unknown key requiring review: ${key}`);
    }
  }

  if (runtimeContract.contractVersion !== undefined) {
    if (!Number.isInteger(runtimeContract.contractVersion) || runtimeContract.contractVersion <= 0) {
      addError("runtimeContract.contractVersion must be a positive integer");
    } else if (!supportedRuntimeContractVersions.has(runtimeContract.contractVersion)) {
      addError(`Unsupported runtimeContract.contractVersion: ${runtimeContract.contractVersion}`);
    }
  }

  if (runtimeContract.minExtensionVersion !== undefined && !isSemverLike(runtimeContract.minExtensionVersion)) {
    addError("runtimeContract.minExtensionVersion must be a semver-like string, for example 1.2.3");
  }

  validateRuntimeContractStringArray(runtimeContract, "supportedCapabilities", "supported capabilities");
  validateRuntimeContractStringArray(runtimeContract, "blockedCapabilities", "blocked capabilities");
  validateRuntimeContractFieldPolicy(runtimeContract.fieldPolicy);
}

function validateCatalog(catalog) {
  if (!isPlainObject(catalog)) {
    addError("recycle-device-catalog.json must contain a JSON object");
    return;
  }

  for (const key of requiredCatalogTopLevelKeys) {
    if (!Object.prototype.hasOwnProperty.call(catalog, key)) {
      addError(`recycle-device-catalog.json is missing required top-level key: ${key}`);
    }
  }

  for (const key of Object.keys(catalog)) {
    if (!allowedCatalogTopLevelKeys.has(key)) {
      addError(`Unexpected recycle-device-catalog.json top-level key: ${key}`);
    }
  }

  if (catalog.schemaVersion !== 1) {
    addError(`recycle-device-catalog.json schemaVersion must be 1; received ${catalog.schemaVersion}`);
  }

  if (typeof catalog.revision !== "string" || !catalog.revision.trim()) {
    addError("recycle-device-catalog.json revision must be a non-empty string");
  }

  if (!Array.isArray(catalog.devices)) {
    addError("recycle-device-catalog.json devices must be an array");
  }

  if (!isPlainObject(catalog.categoryHelp)) {
    addError("recycle-device-catalog.json categoryHelp must be an object");
  }

  if (!Array.isArray(catalog.validationProfiles)) {
    addError("recycle-device-catalog.json validationProfiles must be an array");
  }

  if (!isPlainObject(catalog.generatedMaterialFilters)) {
    addError("recycle-device-catalog.json generatedMaterialFilters must be an object");
  }

  validateRuntimeContract(catalog.runtimeContract);
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
validateCatalog(catalog);

const manifest = readJson("config/assets-manifest.json");
validateManifest(manifest);
validateConfiguratorMode();

if (errors.length > 0) {
  console.error("\nValidation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  if (warnings.length > 0) {
    console.error("\nWarnings:");
    for (const warning of warnings) {
      console.error(`- ${warning}`);
    }
  }
  process.exit(1);
}

if (warnings.length > 0) {
  console.warn("\nValidation warnings:");
  for (const warning of warnings) {
    console.warn(`- ${warning}`);
  }
}

console.log("Validation passed");
