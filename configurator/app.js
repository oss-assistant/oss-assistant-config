"use strict";

const STATIC_CATALOG_URL = "../config/recycle-device-catalog.json";
const STATIC_ASSETS_MANIFEST_URL = "../config/assets-manifest.json";
const STATIC_ASSET_POLICIES = [
  {
    key: "deviceImages",
    kind: "deviceImage",
    extensionPrefix: "images/devices/16x9/"
  },
  {
    key: "helpImages",
    kind: "helpImage",
    extensionPrefix: "images/recycle-help/"
  }
];
const STATIC_ASSET_EXTENSIONS = new Set([".webp", ".png", ".jpg", ".jpeg"]);
const STATIC_VALIDATION_INSTRUCTIONS = "Full validation is not available in static mode. Export/download the candidate JSON, then run validate-recycle-config-fixture.js --input and review-recycle-config-candidate.js --input, or use a future GitHub Action.";

const localConfiguratorAdapter = {
  capabilities: {
    canValidateCandidate: true,
    canValidateFixture: true,
    assetPreviewMode: "local-endpoint"
  },
  endpoints: {
    fixture: "/api/fixture",
    assets: "/api/assets",
    assetPreview: "/api/asset-preview",
    validateFixture: "/api/validate-fixture",
    validateCandidate: "/api/validate-candidate"
  },
  async fetchJson(endpoint, options = {}) {
    const response = await fetch(endpoint, options);
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    return data;
  },
  loadDefaultCandidate() {
    return this.fetchJson(this.endpoints.fixture, { cache: "no-store" });
  },
  loadFixture() {
    return this.loadDefaultCandidate();
  },
  loadAssetInventory() {
    return this.fetchJson(this.endpoints.assets, { cache: "no-store" });
  },
  previewUrlForPath(assetPath) {
    return `${this.endpoints.assetPreview}?path=${encodeURIComponent(assetPath)}`;
  },
  validateFixture() {
    return this.fetchJson(this.endpoints.validateFixture, { cache: "no-store" });
  },
  validateCandidate(candidate) {
    return this.fetchJson(this.endpoints.validateCandidate, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(candidate)
    });
  }
};

const staticConfiguratorAdapter = {
  capabilities: {
    canValidateCandidate: false,
    canValidateFixture: false,
    assetPreviewMode: "static-manifest"
  },
  urls: {
    catalog: STATIC_CATALOG_URL,
    assetsManifest: STATIC_ASSETS_MANIFEST_URL
  },
  approvedAssetPaths: new Set(),
  async fetchJson(url) {
    const response = await fetch(url, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return data;
  },
  async loadDefaultCandidate() {
    return this.loadFixture();
  },
  async loadFixture() {
    const catalog = await this.fetchJson(this.urls.catalog);
    return buildFixtureResponseFromCatalog(catalog, this.urls.catalog);
  },
  async loadAssetInventory() {
    const manifest = await this.fetchJson(this.urls.assetsManifest);
    const inventory = buildAssetInventoryFromManifest(manifest);
    this.approvedAssetPaths = new Set([
      ...inventory.deviceImages.map(asset => asset.path),
      ...inventory.helpImages.map(asset => asset.path)
    ]);
    return inventory;
  },
  previewUrlForPath(assetPath) {
    const normalized = normalizeString(assetPath);
    if (!this.approvedAssetPaths.has(normalized)) return "";
    return staticPreviewUrlForPath(normalized);
  },
  validateFixture() {
    return Promise.resolve(staticValidationUnavailableResult("../config/recycle-device-catalog.json"));
  },
  validateCandidate() {
    return Promise.resolve(staticValidationUnavailableResult("downloaded-candidate.json"));
  }
};
const CONFIGURATOR_MODE = "static";

function createConfiguratorAdapter(mode) {
  if (mode === "local") return localConfiguratorAdapter;
  if (mode === "static") return staticConfiguratorAdapter;
  throw new Error(`Unsupported configurator mode: ${mode}`);
}

const configuratorAdapter = createConfiguratorAdapter(CONFIGURATOR_MODE);
const MAX_IMPORT_FILE_BYTES = 1024 * 1024;
const EXCLUDED_ADD_CATEGORIES = new Set(["cam_modules", "modems"]);
const safeDeviceIdPattern = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
let currentCandidate = null;
let originalCandidateJson = "";
let isDirty = false;
let activeSearch = "";
let activeCategory = "";
let selectedDeviceIndex = null;
let editorMode = "edit";
let addDraft = null;
let autoSelectedAddValidationProfileId = "";
let lastCandidateValidationJson = "";
let candidateValidationHasRun = false;
let assetInventory = {
  deviceImages: [],
  helpImages: []
};

function byId(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const element = byId(id);
  if (element) element.textContent = value;
}

function adapterCapabilities() {
  return configuratorAdapter.capabilities || {};
}

function canValidateCandidate() {
  return adapterCapabilities().canValidateCandidate !== false;
}

function canValidateFixture() {
  return adapterCapabilities().canValidateFixture !== false;
}

function assetPreviewMode() {
  return adapterCapabilities().assetPreviewMode || "none";
}

function staticValidationUnavailableResult(input) {
  return {
    ok: false,
    pass: false,
    exitCode: null,
    input,
    stdout: STATIC_VALIDATION_INSTRUCTIONS,
    stderr: "",
    error: "Validation is unavailable in static mode."
  };
}

function validationReadyMessage(message) {
  if (canValidateCandidate() || canValidateFixture()) return message;
  return STATIC_VALIDATION_INSTRUCTIONS;
}

function normalizeCatalogListDevice(device) {
  const source = isPlainObject(device) ? device : {};
  return {
    deviceId: normalizeString(source.deviceId),
    categoryId: normalizeString(source.categoryId),
    displayName: normalizeString(source.displayName),
    materialId: normalizeString(source.materialId),
    validationProfileId: normalizeString(source.validationProfileId),
    enabled: source.enabled !== false
  };
}

function normalizeCatalogCandidateDevice(device) {
  const source = isPlainObject(device) ? device : {};
  return {
    deviceId: normalizeString(source.deviceId),
    categoryId: normalizeString(source.categoryId),
    displayName: normalizeString(source.displayName),
    materialId: normalizeString(source.materialId),
    legacyMaterialIds: Array.isArray(source.legacyMaterialIds) ? source.legacyMaterialIds.map(normalizeString) : [],
    imagePath: normalizeString(source.imagePath),
    helpImagePath: normalizeString(source.helpImagePath),
    warningText: normalizeString(source.warningText),
    validationProfileId: normalizeString(source.validationProfileId),
    enabled: source.enabled !== false
  };
}

function buildCandidateFromCatalog(catalog) {
  const source = isPlainObject(catalog) ? catalog : {};
  const candidate = {
    schemaVersion: source.schemaVersion,
    revision: normalizeString(source.revision),
    devices: Array.isArray(source.devices) ? source.devices.map(normalizeCatalogCandidateDevice) : [],
    categoryHelp: isPlainObject(source.categoryHelp) ? source.categoryHelp : {},
    validationProfiles: Array.isArray(source.validationProfiles) ? source.validationProfiles.map(normalizeString) : [],
    generatedMaterialFilters: isPlainObject(source.generatedMaterialFilters) ? source.generatedMaterialFilters : {}
  };

  if (Object.prototype.hasOwnProperty.call(source, "runtimeContract")) {
    candidate.runtimeContract = cloneJson(source.runtimeContract);
  }

  return candidate;
}

function buildFixtureResponseFromCatalog(catalog, sourcePath) {
  const source = isPlainObject(catalog) ? catalog : {};
  const candidate = buildCandidateFromCatalog(source);
  const devices = Array.isArray(source.devices) ? source.devices.map(normalizeCatalogListDevice) : [];
  const categories = categorySummaries(devices);
  const enabledDeviceCount = devices.filter(device => device.enabled).length;

  return {
    ok: true,
    source: sourcePath,
    schemaVersion: source.schemaVersion,
    revision: source.revision || "",
    deviceCount: devices.length,
    enabledDeviceCount,
    disabledDeviceCount: devices.length - enabledDeviceCount,
    categoryCount: categories.length,
    categories,
    devices,
    candidate
  };
}

function staticAssetExtension(assetPath) {
  const lastSlash = assetPath.lastIndexOf("/");
  const fileName = lastSlash === -1 ? assetPath : assetPath.slice(lastSlash + 1);
  const lastDot = fileName.lastIndexOf(".");
  return lastDot === -1 ? "" : fileName.slice(lastDot).toLowerCase();
}

function safeStaticAssetPath(assetPath, policy) {
  const normalized = normalizeString(assetPath);
  if (!normalized.startsWith(policy.extensionPrefix)) return false;
  if (normalized.includes("\\") || normalized.includes("..")) return false;
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return false;
  if (/^(file|https?):\/\//i.test(normalized)) return false;

  const fileName = normalized.slice(policy.extensionPrefix.length);
  if (!fileName || fileName.includes("/")) return false;
  return STATIC_ASSET_EXTENSIONS.has(staticAssetExtension(normalized));
}

function normalizeManifestAsset(asset, policy) {
  const source = isPlainObject(asset) ? asset : {};
  const assetPath = normalizeString(source.path);
  if (!safeStaticAssetPath(assetPath, policy)) return null;

  const fileName = normalizeString(source.fileName) || assetPath.slice(policy.extensionPrefix.length);
  return {
    path: assetPath,
    fileName,
    kind: policy.kind
  };
}

function buildAssetInventoryFromManifest(manifest) {
  const source = isPlainObject(manifest) ? manifest : {};
  const inventory = {
    ok: true,
    policies: STATIC_ASSET_POLICIES.map(policy => ({
      key: policy.key,
      kind: policy.kind,
      extensionPrefix: policy.extensionPrefix
    }))
  };

  STATIC_ASSET_POLICIES.forEach(policy => {
    const assets = Array.isArray(source[policy.key]) ? source[policy.key] : [];
    inventory[policy.key] = assets
      .map(asset => normalizeManifestAsset(asset, policy))
      .filter(Boolean)
      .sort((left, right) => left.path.localeCompare(right.path));
  });

  return inventory;
}

function staticPreviewUrlForPath(assetPath) {
  return `../${assetPath.split("/").map(segment => encodeURIComponent(segment)).join("/")}`;
}

function setResultBadge(id, state, text) {
  const element = byId(id);
  if (!element) return;

  element.textContent = text;
  element.className = `result-badge result-${state}`;
}

function setValidationHint(message, state = "neutral") {
  const element = byId("validation-hint");
  if (!element) return;

  element.textContent = message;
  element.className = `validation-hint validation-hint-${state}`;
}

function renderCategories(categories) {
  const root = byId("category-list");
  if (!root) return;

  root.textContent = "";

  if (!Array.isArray(categories) || !categories.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No categories found in fixture.";
    root.appendChild(empty);
    return;
  }

  categories.forEach(category => {
    const item = document.createElement("span");
    item.className = "category-pill";
    item.textContent = `${category.categoryId} (${category.deviceCount})`;
    root.appendChild(item);
  });
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function normalizeString(value) {
  return String(value || "").trim();
}

function legacyMaterialIdsToText(value) {
  return Array.isArray(value) ? value.join("\n") : "";
}

function parseLegacyMaterialIds(value) {
  return String(value || "")
    .split(/[\n,]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function validationProfileOptions() {
  return Array.isArray(currentCandidate && currentCandidate.validationProfiles)
    ? currentCandidate.validationProfiles.map(profile => normalizeString(profile)).filter(Boolean)
    : [];
}

function addDeviceCategoryOptions() {
  const devices = Array.isArray(currentCandidate && currentCandidate.devices) ? currentCandidate.devices : [];
  return Array.from(new Set(devices.map(device => normalizeString(device.categoryId)).filter(Boolean)))
    .filter(categoryId => !EXCLUDED_ADD_CATEGORIES.has(categoryId))
    .sort((left, right) => left.localeCompare(right));
}

function assetOptionsForField(field) {
  if (field === "imagePath") return assetInventory.deviceImages;
  if (field === "helpImagePath") return assetInventory.helpImages;
  return [];
}

function categorySummaries(devices) {
  const categoriesById = new Map();

  devices.forEach(device => {
    const categoryId = device.categoryId || "(missing)";
    const existing = categoriesById.get(categoryId) || {
      categoryId,
      deviceCount: 0,
      enabledDeviceCount: 0,
      disabledDeviceCount: 0
    };

    existing.deviceCount += 1;
    if (device.enabled !== false) existing.enabledDeviceCount += 1;
    else existing.disabledDeviceCount += 1;
    categoriesById.set(categoryId, existing);
  });

  return Array.from(categoriesById.values()).sort((left, right) => left.categoryId.localeCompare(right.categoryId));
}

function setFormControlsReady(isReady) {
  ["device-search", "category-filter", "add-device-btn"].forEach(id => {
    const control = byId(id);
    if (control) control.disabled = !isReady;
  });
}

function resetFilterControls() {
  activeSearch = "";
  activeCategory = "";

  const search = byId("device-search");
  if (search) search.value = "";

  const category = byId("category-filter");
  if (category) category.value = "";
}

function updateRevertButton() {
  const button = byId("revert-candidate-btn");
  if (button) button.disabled = !currentCandidate || !isDirty;
}

function setAddDeviceActionsVisible(isVisible) {
  ["commit-add-device-btn", "cancel-add-device-btn"].forEach(id => {
    const button = byId(id);
    if (button) button.hidden = !isVisible;
  });

  const addButton = byId("add-device-btn");
  if (addButton) addButton.disabled = !currentCandidate || isVisible;
}

function populateCategoryFilter(categories) {
  const select = byId("category-filter");
  if (!select) return;

  const previousValue = select.value;
  select.textContent = "";

  const allOption = document.createElement("option");
  allOption.value = "";
  allOption.textContent = "All categories";
  select.appendChild(allOption);

  categories.forEach(category => {
    const option = document.createElement("option");
    option.value = category.categoryId;
    option.textContent = category.categoryId;
    select.appendChild(option);
  });

  select.value = categories.some(category => category.categoryId === previousValue) ? previousValue : "";
  activeCategory = select.value;
}

function regenerateMaterialFilters(candidate) {
  const filters = {};
  const seenByCategory = new Map();
  const devices = Array.isArray(candidate && candidate.devices) ? candidate.devices : [];

  devices.forEach(device => {
    if (!device || device.enabled === false) return;

    const categoryId = normalizeString(device.categoryId);
    const materialId = normalizeString(device.materialId);
    if (!categoryId || !materialId) return;

    if (!filters[categoryId]) {
      filters[categoryId] = [];
      seenByCategory.set(categoryId, new Set());
    }

    const seen = seenByCategory.get(categoryId);
    if (!seen.has(materialId)) {
      filters[categoryId].push(materialId);
      seen.add(materialId);
    }
  });

  return filters;
}

function deviceMatchesFilters(device) {
  const matchesCategory = !activeCategory || normalizeString(device.categoryId) === activeCategory;
  if (!matchesCategory) return false;

  const query = activeSearch.toLowerCase();
  if (!query) return true;

  return [
    device.deviceId,
    device.categoryId,
    device.displayName,
    device.materialId
  ].some(value => normalizeString(value).toLowerCase().includes(query));
}

function filteredDeviceEntries() {
  const devices = Array.isArray(currentCandidate && currentCandidate.devices) ? currentCandidate.devices : [];
  return devices
    .map((device, index) => ({ device, index }))
    .filter(entry => deviceMatchesFilters(entry.device));
}

function updateFilterStatus(visibleCount) {
  const totalCount = Array.isArray(currentCandidate && currentCandidate.devices) ? currentCandidate.devices.length : 0;
  setText("filter-status", currentCandidate ? `${visibleCount} of ${totalCount} devices shown` : "Waiting for fixture");
}

function selectedDevice() {
  if (!currentCandidate || !Array.isArray(currentCandidate.devices)) return null;
  if (selectedDeviceIndex === null || selectedDeviceIndex === undefined) return null;
  return currentCandidate.devices[selectedDeviceIndex] || null;
}

function selectedDeviceIsVisible(entries) {
  return entries.some(entry => entry.index === selectedDeviceIndex);
}

function ensureSelectedDevice(entries) {
  const devices = Array.isArray(currentCandidate && currentCandidate.devices) ? currentCandidate.devices : [];
  if (!devices.length) {
    selectedDeviceIndex = null;
    return;
  }

  if (selectedDeviceIndex === null || !devices[selectedDeviceIndex]) {
    selectedDeviceIndex = entries.length ? entries[0].index : 0;
  }
}

function renderFilteredDevices() {
  const entries = filteredDeviceEntries();
  ensureSelectedDevice(entries);
  renderDevices(entries);
  updateFilterStatus(entries.length);
  updateSelectedDeviceVisibility(entries);
  renderDeviceEditor();
}

function refreshDeviceList() {
  const entries = filteredDeviceEntries();
  renderDevices(entries);
  updateFilterStatus(entries.length);
  updateSelectedDeviceVisibility(entries);
}

function candidateForAction() {
  if (!currentCandidate) return null;

  const candidate = cloneJson(currentCandidate);
  candidate.devices = Array.isArray(candidate.devices) ? candidate.devices.map(device => ({
    ...device,
    displayName: normalizeString(device.displayName),
    materialId: normalizeString(device.materialId),
    legacyMaterialIds: Array.isArray(device.legacyMaterialIds) ? device.legacyMaterialIds.map(normalizeString).filter(Boolean) : [],
    imagePath: normalizeString(device.imagePath),
    helpImagePath: normalizeString(device.helpImagePath),
    warningText: normalizeString(device.warningText),
    validationProfileId: normalizeString(device.validationProfileId),
    enabled: device.enabled !== false
  })) : [];
  candidate.generatedMaterialFilters = regenerateMaterialFilters(candidate);
  currentCandidate.generatedMaterialFilters = cloneJson(candidate.generatedMaterialFilters);
  return candidate;
}

function candidateValidationFingerprint() {
  const candidate = candidateForAction();
  return candidate ? JSON.stringify(candidate) : "";
}

function resetValidationUi(message) {
  lastCandidateValidationJson = "";
  candidateValidationHasRun = false;
  setText("validation-target", "-");
  setResultBadge("validation-status", "neutral", "Not run");
  setResultBadge("candidate-validation-status", "neutral", "Not validated");
  setText("validation-exit-code", "-");
  setText("validation-input", "temp-candidate.json");
  setText("validation-stdout", "Validation output will appear here.");
  setText("validation-stderr", "Validation errors will appear here.");
  setValidationHint(validationReadyMessage(message || "Run Validate Candidate to validate the current browser-memory candidate."));
}

function markCandidateValidationStaleIfNeeded() {
  if (!candidateValidationHasRun) return;

  const currentJson = candidateValidationFingerprint();
  if (currentJson && currentJson !== lastCandidateValidationJson) {
    setResultBadge("candidate-validation-status", "stale", "Unvalidated changes");
    setValidationHint("Candidate changed after the last validation. Run Validate Candidate again before exporting or publishing.", "stale");
  }
}

function updateSummaryFromCandidate() {
  const devices = Array.isArray(currentCandidate && currentCandidate.devices) ? currentCandidate.devices : [];
  const categories = categorySummaries(devices);
  const enabledCount = devices.filter(device => device.enabled !== false).length;

  setText("device-count", String(devices.length));
  setText("enabled-count", `${enabledCount} / ${devices.length - enabledCount}`);
  setText("category-count", String(categories.length));
  renderCategories(categories);
  populateCategoryFilter(categories);
}

function updateDirtyState() {
  if (!currentCandidate) {
    isDirty = false;
    setText("edit-status", "Unavailable");
    return;
  }

  isDirty = JSON.stringify(currentCandidate) !== originalCandidateJson;
  setText("edit-status", isDirty ? "Edited in browser memory" : "Clean");
  updateRevertButton();
  setAddDeviceActionsVisible(editorMode === "add");
}

function updateDeviceField(index, field, value) {
  if (!currentCandidate || !Array.isArray(currentCandidate.devices) || !currentCandidate.devices[index]) return;

  const device = currentCandidate.devices[index];
  if (field === "legacyMaterialIds") {
    device.legacyMaterialIds = parseLegacyMaterialIds(value);
  } else if (field === "enabled") {
    device.enabled = Boolean(value);
    updateSummaryFromCandidate();
  } else {
    device[field] = normalizeString(value);
  }

  if (field === "materialId" || field === "enabled") {
    currentCandidate.generatedMaterialFilters = regenerateMaterialFilters(currentCandidate);
  }

  updateDirtyState();
  markCandidateValidationStaleIfNeeded();
  setText("export-status", isDirty ? "Edited candidate ready" : "Ready");
  updateFilterStatus(filteredDeviceEntries().length);
}

function createEmptyAddDraft() {
  const categories = addDeviceCategoryOptions();
  return {
    deviceId: "",
    categoryId: categories[0] || "",
    displayName: "",
    materialId: "",
    legacyMaterialIds: [],
    imagePath: "",
    helpImagePath: "",
    warningText: "",
    validationProfileId: "",
    enabled: true
  };
}

function updateAddDraftField(field, value) {
  if (!addDraft) return;

  if (field === "legacyMaterialIds") {
    addDraft.legacyMaterialIds = parseLegacyMaterialIds(value);
  } else if (field === "enabled") {
    addDraft.enabled = Boolean(value);
  } else {
    addDraft[field] = normalizeString(value);
  }

  if (field === "validationProfileId") {
    autoSelectedAddValidationProfileId = "";
  } else if (field === "categoryId") {
    clearAddDraftValidationProfileIfOutOfCategory(addDraft);
  }

  setText("add-device-status", addDeviceCategoryWarning(addDraft.categoryId));
}

function addDeviceCategoryWarning(categoryId) {
  if (categoryId === "gpon" || categoryId === "austrian") {
    return "Warning: this category has validator material filter/order guards. Run Validate Candidate before using the export.";
  }
  return "";
}

function validationProfileUsageForCategory(categoryId) {
  const normalizedCategoryId = normalizeString(categoryId);
  const devices = Array.isArray(currentCandidate && currentCandidate.devices) ? currentCandidate.devices : [];
  const usage = new Map();

  devices.forEach(device => {
    if (normalizeString(device.categoryId) !== normalizedCategoryId) return;
    const profileId = normalizeString(device.validationProfileId);
    if (!profileId) return;
    usage.set(profileId, (usage.get(profileId) || 0) + 1);
  });

  return Array.from(usage.entries())
    .map(([profileId, count]) => ({ profileId, count }))
    .sort((left, right) => right.count - left.count || left.profileId.localeCompare(right.profileId));
}

function inferredValidationProfileForCategory(categoryId) {
  const usage = validationProfileUsageForCategory(categoryId);
  return usage.length === 1 ? usage[0].profileId : "";
}

function validationProfileOptionsForAddDraft(draft) {
  const usage = validationProfileUsageForCategory(draft && draft.categoryId);
  return usage.length ? usage.map(item => item.profileId) : validationProfileOptions();
}

function categoryUsesValidationProfile(categoryId, profileId) {
  const normalizedProfileId = normalizeString(profileId);
  if (!normalizedProfileId) return true;

  const usage = validationProfileUsageForCategory(categoryId);
  return !usage.length || usage.some(item => item.profileId === normalizedProfileId);
}

function clearAddDraftValidationProfileIfOutOfCategory(draft) {
  if (!draft) return "";

  const currentProfileId = normalizeString(draft.validationProfileId);
  if (!currentProfileId || categoryUsesValidationProfile(draft.categoryId, currentProfileId)) {
    return "";
  }

  draft.validationProfileId = "";
  autoSelectedAddValidationProfileId = "";
  return currentProfileId;
}

function applyAddDraftValidationProfileSuggestion(draft) {
  if (!draft) return "";

  clearAddDraftValidationProfileIfOutOfCategory(draft);

  const currentProfileId = normalizeString(draft.validationProfileId);
  const wasAutoSelected = Boolean(currentProfileId && currentProfileId === autoSelectedAddValidationProfileId);
  const inferredProfileId = inferredValidationProfileForCategory(draft.categoryId);

  if (currentProfileId && !wasAutoSelected) return "";

  if (!inferredProfileId) {
    if (wasAutoSelected) {
      draft.validationProfileId = "";
      autoSelectedAddValidationProfileId = "";
    }
    return "";
  }

  if (inferredProfileId) {
    draft.validationProfileId = inferredProfileId;
    autoSelectedAddValidationProfileId = inferredProfileId;
  }

  return inferredProfileId;
}

function validationProfileHintForAddDraft(draft, suggestedProfileId) {
  const categoryId = normalizeString(draft && draft.categoryId);
  if (!categoryId) return "Select a category before choosing validationProfileId.";

  const usage = validationProfileUsageForCategory(categoryId);
  if (!usage.length) return "Choose validationProfileId from the loaded predefined profiles.";

  if (usage.length === 1) {
    const profileId = usage[0].profileId;
    return suggestedProfileId === profileId
      ? `Suggested from selected category: ${profileId}.`
      : `Selected category currently uses: ${profileId}.`;
  }

  const profiles = usage.map(item => `${item.profileId} (${item.count})`).join(", ");
  return `This category has multiple profiles. Choose one manually: ${profiles}.`;
}

function validateAddDraft() {
  const errors = [];
  const profiles = new Set(validationProfileOptions());
  const categories = new Set(addDeviceCategoryOptions());
  const deviceId = normalizeString(addDraft && addDraft.deviceId);
  const categoryId = normalizeString(addDraft && addDraft.categoryId);
  const displayName = normalizeString(addDraft && addDraft.displayName);
  const materialId = normalizeString(addDraft && addDraft.materialId);
  const validationProfileId = normalizeString(addDraft && addDraft.validationProfileId);
  const legacyMaterialIds = Array.isArray(addDraft && addDraft.legacyMaterialIds) ? addDraft.legacyMaterialIds.map(normalizeString).filter(Boolean) : [];
  const existingDeviceIds = new Set(((currentCandidate && currentCandidate.devices) || []).map(device => normalizeString(device.deviceId)));
  const invalidLegacyMaterialIds = legacyMaterialIds.filter(id => !/^\d+$/.test(id));

  if (!deviceId) errors.push("deviceId is required.");
  else if (!safeDeviceIdPattern.test(deviceId)) errors.push("deviceId must use lower snake-case with lowercase letters, numbers, and underscores.");
  else if (existingDeviceIds.has(deviceId)) errors.push(`deviceId ${deviceId} already exists.`);

  if (!categoryId) errors.push("categoryId is required.");
  else if (!categories.has(categoryId)) errors.push("categoryId must be one of the loaded normal device categories.");

  if (!displayName) errors.push("displayName is required.");

  if (materialId && !/^\d+$/.test(materialId)) errors.push("materialId must contain digits only.");
  if (invalidLegacyMaterialIds.length) errors.push(`legacyMaterialIds must contain digits only: ${invalidLegacyMaterialIds.join(", ")}.`);

  if (!validationProfileId) errors.push("validationProfileId is required.");
  else if (!profiles.has(validationProfileId)) errors.push("validationProfileId must be selected from the loaded validationProfiles list.");

  const device = {
    deviceId,
    categoryId,
    displayName,
    materialId,
    legacyMaterialIds,
    imagePath: normalizeString(addDraft && addDraft.imagePath),
    helpImagePath: normalizeString(addDraft && addDraft.helpImagePath),
    warningText: normalizeString(addDraft && addDraft.warningText),
    validationProfileId,
    enabled: addDraft ? addDraft.enabled !== false : true
  };

  return {
    ok: errors.length === 0,
    errors,
    warning: addDeviceCategoryWarning(categoryId),
    device
  };
}

function syncAssetSelect(select, value) {
  const normalized = normalizeString(value);
  select.value = Array.from(select.options).some(option => option.value === normalized) ? normalized : "";
}

function previewUrlForAssetPath(value) {
  const normalized = normalizeString(value);
  if (!normalized) return "";
  if (assetPreviewMode() === "none") return "";
  return configuratorAdapter.previewUrlForPath(normalized);
}

function setAssetPreview(preview, value) {
  if (!preview) return;
  const url = previewUrlForAssetPath(value);
  preview.textContent = "";

  if (!url) {
    preview.className = "asset-preview asset-preview-empty";
    preview.textContent = "No preview";
    return;
  }

  const image = document.createElement("img");
  image.src = url;
  image.alt = "";
  image.loading = "lazy";
  image.addEventListener("error", () => {
    preview.textContent = "";
    preview.className = "asset-preview asset-preview-empty";
    preview.textContent = "No preview";
  });

  preview.className = "asset-preview";
  preview.appendChild(image);
}

function readonlyCell(row, value) {
  const cell = document.createElement("td");
  cell.textContent = value || "";
  row.appendChild(cell);
}

function enabledListCell(row, device) {
  const cell = document.createElement("td");
  const status = document.createElement("span");
  status.className = device.enabled === false ? "status-badge status-disabled" : "status-badge status-enabled";
  status.textContent = device.enabled === false ? "disabled" : "enabled";
  cell.appendChild(status);
  row.appendChild(cell);
}

function selectDevice(index) {
  editorMode = "edit";
  addDraft = null;
  autoSelectedAddValidationProfileId = "";
  setText("add-device-status", "");
  selectedDeviceIndex = index;
  renderFilteredDevices();
}

function updateSelectedDeviceVisibility(entries) {
  const device = selectedDevice();
  if (!device) {
    setText("selected-device-status", "No device selected");
    return;
  }

  const suffix = selectedDeviceIsVisible(entries) ? "" : " (hidden by filters)";
  setText("selected-device-status", `${device.deviceId}${suffix}`);
}

function renderDevices(entries) {
  const body = byId("device-table-body");
  if (!body) return;

  body.textContent = "";

  if (!Array.isArray(entries) || !entries.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = currentCandidate ? "No devices match the current filters." : "No devices found in fixture.";
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }

  entries.forEach(entry => {
    const { device, index } = entry;
    const row = document.createElement("tr");
    row.className = index === selectedDeviceIndex ? "selected-row" : "";
    row.tabIndex = 0;
    row.dataset.deviceIndex = String(index);
    row.addEventListener("click", () => selectDevice(index));
    row.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectDevice(index);
      }
    });
    readonlyCell(row, device.deviceId);
    readonlyCell(row, device.categoryId);
    readonlyCell(row, device.displayName);
    readonlyCell(row, device.materialId);
    enabledListCell(row, device);
    body.appendChild(row);
  });
}

function setEditorControlsEnabled(isEnabled) {
  [
    "editor-displayName",
    "editor-materialId",
    "editor-legacyMaterialIds",
    "editor-imagePath",
    "editor-imagePath-select",
    "editor-helpImagePath",
    "editor-helpImagePath-select",
    "editor-warningText",
    "editor-validationProfileId",
    "editor-enabled"
  ].forEach(id => {
    const control = byId(id);
    if (control) control.disabled = !isEnabled;
  });
}

function populateAssetSelect(select, field, value) {
  if (!select) return;
  select.textContent = "";

  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = "Manual / empty";
  select.appendChild(emptyOption);

  assetOptionsForField(field).forEach(asset => {
    const option = document.createElement("option");
    option.value = asset.path;
    option.textContent = asset.fileName;
    select.appendChild(option);
  });

  syncAssetSelect(select, value);
}

function populateValidationProfileSelect(select, value, options = {}) {
  if (!select) return;
  select.textContent = "";

  if (options.includeBlank) {
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "Select validationProfileId";
    select.appendChild(blank);
  }

  const profileIds = Array.isArray(options.profileIds) ? options.profileIds : validationProfileOptions();
  profileIds.forEach(profileId => {
    const option = document.createElement("option");
    option.value = profileId;
    option.textContent = profileId;
    select.appendChild(option);
  });

  select.value = normalizeString(value);
}

function populateAddCategorySelect(select, value) {
  if (!select) return;
  select.textContent = "";

  addDeviceCategoryOptions().forEach(categoryId => {
    const option = document.createElement("option");
    option.value = categoryId;
    option.textContent = categoryId;
    select.appendChild(option);
  });

  select.value = normalizeString(value);
}

function setAddOnlyFieldsVisible(isVisible) {
  Array.from(document.querySelectorAll(".add-only-field")).forEach(field => {
    field.hidden = !isVisible;
    Array.from(field.querySelectorAll("input, select, textarea")).forEach(control => {
      control.disabled = !isVisible;
    });
  });
}

function renderDeviceEditor() {
  if (editorMode === "add") {
    const draft = addDraft || createEmptyAddDraft();
    addDraft = draft;
    const suggestedProfileId = applyAddDraftValidationProfileSuggestion(draft);

    setEditorControlsEnabled(true);
    setAddOnlyFieldsVisible(true);
    setAddDeviceActionsVisible(true);
    setText("device-editor-heading", "Add device");
    setText("selected-device-status", "Draft device");
    setText("editor-deviceId", normalizeString(draft.deviceId) || "(new)");
    setText("editor-categoryId", normalizeString(draft.categoryId) || "-");
    setText("add-device-status", addDeviceCategoryWarning(draft.categoryId));

    const deviceIdInput = byId("editor-deviceId-input");
    if (deviceIdInput) deviceIdInput.value = normalizeString(draft.deviceId);
    populateAddCategorySelect(byId("editor-categoryId-select"), draft.categoryId);

    const textControls = {
      "editor-displayName": normalizeString(draft.displayName),
      "editor-materialId": normalizeString(draft.materialId),
      "editor-legacyMaterialIds": legacyMaterialIdsToText(draft.legacyMaterialIds),
      "editor-imagePath": normalizeString(draft.imagePath),
      "editor-helpImagePath": normalizeString(draft.helpImagePath),
      "editor-warningText": normalizeString(draft.warningText)
    };

    Object.entries(textControls).forEach(([id, value]) => {
      const control = byId(id);
      if (control) control.value = value;
    });

    populateAssetSelect(byId("editor-imagePath-select"), "imagePath", draft.imagePath);
    populateAssetSelect(byId("editor-helpImagePath-select"), "helpImagePath", draft.helpImagePath);
    populateValidationProfileSelect(byId("editor-validationProfileId"), draft.validationProfileId, {
      includeBlank: true,
      profileIds: validationProfileOptionsForAddDraft(draft)
    });
    setText("validation-profile-hint", validationProfileHintForAddDraft(draft, suggestedProfileId));
    setAssetPreview(byId("editor-imagePath-preview"), draft.imagePath);
    setAssetPreview(byId("editor-helpImagePath-preview"), draft.helpImagePath);

    const enabled = byId("editor-enabled");
    if (enabled) enabled.checked = draft.enabled !== false;
    return;
  }

  const device = selectedDevice();
  const hasDevice = Boolean(device);

  setEditorControlsEnabled(hasDevice);
  setAddOnlyFieldsVisible(false);
  setAddDeviceActionsVisible(false);
  setText("device-editor-heading", "Device editor");
  setText("add-device-status", "");
  setText("validation-profile-hint", "");
  setText("editor-deviceId", hasDevice ? device.deviceId : "-");
  setText("editor-categoryId", hasDevice ? device.categoryId : "-");

  const textControls = {
    "editor-displayName": hasDevice ? normalizeString(device.displayName) : "",
    "editor-materialId": hasDevice ? normalizeString(device.materialId) : "",
    "editor-legacyMaterialIds": hasDevice ? legacyMaterialIdsToText(device.legacyMaterialIds) : "",
    "editor-imagePath": hasDevice ? normalizeString(device.imagePath) : "",
    "editor-helpImagePath": hasDevice ? normalizeString(device.helpImagePath) : "",
    "editor-warningText": hasDevice ? normalizeString(device.warningText) : ""
  };

  Object.entries(textControls).forEach(([id, value]) => {
    const control = byId(id);
    if (control) control.value = value;
  });

  populateAssetSelect(byId("editor-imagePath-select"), "imagePath", hasDevice ? device.imagePath : "");
  populateAssetSelect(byId("editor-helpImagePath-select"), "helpImagePath", hasDevice ? device.helpImagePath : "");
  populateValidationProfileSelect(byId("editor-validationProfileId"), hasDevice ? device.validationProfileId : "");
  setAssetPreview(byId("editor-imagePath-preview"), hasDevice ? device.imagePath : "");
  setAssetPreview(byId("editor-helpImagePath-preview"), hasDevice ? device.helpImagePath : "");

  const enabled = byId("editor-enabled");
  if (enabled) enabled.checked = hasDevice ? device.enabled !== false : false;

  if (!hasDevice) {
    setText("selected-device-status", currentCandidate ? "No device selected" : "Waiting for fixture");
  }
}

function renderFixture(data) {
  currentCandidate = data.candidate ? cloneJson(data.candidate) : null;
  originalCandidateJson = currentCandidate ? JSON.stringify(currentCandidate) : "";
  selectedDeviceIndex = null;
  editorMode = "edit";
  addDraft = null;
  autoSelectedAddValidationProfileId = "";
  resetFilterControls();
  setText("fixture-status", data.ok ? "Loaded" : "Failed");
  setText("export-status", currentCandidate ? "Ready" : "Unavailable");
  resetValidationUi("Loaded the project fixture. Run Validate Fixture or Validate Candidate to see the latest validation result.");
  setText("import-status", "Import status: No candidate imported.");
  setText("fixture-source", `Fixture: ${data.source || "Extension/config/recycle-device-catalog.fixture.json"}`);
  setText("schema-version", String(data.schemaVersion ?? "-"));
  setText("revision", data.revision || "-");
  setText("device-count", String(data.deviceCount ?? "-"));
  setText("enabled-count", `${data.enabledDeviceCount ?? "-"} / ${data.disabledDeviceCount ?? "-"}`);
  setText("category-count", String(data.categoryCount ?? "-"));
  if (currentCandidate) {
    updateSummaryFromCandidate();
    renderFilteredDevices();
  } else {
    renderCategories(data.categories);
    renderDevices((data.devices || []).map((device, index) => ({ device, index })));
    updateFilterStatus(0);
    renderDeviceEditor();
  }
  updateDirtyState();
  setExportReady(Boolean(currentCandidate));
  setFormControlsReady(Boolean(currentCandidate));
}

function renderError(error) {
  currentCandidate = null;
  originalCandidateJson = "";
  selectedDeviceIndex = null;
  editorMode = "edit";
  addDraft = null;
  autoSelectedAddValidationProfileId = "";
  lastCandidateValidationJson = "";
  candidateValidationHasRun = false;
  activeSearch = "";
  activeCategory = "";
  setText("fixture-status", "Failed");
  setText("export-status", "Unavailable");
  setText("import-status", "Import status: Fixture load failed.");
  setText("validation-target", "-");
  setResultBadge("validation-status", "error", "ERROR");
  setResultBadge("candidate-validation-status", "neutral", "Not run");
  setValidationHint("Fixture could not be loaded. Check the error details and local server output.", "fail");
  updateFilterStatus(0);
  updateDirtyState();
  setExportReady(false);
  setFormControlsReady(false);
  const body = byId("device-table-body");
  if (body) {
    body.textContent = "";
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = `Cannot load fixture: ${error.message}`;
    row.appendChild(cell);
    body.appendChild(row);
  }
  renderDeviceEditor();
}

function applyFiltersFromControls() {
  const search = byId("device-search");
  const category = byId("category-filter");
  activeSearch = normalizeString(search && search.value);
  activeCategory = normalizeString(category && category.value);
  renderFilteredDevices();
}

function revertCandidate() {
  if (!originalCandidateJson) return;

  currentCandidate = JSON.parse(originalCandidateJson);
  selectedDeviceIndex = null;
  editorMode = "edit";
  addDraft = null;
  autoSelectedAddValidationProfileId = "";
  setText("export-status", "Ready");
  resetValidationUi("Reverted to the loaded baseline. Run Validate Candidate to validate the current browser-memory candidate.");
  updateSummaryFromCandidate();
  renderFilteredDevices();
  updateDirtyState();
}

function validateImportedCandidateShape(candidate) {
  const errors = [];

  if (!isPlainObject(candidate)) {
    return ["JSON root must be an object."];
  }

  if (candidate.schemaVersion === undefined) errors.push("schemaVersion is missing.");
  if (!normalizeString(candidate.revision)) errors.push("revision is missing.");
  if (!Array.isArray(candidate.devices)) errors.push("devices must be an array.");
  if (!isPlainObject(candidate.categoryHelp)) errors.push("categoryHelp must be an object.");
  if (!Array.isArray(candidate.validationProfiles)) errors.push("validationProfiles must be an array.");
  if (!isPlainObject(candidate.generatedMaterialFilters)) errors.push("generatedMaterialFilters must be an object.");

  return errors;
}

function setCurrentCandidateFromImport(candidate, fileName) {
  currentCandidate = cloneJson(candidate);
  originalCandidateJson = JSON.stringify(currentCandidate);
  selectedDeviceIndex = null;
  editorMode = "edit";
  addDraft = null;
  autoSelectedAddValidationProfileId = "";
  resetFilterControls();
  setText("fixture-status", "Imported");
  setText("fixture-source", `Imported candidate: ${fileName}`);
  setText("import-status", `Import status: Loaded ${fileName}.`);
  setText("export-status", "Ready");
  resetValidationUi("Imported candidate loaded. Basic shape checks passed, but Validate Candidate is still required.");
  updateSummaryFromCandidate();
  renderFilteredDevices();
  updateDirtyState();
  setExportReady(true);
  setFormControlsReady(true);
}

async function importCandidateFile(file) {
  if (!file) return;

  const isJsonFile = /\.json$/i.test(file.name || "") || file.type === "application/json";
  if (!isJsonFile) {
    setText("import-status", `Import status: ${file.name || "Selected file"} is not a JSON file.`);
    setValidationHint("Candidate import failed before loading. Choose a .json or application/json file.", "fail");
    return;
  }

  if (file.size > MAX_IMPORT_FILE_BYTES) {
    setText("import-status", `Import status: ${file.name} is too large. Limit is 1 MB.`);
    setValidationHint("Candidate import failed before loading. Choose a JSON file under 1 MB.", "fail");
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (error) {
    setText("import-status", `Import status: ${file.name} is not valid JSON.`);
    setValidationHint("Candidate import failed because the selected file is not valid JSON.", "fail");
    return;
  }

  const shapeErrors = validateImportedCandidateShape(parsed);
  if (shapeErrors.length) {
    setText("import-status", `Import status: ${file.name} failed basic shape checks.`);
    setValidationHint(`Candidate import failed: ${shapeErrors.join(" ")}`, "fail");
    return;
  }

  setCurrentCandidateFromImport(parsed, file.name);
}

function reloadFixture() {
  if (isDirty && !window.confirm("Discard browser-memory edits and reload the project fixture?")) {
    return;
  }

  loadFixture();
}

function handleEditorTextInput(event) {
  if (editorMode === "add") {
    const field = event.target.dataset.editorField;
    updateAddDraftField(field, event.target.value);

    if (field === "imagePath") {
      syncAssetSelect(byId("editor-imagePath-select"), event.target.value);
      setAssetPreview(byId("editor-imagePath-preview"), event.target.value);
    } else if (field === "helpImagePath") {
      syncAssetSelect(byId("editor-helpImagePath-select"), event.target.value);
      setAssetPreview(byId("editor-helpImagePath-preview"), event.target.value);
    }
    return;
  }

  if (selectedDeviceIndex === null) return;
  const field = event.target.dataset.editorField;
  updateDeviceField(selectedDeviceIndex, field, event.target.value);

  if (field === "imagePath") {
    syncAssetSelect(byId("editor-imagePath-select"), event.target.value);
    setAssetPreview(byId("editor-imagePath-preview"), event.target.value);
  } else if (field === "helpImagePath") {
    syncAssetSelect(byId("editor-helpImagePath-select"), event.target.value);
    setAssetPreview(byId("editor-helpImagePath-preview"), event.target.value);
  }

  refreshDeviceList();
}

function handleEditorSelectChange(event) {
  if (editorMode === "add") {
    const field = event.target.dataset.editorField;
    const value = event.target.value;
    const input = byId(`editor-${field}`);

    if (input) input.value = value;
    updateAddDraftField(field, value);

    if (field === "imagePath") {
      setAssetPreview(byId("editor-imagePath-preview"), value);
    } else if (field === "helpImagePath") {
      setAssetPreview(byId("editor-helpImagePath-preview"), value);
    }
    return;
  }

  if (selectedDeviceIndex === null) return;
  const field = event.target.dataset.editorField;
  const value = event.target.value;
  const input = byId(`editor-${field}`);

  if (input) input.value = value;
  updateDeviceField(selectedDeviceIndex, field, value);

  if (field === "imagePath") {
    setAssetPreview(byId("editor-imagePath-preview"), value);
  } else if (field === "helpImagePath") {
    setAssetPreview(byId("editor-helpImagePath-preview"), value);
  }

  refreshDeviceList();
}

function handleEditorEnabledChange(event) {
  if (editorMode === "add") {
    updateAddDraftField("enabled", event.target.checked);
    return;
  }

  if (selectedDeviceIndex === null) return;
  updateDeviceField(selectedDeviceIndex, "enabled", event.target.checked);
  refreshDeviceList();
}

function handleAddTextInput(event) {
  const field = event.target.dataset.addField;
  updateAddDraftField(field, event.target.value);
  if (field === "deviceId") {
    setText("editor-deviceId", normalizeString(event.target.value) || "(new)");
  }
}

function handleAddCategoryChange(event) {
  updateAddDraftField("categoryId", event.target.value);
  renderDeviceEditor();
}

function startAddDevice() {
  if (!currentCandidate) return;
  editorMode = "add";
  addDraft = createEmptyAddDraft();
  autoSelectedAddValidationProfileId = "";
  setText("add-device-status", "");
  renderDeviceEditor();
}

function cancelAddDevice() {
  editorMode = "edit";
  addDraft = null;
  autoSelectedAddValidationProfileId = "";
  setText("add-device-status", "");
  renderFilteredDevices();
}

function commitAddDevice() {
  if (!currentCandidate || !Array.isArray(currentCandidate.devices) || !addDraft) return;

  const result = validateAddDraft();
  if (!result.ok) {
    setText("add-device-status", `Cannot add device: ${result.errors.join(" ")}`);
    return;
  }

  currentCandidate.devices.push(result.device);
  currentCandidate.generatedMaterialFilters = regenerateMaterialFilters(currentCandidate);
  selectedDeviceIndex = currentCandidate.devices.length - 1;
  editorMode = "edit";
  addDraft = null;
  autoSelectedAddValidationProfileId = "";

  activeSearch = "";
  activeCategory = result.device.categoryId;
  const search = byId("device-search");
  if (search) search.value = "";
  const category = byId("category-filter");
  if (category) category.value = result.device.categoryId;

  resetValidationUi("Added a browser-memory device. Run Validate Candidate before exporting or using the candidate JSON.");
  updateSummaryFromCandidate();
  const refreshedCategory = byId("category-filter");
  if (refreshedCategory) refreshedCategory.value = result.device.categoryId;
  activeCategory = result.device.categoryId;
  renderFilteredDevices();
  updateDirtyState();
  setText("export-status", "Edited candidate ready");
  setText("add-device-status", result.warning || "");
}

function setupEditorControls() {
  [
    "editor-displayName",
    "editor-materialId",
    "editor-legacyMaterialIds",
    "editor-imagePath",
    "editor-helpImagePath",
    "editor-warningText"
  ].forEach(id => {
    const control = byId(id);
    if (control) control.addEventListener("input", handleEditorTextInput);
  });

  [
    "editor-imagePath-select",
    "editor-helpImagePath-select",
    "editor-validationProfileId"
  ].forEach(id => {
    const control = byId(id);
    if (control) control.addEventListener("change", handleEditorSelectChange);
  });

  const enabled = byId("editor-enabled");
  if (enabled) enabled.addEventListener("change", handleEditorEnabledChange);

  const addDeviceId = byId("editor-deviceId-input");
  if (addDeviceId) addDeviceId.addEventListener("input", handleAddTextInput);

  const addCategory = byId("editor-categoryId-select");
  if (addCategory) addCategory.addEventListener("change", handleAddCategoryChange);
}

function setExportReady(isReady) {
  const exportButton = byId("export-candidate-btn");
  if (exportButton) exportButton.disabled = !isReady;

  const validateCandidateButton = byId("validate-candidate-btn");
  if (validateCandidateButton) validateCandidateButton.disabled = !isReady || !canValidateCandidate();

  const validateFixtureButton = byId("validate-fixture-btn");
  if (validateFixtureButton) validateFixtureButton.disabled = !canValidateFixture();
}

function candidateFileName(candidate) {
  const revision = String(candidate && candidate.revision || "dev-current")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "dev-current";
  return `recycle-device-catalog.candidate.${revision}.json`;
}

function exportCandidate() {
  const candidate = candidateForAction();
  if (!candidate) {
    setText("export-status", "Fixture not loaded");
    return;
  }

  const json = `${JSON.stringify(candidate, null, 2)}\n`;
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const filename = candidateFileName(candidate);

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  setText("export-status", `Downloaded ${filename}`);
}

function setValidationRunning(isRunning) {
  const button = byId("validate-fixture-btn");
  if (button) {
    button.disabled = isRunning || !canValidateFixture();
    button.textContent = isRunning ? "Validating..." : "Validate Fixture";
  }
}

function setCandidateValidationRunning(isRunning) {
  const button = byId("validate-candidate-btn");
  if (button) {
    button.disabled = isRunning || !currentCandidate || !canValidateCandidate();
    button.textContent = isRunning ? "Validating Candidate..." : "Validate Candidate";
  }
}

function renderValidationResult(data) {
  setText("validation-target", "Fixture");
  setResultBadge("validation-status", data.pass ? "pass" : "fail", data.pass ? "PASS" : "FAIL");
  setText("validation-exit-code", data.exitCode === null || data.exitCode === undefined ? "-" : String(data.exitCode));
  setText("validation-input", data.input || "Extension/config/recycle-device-catalog.fixture.json");
  setText("validation-stdout", data.stdout || "(empty)");
  setText("validation-stderr", data.stderr || "(empty)");
  setValidationHint(
    data.pass
      ? "Fixture validation passed. The checked project fixture is valid."
      : "Fixture validation failed. This may indicate a project/config issue.",
    data.pass ? "pass" : "fail"
  );
}

function renderCandidateValidationResult(data, candidateJson) {
  candidateValidationHasRun = true;
  lastCandidateValidationJson = candidateJson;
  setText("validation-target", "Candidate");
  setResultBadge("candidate-validation-status", data.pass ? "pass" : "fail", data.pass ? "PASS" : "FAIL");
  setResultBadge("validation-status", data.pass ? "pass" : "fail", data.pass ? "PASS" : "FAIL");
  setText("validation-exit-code", data.exitCode === null || data.exitCode === undefined ? "-" : String(data.exitCode));
  setText("validation-input", data.input || "temp-candidate.json");
  setText("validation-stdout", data.stdout || "(empty)");
  setText("validation-stderr", data.stderr || "(empty)");
  setValidationHint(
    data.pass
      ? "Candidate validation passed for the current browser-memory candidate."
      : "Candidate validation failed. Check the errors below. If this was only a test edit, use Revert changes.",
    data.pass ? "pass" : "fail"
  );
}

function renderValidationError(error) {
  setText("validation-target", "Fixture");
  setResultBadge("validation-status", "error", "ERROR");
  setText("validation-exit-code", "-");
  setText("validation-stdout", "(empty)");
  setText("validation-stderr", error.message);
  setValidationHint("Fixture validation could not complete. This may indicate a local project/tooling issue.", "fail");
}

function renderCandidateValidationError(error) {
  setText("validation-target", "Candidate");
  setResultBadge("candidate-validation-status", "error", "ERROR");
  setResultBadge("validation-status", "error", "ERROR");
  setText("validation-exit-code", "-");
  setText("validation-input", "temp-candidate.json");
  setText("validation-stdout", "(empty)");
  setText("validation-stderr", error.message);
  setValidationHint("Candidate validation could not complete. Check the errors below. If this was only a test edit, use Revert changes.", "fail");
}

async function validateCandidate() {
  if (!canValidateCandidate()) {
    renderCandidateValidationError(new Error("Candidate validation is not available in this configurator mode."));
    return;
  }

  const candidate = candidateForAction();
  if (!candidate) {
    setResultBadge("candidate-validation-status", "error", "No candidate loaded");
    setValidationHint("No browser-memory candidate is loaded yet.", "fail");
    return;
  }
  const candidateJson = JSON.stringify(candidate);

  setCandidateValidationRunning(true);
  setText("validation-target", "Candidate");
  setResultBadge("candidate-validation-status", "running", "Running");
  setResultBadge("validation-status", "running", "Running");
  setValidationHint("Candidate validation is running for the current browser-memory candidate.");
  setText("validation-exit-code", "-");
  setText("validation-input", "temp-candidate.json");
  setText("validation-stdout", "Running candidate validator...");
  setText("validation-stderr", "(empty)");

  try {
    const data = await configuratorAdapter.validateCandidate(candidate);
    renderCandidateValidationResult(data, candidateJson);
  } catch (error) {
    renderCandidateValidationError(error);
  } finally {
    setCandidateValidationRunning(false);
  }
}

async function validateFixture() {
  if (!canValidateFixture()) {
    renderValidationError(new Error("Fixture validation is not available in this configurator mode."));
    return;
  }

  setValidationRunning(true);
  setText("validation-target", "Fixture");
  setResultBadge("validation-status", "running", "Running");
  setValidationHint("Fixture validation is running against the fixed project fixture.");
  setText("validation-exit-code", "-");
  setText("validation-stdout", "Running validator...");
  setText("validation-stderr", "(empty)");

  try {
    const data = await configuratorAdapter.validateFixture();
    renderValidationResult(data);
  } catch (error) {
    renderValidationError(error);
  } finally {
    setValidationRunning(false);
  }
}

async function loadFixture() {
  try {
    const data = await configuratorAdapter.loadFixture();
    renderFixture(data);
  } catch (error) {
    renderError(error);
  }
}

async function loadAssetInventory() {
  try {
    const data = await configuratorAdapter.loadAssetInventory();
    assetInventory = {
      deviceImages: Array.isArray(data.deviceImages) ? data.deviceImages : [],
      helpImages: Array.isArray(data.helpImages) ? data.helpImages : []
    };
  } catch (error) {
    assetInventory = {
      deviceImages: [],
      helpImages: []
    };
    console.warn("Cannot load asset inventory", error);
  }
}

async function initialize() {
  setupEditorControls();
  await loadAssetInventory();
  await loadFixture();
}

initialize();

const validateButton = byId("validate-fixture-btn");
if (validateButton) {
  validateButton.addEventListener("click", validateFixture);
}

const exportButton = byId("export-candidate-btn");
if (exportButton) {
  exportButton.addEventListener("click", exportCandidate);
}

const validateCandidateButton = byId("validate-candidate-btn");
if (validateCandidateButton) {
  validateCandidateButton.addEventListener("click", validateCandidate);
}

const deviceSearch = byId("device-search");
if (deviceSearch) {
  deviceSearch.addEventListener("input", applyFiltersFromControls);
}

const categoryFilter = byId("category-filter");
if (categoryFilter) {
  categoryFilter.addEventListener("change", applyFiltersFromControls);
}

const revertButton = byId("revert-candidate-btn");
if (revertButton) {
  revertButton.addEventListener("click", revertCandidate);
}

const addDeviceButton = byId("add-device-btn");
if (addDeviceButton) {
  addDeviceButton.addEventListener("click", startAddDevice);
}

const commitAddDeviceButton = byId("commit-add-device-btn");
if (commitAddDeviceButton) {
  commitAddDeviceButton.addEventListener("click", commitAddDevice);
}

const cancelAddDeviceButton = byId("cancel-add-device-btn");
if (cancelAddDeviceButton) {
  cancelAddDeviceButton.addEventListener("click", cancelAddDevice);
}

const importCandidateInput = byId("import-candidate-input");
if (importCandidateInput) {
  importCandidateInput.addEventListener("change", event => {
    const file = event.target.files && event.target.files[0];
    importCandidateFile(file).finally(() => {
      event.target.value = "";
    });
  });
}

const reloadFixtureButton = byId("reload-fixture-btn");
if (reloadFixtureButton) {
  reloadFixtureButton.addEventListener("click", reloadFixture);
}
