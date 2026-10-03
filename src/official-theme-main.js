"use strict";

// ── Official theme main owner ──
//
// Single process-level owner of the official-theme catalog, installed-marker
// scan, one-at-a-time install/download operation, progress state and the
// uninstall/commit bodies that the settings controller runs under the shared
// `theme` domain lock.
//
// The renderer only ever sends a themeId. URL, version, target directory and
// digest are all re-resolved from the validated catalog or the on-disk marker
// on this side.

const defaultFs = require("node:fs");
const defaultPath = require("node:path");
const { pathToFileURL } = require("node:url");

const catalogModule = require("./official-theme-catalog");
const downloadModule = require("./official-theme-download");
const installerModule = require("./official-theme-installer");
const previewModule = require("./official-theme-preview");

const OFFICIAL_THEME_DIALOG_MAX_BYTES = 256 * 1024 * 1024;
const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DELETE_RETRY_BACKOFF_MS = [40, 120, 320];
// Bounded background recovery for a catalog fetch that failed. A first-run user
// on a slow or briefly unreachable link must not have to click "Refresh themes"
// to get the official list; two delayed re-attempts recover without turning the
// endpoint into something the app hammers.
const CATALOG_RETRY_BACKOFF_MS = Object.freeze([2000, 8000]);
const RELOAD_SETTLE_TIMEOUT_MS = 8000;
const PROGRESS_MIN_INTERVAL_MS = 250;
const PREVIEW_RESOLVE_CONCURRENCY = 4;

const MANAGER_ERROR_CODES = Object.freeze({
  BUSY: "OFFICIAL_THEME_BUSY",
  NOT_FOUND: "OFFICIAL_THEME_NOT_FOUND",
  UNSUPPORTED_VERSION: "OFFICIAL_THEME_UNSUPPORTED_VERSION",
  ALREADY_INSTALLED: "OFFICIAL_THEME_ALREADY_INSTALLED",
  REPAIR_REQUIRED: "OFFICIAL_THEME_REPAIR_REQUIRED",
  TARGET_CONFLICT: "OFFICIAL_THEME_TARGET_CONFLICT",
  SELECTION_FAILED: "OFFICIAL_THEME_SELECTION_FAILED",
  CATALOG_UNAVAILABLE: "OFFICIAL_THEME_CATALOG_UNAVAILABLE",
  NOT_MANAGED: "OFFICIAL_THEME_NOT_MANAGED",
  DELETE_FAILED: "OFFICIAL_THEME_DELETE_FAILED",
  INSTALL_FAILED: "OFFICIAL_THEME_INSTALL_FAILED",
});

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function managerError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBusyFsError(err) {
  return !!err && (err.code === "EBUSY" || err.code === "EPERM" || err.code === "EACCES");
}

async function mapWithConcurrency(items, limit, mapper) {
  const values = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      values[index] = await mapper(items[index], index);
    }
  }
  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return values;
}

// Bounded, backoff retry for Windows rename/rm that briefly holds a file handle
// after the renderer has dropped the old APNG. Exhaustion never continues the
// destructive step.
async function rmWithRetry(fs, target, pathModule, options = {}) {
  const retries = options.retries || DELETE_RETRY_BACKOFF_MS;
  let lastError = null;
  for (let attempt = 0; attempt <= retries.length; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return { ok: true };
    } catch (err) {
      lastError = err;
      if (!isBusyFsError(err)) return { ok: false, error: err };
      if (attempt < retries.length) await sleep(retries[attempt]);
    }
  }
  return { ok: false, error: lastError };
}

function createOfficialThemeMain(options = {}) {
  const app = options.app || null;
  const fs = options.fs || defaultFs;
  const path = options.path || defaultPath;
  const net = options.net || null;
  const themeLoader = options.themeLoader;
  const settingsController = options.settingsController;
  const userDataDir = options.userDataDir
    || (app && typeof app.getPath === "function" ? app.getPath("userData") : null);
  const getActiveTheme = options.getActiveTheme || (() => null);
  const waitForThemeReloadSettled = options.waitForThemeReloadSettled || (() => Promise.resolve({ status: "settled" }));
  const rebuildAllMenus = options.rebuildAllMenus || (() => {});
  const sendToSettingsWindow = options.sendToSettingsWindow || (() => {});
  const getAppVersion = options.getAppVersion
    || (() => (app && typeof app.getVersion === "function" ? app.getVersion() : "0.0.0"));
  const now = options.now || (() => Date.now());
  const nowIso = options.nowIso || (() => new Date().toISOString());
  const downloadImpl = options.downloadArchive || downloadModule.downloadArchive;
  const extractImpl = options.extractArchiveToStaging || installerModule.extractArchiveToStaging;
  const commitImpl = options.commitStagedInstall || installerModule.commitStagedInstall;
  const catalogFetch = options.fetchCatalogText || catalogModule.fetchCatalogText;
  const ensurePreviewFile = options.ensurePreviewFile || previewModule.ensurePreviewFile;
  const catalogRetryBackoffMs = Object.freeze(Array.isArray(options.catalogRetryBackoffMs)
    ? options.catalogRetryBackoffMs.filter((ms) => Number.isFinite(ms) && ms >= 0)
    : CATALOG_RETRY_BACKOFF_MS);

  if (!themeLoader) throw new Error("createOfficialThemeMain requires themeLoader");
  if (!settingsController) throw new Error("createOfficialThemeMain requires settingsController");
  if (!userDataDir) throw new Error("createOfficialThemeMain requires userDataDir or app");

  const dirs = downloadModule.officialThemeDirs(userDataDir, path);

  const state = {
    catalog: null,
    catalogStatus: "uninitialized",
    catalogReason: null,
    catalogCheckedAt: null,
    installed: new Map(),
    scanDone: false,
    operation: null,
    installInFlight: false,
    lastError: null,
    catalogPromise: null,
    catalogRetryAttempt: 0,
    catalogRetryTimer: null,
    catalogRetryPromise: null,
    lastFetchMs: 0,
    maxCatalogVersion: 0,
    previewPromises: new Map(),
    builtinThemeIds: null,
  };

  // ── Catalog ──

  function catalogEntry(id) {
    if (!state.catalog) return null;
    return state.catalog.themes.find((entry) => entry.id === id) || null;
  }

  function isBuiltinThemeId(themeId) {
    if (!state.builtinThemeIds) {
      state.builtinThemeIds = new Set(
        themeLoader.discoverThemes()
          .filter((theme) => theme && theme.builtin === true)
          .map((theme) => theme.id),
      );
    }
    return state.builtinThemeIds.has(themeId);
  }

  function readCache() {
    return catalogModule.readCatalogCache({ fs, path, userDataDir });
  }

  async function fetchAndValidate(signal) {
    const text = await catalogFetch({ net, signal, requestImpl: options.requestImpl });
    const parsed = catalogModule.parseCatalogText(text);
    return parsed;
  }

  // Every catalog attempt is stamped, not just the successful ones: without a
  // timestamp on the failure path the UI cannot say when it last checked and
  // the outage is undiagnosable after the window that produced it is gone.
  // A non-ok outcome is also persisted (see readCatalogAttemptMeta) so it
  // survives the process; a usable catalog clears that record.
  function recordCatalogAttempt(status, reason) {
    state.catalogStatus = status;
    state.catalogReason = status === "ok" ? null : (reason || null);
    state.catalogCheckedAt = nowIso();
    if (status === "ok") {
      catalogModule.clearCatalogAttemptMeta({ fs, path, userDataDir });
      return;
    }
    const written = catalogModule.writeCatalogAttemptMeta({
      fs,
      path,
      userDataDir,
      status,
      reason: state.catalogReason,
      checkedAt: state.catalogCheckedAt,
      catalogVersion: state.catalog ? state.catalog.catalogVersion : null,
    });
    if (!written) {
      console.warn("Clawd: official theme catalog attempt record write failed");
    }
  }

  // Shared report shape for listOfficialThemes() and getCatalogStatus(). The
  // persisted record backfills `checkedAt` when this process has not reached an
  // attempt of its own, so a cold start still answers "when did we last look?".
  function catalogStatusReport() {
    let checkedAt = state.catalogCheckedAt;
    if (!checkedAt) {
      const persisted = catalogModule.readCatalogAttemptMeta({ fs, path, userDataDir });
      checkedAt = persisted ? persisted.checkedAt : null;
    }
    return {
      catalogStatus: state.catalogStatus,
      catalogReason: state.catalogReason,
      catalogVersion: state.catalog ? state.catalog.catalogVersion : null,
      checkedAt,
    };
  }

  // A fetched catalog may never move the last-known-good version backwards.
  // The ceiling is the highest valid version among this process's in-memory LKG
  // AND the on-disk cache, checked BEFORE any state/cache mutation: a fresh
  // process starting at maxCatalogVersion=0 must still refuse a lower network
  // catalog when the disk cache holds a higher valid one.
  function adoptCatalog(nextCatalog) {
    const cache = readCache();
    const ceiling = Math.max(state.maxCatalogVersion, cache ? cache.catalogVersion : 0);
    if (nextCatalog.catalogVersion < ceiling) {
      // Do not overwrite the higher valid catalog; surface it so the caller can
      // report offline while the higher LKG stays in memory and on disk.
      if (!state.catalog || state.catalog.catalogVersion < ceiling) adoptCache();
      throw managerError(catalogModule.ERROR_CODES.CATALOG_REGRESSION, "catalog version regressed");
    }
    state.catalog = nextCatalog;
    state.maxCatalogVersion = nextCatalog.catalogVersion;
    const written = catalogModule.writeCatalogCache({
      fs,
      path,
      userDataDir,
      catalog: nextCatalog,
      now: nowIso,
    });
    if (!written) {
      // Keep the new in-memory last-known-good; a persistence failure must not
      // roll this process back to an older disk copy.
      console.warn("Clawd: official theme catalog cache write failed; keeping in-memory last-known-good");
    }
  }

  function adoptCache() {
    const cache = readCache();
    if (!cache) return false;
    // Never let a lower disk cache displace a higher in-memory last-known-good.
    if (state.catalog && cache.catalogVersion < state.maxCatalogVersion) return true;
    state.catalog = { catalogVersion: cache.catalogVersion, themes: cache.themes };
    state.maxCatalogVersion = Math.max(state.maxCatalogVersion, cache.catalogVersion);
    return true;
  }

  // One network attempt. Never touches the retry budget, so every caller —
  // first paint, an explicit refresh, a background retry — funnels through the
  // same single-flight and the same version ceiling.
  function ensureCatalogAttempt() {
    if (state.catalogPromise) return state.catalogPromise;
    state.catalogPromise = (async () => {
      try {
        const parsed = await fetchAndValidate(undefined);
        if (!parsed.ok) {
          if (!state.catalog) adoptCache();
          recordCatalogAttempt(
            state.catalog ? "offline" : "invalid",
            catalogModule.ERROR_CODES.CATALOG_INVALID,
          );
          return state.catalogStatus;
        }
        try {
          adoptCatalog(parsed.catalog);
        } catch (err) {
          if (err && err.code === catalogModule.ERROR_CODES.CATALOG_REGRESSION) {
            if (!state.catalog) adoptCache();
            recordCatalogAttempt(
              state.catalog ? "offline" : "invalid",
              catalogModule.ERROR_CODES.CATALOG_REGRESSION,
            );
            return state.catalogStatus;
          }
          throw err;
        }
        recordCatalogAttempt("ok", null);
        return state.catalogStatus;
      } catch (err) {
        if (!state.catalog) adoptCache();
        recordCatalogAttempt(
          "offline",
          (err && err.code) || catalogModule.ERROR_CODES.CATALOG_OFFLINE,
        );
        return state.catalogStatus;
      } finally {
        state.catalogPromise = null;
      }
    })();
    return state.catalogPromise;
  }

  // Schedules the next bounded background retry. `catalogRetryAttempt` only ever
  // increases, so a process spends a fixed extra-request budget over its
  // lifetime rather than re-entering this on every render; the timer is unref'd
  // so a pending retry can never keep the app alive on its own.
  function scheduleCatalogRetry() {
    if (state.catalogRetryTimer !== null) return;
    if (state.catalogRetryAttempt >= catalogRetryBackoffMs.length) return;
    const delayMs = catalogRetryBackoffMs[state.catalogRetryAttempt];
    state.catalogRetryAttempt += 1;
    const timer = setTimeout(() => {
      state.catalogRetryTimer = null;
      state.catalogRetryPromise = ensureCatalogAttempt()
        .then((status) => {
          if (status !== "ok") scheduleCatalogRetry();
          return status;
        })
        .catch(() => {
          scheduleCatalogRetry();
          return "offline";
        });
    }, delayMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    state.catalogRetryTimer = timer;
  }

  // Refreshes the catalog at most once per process unless `force`. A failed or
  // regressing catalog keeps the current last-known-good, records the attempt
  // and reports a list-level condition; it never wipes an installed theme.
  async function ensureCatalogReady(force = false) {
    if (state.catalog && state.catalogStatus === "ok" && !force) return state.catalogStatus;
    const status = await ensureCatalogAttempt();
    if (status !== "ok") scheduleCatalogRetry();
    return status;
  }

  // ── Installed scan ──

  function scanInstalled() {
    const map = new Map();
    let entries = [];
    try {
      entries = fs.readdirSync(dirs.themes, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (isBuiltinThemeId(entry.name)) continue;
      const themeDir = path.join(dirs.themes, entry.name);
      const marker = installerModule.readOfficialThemeMarker(themeDir, { fs, path });
      if (!marker) continue;
      if (marker.id !== entry.name) continue;
      let shapeOk = false;
      let errors = [];
      try {
        const shape = themeLoader.validateThemeShape(marker.id);
        shapeOk = !!(shape && shape.ok);
        errors = (shape && shape.errors) || [];
      } catch (err) {
        shapeOk = false;
        errors = [err && err.message];
      }
      map.set(marker.id, {
        id: marker.id,
        version: marker.version,
        archiveSha256: marker.archiveSha256,
        sourceRepository: marker.sourceRepository,
        themeDir,
        marker,
        repairRequired: !shapeOk,
        errors,
      });
    }
    state.installed = map;
    state.scanDone = true;
    return map;
  }

  function ensureScan() {
    if (!state.scanDone) scanInstalled();
    return state.installed;
  }

  function dirExists(target) {
    try {
      return !!fs.lstatSync(target);
    } catch {
      return false;
    }
  }

  function isManagedTheme(themeId) {
    if (typeof themeId !== "string" || !themeId) return false;
    if (state.installed.has(themeId)) return true;
    if (!state.scanDone) scanInstalled();
    return state.installed.has(themeId);
  }

  function progressSnapshot() {
    if (!state.operation) return null;
    return {
      id: state.operation.id,
      phase: state.operation.phase,
      receivedBytes: state.operation.receivedBytes || 0,
      totalBytes: state.operation.totalBytes || 0,
    };
  }

  function progressPercent(operation) {
    if (!operation || !(operation.totalBytes > 0)) return 0;
    return Math.min(100, Math.floor((operation.receivedBytes / operation.totalBytes) * 100));
  }

  function broadcastProgress({ throttled = false } = {}) {
    if (throttled && state.operation) {
      const currentMs = now();
      const percent = progressPercent(state.operation);
      const lastPercent = Number.isInteger(state.operation.lastBroadcastPercent)
        ? state.operation.lastBroadcastPercent
        : -1;
      const lastMs = Number.isFinite(state.operation.lastBroadcastAt)
        ? state.operation.lastBroadcastAt
        : 0;
      const finalByte = state.operation.totalBytes > 0
        && state.operation.receivedBytes >= state.operation.totalBytes;
      if (!finalByte && percent <= lastPercent && currentMs - lastMs < PROGRESS_MIN_INTERVAL_MS) {
        return false;
      }
    }
    try {
      sendToSettingsWindow("officialTheme:progress", {
        id: state.operation ? state.operation.id : null,
        phase: state.operation ? state.operation.phase : "idle",
        receivedBytes: state.operation ? state.operation.receivedBytes || 0 : 0,
        totalBytes: state.operation ? state.operation.totalBytes || 0 : 0,
      });
    } catch {}
    if (state.operation) {
      state.operation.lastBroadcastPercent = progressPercent(state.operation);
      state.operation.lastBroadcastAt = now();
    }
    return true;
  }

  function errorFor(id) {
    if (!state.lastError || state.lastError.id !== id) return null;
    return { code: state.lastError.code, message: state.lastError.message };
  }

  function buildOfficialCard(id, entry, installed) {
    return {
      id,
      officialTheme: true,
      officialThemeState: null,
      officialThemeVersion: entry ? entry.version : (installed ? installed.version : null),
      officialThemeInstalledVersion: installed ? installed.version : null,
      officialThemeCatalogVersion: state.catalog ? state.catalog.catalogVersion : null,
      officialThemeBytes: entry ? entry.archive.bytes : null,
      officialThemeUnpackedBytes: entry ? entry.archive.unpackedBytes : null,
      officialThemeProgress: state.operation && state.operation.id === id ? progressSnapshot() : null,
      officialThemeError: errorFor(id),
      officialThemeCanUninstall: !!installed,
      officialThemeConflict: false,
      officialThemeShowcaseUrl: entry && entry.showcase ? entry.showcase.url : null,
    };
  }

  async function resolvePreviewPath(entry) {
    if (!entry || !entry.preview) return null;
    const key = `${entry.id}:${entry.version}:${entry.preview.sha256}`;
    let pending = state.previewPromises.get(key);
    if (!pending) {
      pending = Promise.resolve(ensurePreviewFile({
        fs,
        path,
        net,
        requestImpl: options.requestImpl,
        entry,
        userDataDir,
      })).then((result) => (result && result.path) || null)
        .catch(() => null)
        .finally(() => state.previewPromises.delete(key));
      state.previewPromises.set(key, pending);
    }
    return pending;
  }

  async function listOfficialThemes() {
    await ensureCatalogReady();
    scanInstalled();
    const base = themeLoader.listThemesWithMetadata();
    const baseById = new Map(base.map((theme) => [theme.id, theme]));
    const ids = new Set();
    if (state.catalog) {
      for (const entry of state.catalog.themes) {
        if (!isBuiltinThemeId(entry.id)) ids.add(entry.id);
      }
    }
    for (const id of state.installed.keys()) {
      if (!isBuiltinThemeId(id)) ids.add(id);
    }

    const themes = await mapWithConcurrency([...ids], PREVIEW_RESOLVE_CONCURRENCY, async (id) => {
      const entry = catalogEntry(id);
      const installed = state.installed.get(id) || null;
      const baseTheme = baseById.get(id) || null;
      const builtinConflict = !!(baseTheme && baseTheme.builtin === true);
      const remotePreviewPath = !baseTheme || !baseTheme.previewFileUrl
        ? await resolvePreviewPath(entry)
        : null;
      const themeDir = path.join(dirs.themes, id);
      const conflict = builtinConflict || (!installed && dirExists(themeDir));
      let derived;
      if (conflict) {
        derived = { state: "conflict" };
      } else if (!entry && installed) {
        derived = { state: installed.repairRequired ? "repair-required" : "installed" };
      } else {
        derived = catalogModule.deriveOfficialThemeState({
          entry,
          installed,
          appVersion: getAppVersion(),
        });
      }
      const card = {
        ...(baseTheme || {
          id,
          name: entry ? entry.name : id,
          builtin: false,
          previewFileUrl: null,
          previewContentRatio: null,
          previewContentOffsetPct: null,
          variants: [],
          capabilities: null,
        }),
        ...buildOfficialCard(id, entry, installed),
      };
      if (!card.previewFileUrl && remotePreviewPath) {
        card.previewFileUrl = pathToFileURL(remotePreviewPath).href;
      }
      card.officialThemeState = derived.state;
      card.officialThemeCanUninstall = !!installed && !conflict;
      card.officialThemeConflict = conflict;
      if (entry) {
        card.officialThemeName = entry.name;
        card.officialThemeDescription = entry.description;
        card.officialThemeMinAppVersion = entry.minAppVersion;
      }
      return card;
    });
    themes.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return {
      status: "ok",
      ...catalogStatusReport(),
      themes,
    };
  }

  // Synchronous decoration used by settings:list-themes. Installed marker-owned
  // themes get the official flag; a known official id occupied by an unmanaged
  // directory becomes a single "conflict" card and is never claimed/deleted.
  function decorateThemeMetadata(theme) {
    if (!theme || typeof theme.id !== "string" || !theme.id) return theme;
    if (theme.builtin === true) return theme;
    ensureScan();
    const installed = state.installed.get(theme.id);
    if (installed) {
      const entry = catalogEntry(theme.id);
      const derived = catalogModule.deriveOfficialThemeState({
        entry,
        installed,
        appVersion: getAppVersion(),
      });
      return {
        ...theme,
        officialTheme: true,
        managedOfficialTheme: true,
        officialThemeState: entry ? derived.state : (installed.repairRequired ? "repair-required" : "installed"),
        officialThemeVersion: installed.version,
        officialThemeCatalogVersion: state.catalog ? state.catalog.catalogVersion : null,
        officialThemeCanUninstall: true,
        officialThemeConflict: false,
      };
    }
    if (state.catalog && catalogEntry(theme.id)) {
      return {
        ...theme,
        officialTheme: true,
        managedOfficialTheme: false,
        officialThemeState: "conflict",
        officialThemeConflict: true,
        officialThemeCanUninstall: false,
      };
    }
    return theme;
  }

  // ── Install ──

  function normalizeInstallError(err) {
    return {
      status: "error",
      code: (err && err.code) || MANAGER_ERROR_CODES.INSTALL_FAILED,
      message: (err && err.message) || "official theme install failed",
    };
  }

  async function cleanupPart(partPath) {
    if (!partPath) return;
    try { fs.rmSync(partPath, { force: true }); } catch {}
  }

  async function cleanupStaging(stagingDir) {
    if (!stagingDir) return;
    const result = await rmWithRetry(fs, stagingDir, path);
    return result.ok;
  }

  // Explicit tab-open refresh, throttled so a burst of themeOverrides-driven
  // list rebuilds cannot hammer the catalog endpoint.
  function refreshCatalog({ force = false, minIntervalMs = 60 * 1000 } = {}) {
    const current = now();
    if (!force && state.lastFetchMs && current - state.lastFetchMs < minIntervalMs) {
      return Promise.resolve(state.catalogStatus);
    }
    state.lastFetchMs = current;
    return ensureCatalogReady(true);
  }

  // Synchronous single-flight guard: the first await happens before the
  // operation object exists, so a plain `state.operation` check would let two
  // rapid clicks both start.
  async function installTheme(themeId) {
    if (state.operation || state.installInFlight) {
      return { status: "error", code: MANAGER_ERROR_CODES.BUSY, message: "another official theme operation is in progress" };
    }
    state.installInFlight = true;
    try {
      return await runInstall(themeId);
    } finally {
      state.installInFlight = false;
      if (!state.operation) broadcastProgress();
    }
  }

  async function runInstall(themeId) {
    if (typeof themeId !== "string" || !themeId) {
      return { status: "error", code: MANAGER_ERROR_CODES.NOT_FOUND, message: "themeId is required" };
    }
    await ensureCatalogReady();
    if (!state.catalog) {
      return { status: "error", code: MANAGER_ERROR_CODES.CATALOG_UNAVAILABLE, message: "official theme catalog is unavailable" };
    }
    const entry = catalogEntry(themeId);
    if (!entry) {
      return { status: "error", code: MANAGER_ERROR_CODES.NOT_FOUND, message: `unknown official theme "${themeId}"` };
    }
    if (catalogModule.compareSemver(getAppVersion(), entry.minAppVersion) < 0) {
      return {
        status: "error",
        code: MANAGER_ERROR_CODES.UNSUPPORTED_VERSION,
        message: `theme requires Clawd ${entry.minAppVersion}`,
      };
    }
    if (isBuiltinThemeId(themeId)) {
      return {
        status: "error",
        code: MANAGER_ERROR_CODES.TARGET_CONFLICT,
        message: `official theme id "${themeId}" conflicts with a built-in theme`,
      };
    }
    scanInstalled();
    const installed = state.installed.get(themeId);
    if (installed && !installed.repairRequired) {
      return {
        status: "error",
        code: MANAGER_ERROR_CODES.ALREADY_INSTALLED,
        message: "theme is already installed; uninstall it before reinstalling",
      };
    }
    if (installed && installed.repairRequired) {
      return {
        status: "error",
        code: MANAGER_ERROR_CODES.REPAIR_REQUIRED,
        message: "theme needs a uninstall-then-reinstall repair",
      };
    }
    const targetDir = path.join(dirs.themes, themeId);
    if (dirExists(targetDir)) {
      return {
        status: "error",
        code: MANAGER_ERROR_CODES.TARGET_CONFLICT,
        message: `a non-managed theme directory already uses "${themeId}"`,
      };
    }

    const nonce = downloadModule.createNonce();
    const controller = new AbortController();
    const stagingDir = path.join(dirs.staging, downloadModule.officialArtifactName(themeId, entry.version, nonce));
    let partPath = null;
    state.lastError = null;
    state.operation = {
      id: themeId,
      phase: "downloading",
      receivedBytes: 0,
      totalBytes: entry.archive.bytes,
      controller,
      nonce,
      version: entry.version,
      lastBroadcastPercent: 0,
      lastBroadcastAt: now(),
    };
    broadcastProgress();

    try {
      const download = await downloadImpl({
        fs,
        path,
        net,
        entry,
        nonce,
        userDataDir,
        signal: controller.signal,
        requestImpl: options.requestImpl,
        onProgress: (progress) => {
          if (!state.operation || state.operation.id !== themeId) return;
          state.operation.receivedBytes = progress.receivedBytes;
          state.operation.totalBytes = progress.totalBytes;
          broadcastProgress({ throttled: true });
        },
      });
      partPath = download.partPath;

      state.operation.phase = "extracting";
      state.operation.receivedBytes = entry.archive.bytes;
      broadcastProgress();

      const extracted = await extractImpl({
        fs,
        path,
        partPath,
        stagingDir,
        id: themeId,
        signal: controller.signal,
        maxEntries: catalogModule.LIMITS.maxEntries,
        perEntryMaxBytes: catalogModule.LIMITS.perEntryMaxBytes,
        // Bound actual extraction by the catalog's own unpacked size, never
        // above the hard cap: an under-declared archive must fail rather than
        // overrun the value the disk precheck trusted.
        totalMaxBytes: Math.min(entry.archive.unpackedBytes, catalogModule.LIMITS.unpackedMaxBytes),
      });
      if (!extracted || extracted.unpackedBytes !== entry.archive.unpackedBytes) {
        throw managerError(
          MANAGER_ERROR_CODES.INSTALL_FAILED,
          `theme package unpacked byte count did not match catalog (${extracted && extracted.unpackedBytes} != ${entry.archive.unpackedBytes})`,
        );
      }

      const shape = themeLoader.validateThemeShape(themeId, { themeDir: stagingDir });
      if (!shape || !shape.ok) {
        throw managerError(
          MANAGER_ERROR_CODES.INSTALL_FAILED,
          `theme package failed validation: ${(shape && shape.errors && shape.errors.join("; ")) || "unknown error"}`,
        );
      }

      const marker = installerModule.buildMarker({
        id: themeId,
        version: entry.version,
        archiveSha256: entry.archive.sha256,
        sourceRepository: installerModule.OFFICIAL_SOURCE_REPOSITORY,
        installedAt: nowIso(),
      });
      installerModule.writeOfficialThemeMarker(stagingDir, marker, { fs, path });

      state.operation.phase = "installing";
      broadcastProgress();

      const commitResult = await settingsController.applyCommand("officialTheme.commitInstall", {
        themeId,
        version: entry.version,
        archiveSha256: entry.archive.sha256,
        nonce,
      });
      if (!commitResult || commitResult.status !== "ok") {
        const err = managerError(
          (commitResult && commitResult.code) || MANAGER_ERROR_CODES.INSTALL_FAILED,
          (commitResult && commitResult.message) || "official theme install could not be committed",
        );
        state.lastError = { id: themeId, code: err.code, message: err.message };
        await cleanupStaging(stagingDir);
        await cleanupPart(partPath);
        return normalizeInstallError(err);
      }

      await cleanupPart(partPath);
      scanInstalled();
      try { rebuildAllMenus(); } catch {}
      return { status: "ok", id: themeId, version: entry.version };
    } catch (err) {
      const normalized = normalizeInstallError(err);
      state.lastError = { id: themeId, code: normalized.code, message: normalized.message };
      await cleanupStaging(stagingDir);
      await cleanupPart(partPath);
      return normalized;
    } finally {
      state.operation = null;
      broadcastProgress();
    }
  }

  function cancelInstall() {
    if (!state.operation || !state.operation.controller) {
      return { status: "ok", cancelled: false };
    }
    if (state.operation.phase === "installing") {
      return { status: "ok", cancelled: false, id: state.operation.id };
    }
    const id = state.operation.id;
    state.operation.controller.abort();
    return { status: "ok", cancelled: true, id };
  }

  // ── In-lock commit (invoked by the officialTheme.commitInstall command) ──

  function commitStagedInstall(payload) {
    const themeId = payload && payload.themeId;
    const version = payload && payload.version;
    const archiveSha256 = payload && payload.archiveSha256;
    const nonce = payload && payload.nonce;
    if (typeof themeId !== "string" || !themeId) {
      return { status: "error", code: MANAGER_ERROR_CODES.NOT_FOUND, message: "themeId is required" };
    }
    if (!state.catalog) {
      return { status: "error", code: MANAGER_ERROR_CODES.CATALOG_UNAVAILABLE, message: "official theme catalog is unavailable" };
    }
    if (isBuiltinThemeId(themeId)) {
      return {
        status: "error",
        code: MANAGER_ERROR_CODES.TARGET_CONFLICT,
        message: `official theme id "${themeId}" conflicts with a built-in theme`,
      };
    }
    const entry = catalogEntry(themeId);
    // Re-resolve URL/version/bytes/sha from the validated catalog; the caller's
    // fields are only a consistency check, never the source of truth.
    if (!entry || entry.version !== version || entry.archive.sha256 !== archiveSha256) {
      return { status: "error", code: MANAGER_ERROR_CODES.NOT_FOUND, message: "catalog no longer matches the staged install" };
    }
    if (!downloadModule.isSafeNonce(nonce)) {
      return { status: "error", code: MANAGER_ERROR_CODES.INSTALL_FAILED, message: "invalid staging nonce" };
    }
    const stagingDir = path.join(dirs.staging, downloadModule.officialArtifactName(themeId, version, nonce));
    if (!installerModule.isInside(dirs.staging, stagingDir, path)) {
      return { status: "error", code: MANAGER_ERROR_CODES.INSTALL_FAILED, message: "staging path escaped the manager root" };
    }
    const targetDir = path.join(dirs.themes, themeId);
    const marker = installerModule.buildMarker({
      id: themeId,
      version,
      archiveSha256,
      sourceRepository: installerModule.OFFICIAL_SOURCE_REPOSITORY,
      installedAt: nowIso(),
    });

    let result;
    try {
      result = commitImpl({
        fs,
        path,
        stagingRoot: dirs.staging,
        stagingDir,
        targetDir,
        themeCacheDir: dirs.themeCache,
        id: themeId,
        marker,
        validateStaging: (dir) => themeLoader.validateThemeShape(themeId, { themeDir: dir }),
        validateTarget: (dir) => {
          const shape = themeLoader.validateThemeShape(themeId, { themeDir: dir });
          if (!shape || !shape.ok) return shape || { ok: false, errors: ["readback failed"] };
          try {
            themeLoader.loadTheme(themeId, { strict: true });
          } catch (err) {
            return { ok: false, errors: [err && err.message] };
          }
          return { ok: true };
        },
      });
    } catch (err) {
      const normalized = normalizeInstallError(err);
      state.lastError = { id: themeId, code: normalized.code, message: normalized.message };
      return normalized;
    }

    scanInstalled();
    if (result.status === "installed") {
      try { rebuildAllMenus(); } catch {}
      return { status: "ok", themeId, version };
    }
    const code = result.status === "repair-required"
      ? MANAGER_ERROR_CODES.REPAIR_REQUIRED
      : MANAGER_ERROR_CODES.INSTALL_FAILED;
    const details = Array.isArray(result.errors) && result.errors.length > 0
      ? `: ${result.errors.join("; ")}`
      : "";
    const message = result.status === "repair-required"
      ? `theme install left an incomplete directory; uninstall and retry${details}`
      : `theme install could not be committed${details}`;
    state.lastError = { id: themeId, code, message };
    return { status: "error", code, message };
  }

  // ── Uninstall (invoked by the officialTheme.uninstall command, in-lock) ──

  function resolveManagedTarget(themeId) {
    if (typeof themeId !== "string" || !themeId) return null;
    const rootResolved = path.resolve(dirs.themes);
    const targetDir = path.resolve(path.join(dirs.themes, themeId));
    if (path.dirname(targetDir) !== rootResolved || path.basename(targetDir) !== themeId) return null;
    return { targetDir, rootResolved };
  }

  function readTargetMarker(targetDir) {
    try {
      const stat = fs.lstatSync(targetDir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return { ok: false, reason: "not a plain directory" };
    } catch (err) {
      if (err && err.code === "ENOENT") return { ok: true, missing: true };
      return { ok: false, reason: err && err.message };
    }
    const marker = installerModule.readOfficialThemeMarker(targetDir, { fs, path });
    if (!marker) return { ok: false, reason: "missing or invalid ownership marker" };
    return { ok: true, marker };
  }

  function cleanupSoundOverrides(themeId, snapshot) {
    const overridesRoot = path.join(dirs.soundOverrides, themeId);
    const entry = snapshot && snapshot.themeOverrides && snapshot.themeOverrides[themeId];
    const sounds = entry && isPlainObject(entry.sounds) ? entry.sounds : null;
    if (!sounds) return;
    for (const value of Object.values(sounds)) {
      const filename = value && typeof value.file === "string" ? path.basename(value.file) : "";
      if (!filename) continue;
      try { fs.rmSync(path.join(overridesRoot, filename), { force: true }); } catch {}
    }
    try {
      if (fs.readdirSync(overridesRoot).length === 0) fs.rmdirSync(overridesRoot);
    } catch {}
  }

  // The theme-scoped preference deletions are owned by the settings command
  // (settings-actions.js) so the controller remains the only writer; this owner
  // only reports the runtime switch it performed.

  async function uninstall(payload, deps = {}, helpers = {}) {
    const themeId = payload && payload.themeId;
    const target = resolveManagedTarget(themeId);
    if (!target) {
      return { status: "error", code: MANAGER_ERROR_CODES.NOT_MANAGED, message: "invalid theme id" };
    }
    const selectTheme = helpers && typeof helpers.selectTheme === "function" ? helpers.selectTheme : null;
    const snapshot = deps.snapshot || {};
    const prior = readTargetMarker(target.targetDir);
    if (prior.missing) {
      // Directory already gone: let the command scrub cache/prefs so the card
      // clears. Still report success.
      scannerRemove(themeId);
      cleanupSoundOverrides(themeId, snapshot);
      try { fs.rmSync(path.join(dirs.themeCache, themeId), { recursive: true, force: true }); } catch {}
      return { status: "ok", commit: {}, uninstallStatus: "ok", removed: { id: themeId, version: null } };
    }
    if (!prior.ok) {
      return { status: "error", code: MANAGER_ERROR_CODES.NOT_MANAGED, message: `refusing to uninstall: ${prior.reason}` };
    }
    const marker = prior.marker;

    const active = !!(getActiveTheme() && getActiveTheme()._id === themeId);
    const commit = {};
    let switched = false;

    if (active) {
      // Reuse the exact runtime selection helper as setThemeSelection: activate
      // the user's saved Clawd variant with its saved override map, then commit
      // the resolved fallback variant. No duplicated variant/override logic and
      // no recursive controller call (we already hold the shared `theme` lock).
      if (!selectTheme) {
        return {
          status: "error",
          code: MANAGER_ERROR_CODES.SELECTION_FAILED,
          message: "officialTheme.uninstall requires the shared theme selection helper",
        };
      }
      const currentVariantMap = (snapshot && snapshot.themeVariant) || {};
      const currentOverrides = (snapshot && snapshot.themeOverrides) || {};
      const targetVariant = currentVariantMap.clawd || "default";
      const targetOverrides = currentOverrides.clawd || null;
      let selection;
      try {
        selection = selectTheme("clawd", targetVariant, targetOverrides);
      } catch (err) {
        return { status: "error", code: MANAGER_ERROR_CODES.DELETE_FAILED, message: `could not switch away from active theme: ${err && err.message}` };
      }
      if (!selection || selection.status !== "ok") {
        return {
          status: "error",
          code: MANAGER_ERROR_CODES.SELECTION_FAILED,
          message: (selection && selection.message) || "could not switch away from active theme",
        };
      }
      const resolvedVariant = typeof selection.variantId === "string" ? selection.variantId : targetVariant;
      const nextVariantMap = { ...currentVariantMap };
      // The command also clears this theme's scoped prefs; remove its variant
      // entry here too so the merged commit cannot resurrect it. Clawd's
      // override map is preserved (the command only removes this theme's key).
      delete nextVariantMap[themeId];
      nextVariantMap.clawd = resolvedVariant;
      commit.theme = "clawd";
      commit.themeVariant = nextVariantMap;
      switched = true;
      let settled = { status: "settled" };
      try {
        settled = await waitForThemeReloadSettled({ timeoutMs: RELOAD_SETTLE_TIMEOUT_MS });
      } catch {
        settled = { status: "timeout" };
      }
      if (!settled || settled.status !== "settled") {
        // Runtime has switched; prefs must follow, but the old assets may still
        // be held open. Leave the target and ask for a retry after restart.
        return { status: "ok", commit, uninstallStatus: "retry-required", reason: "reload-not-settled", removed: null };
      }
    }

    // Re-check active=false and marker identity immediately before deletion.
    const stillActive = !!(getActiveTheme() && getActiveTheme()._id === themeId);
    if (stillActive) {
      return { status: "error", code: MANAGER_ERROR_CODES.DELETE_FAILED, message: "theme became active again; refusing to delete" };
    }
    const reverify = readTargetMarker(target.targetDir);
    if (!reverify.ok || !reverify.marker
      || !installerModule.markersMatch(reverify.marker, marker)) {
      return { status: "error", code: MANAGER_ERROR_CODES.NOT_MANAGED, message: "theme ownership changed; refusing to delete" };
    }

    const removal = await rmWithRetry(fs, target.targetDir, path);
    if (!removal.ok) {
      if (switched) {
        return { status: "ok", commit, uninstallStatus: "retry-required", reason: "delete-failed", removed: null };
      }
      return {
        status: "error",
        code: MANAGER_ERROR_CODES.DELETE_FAILED,
        message: `could not remove theme directory: ${removal.error && removal.error.message}`,
      };
    }
    if (fs.existsSync(target.targetDir)) {
      if (switched) {
        return { status: "ok", commit, uninstallStatus: "retry-required", reason: "delete-failed", removed: null };
      }
      return { status: "error", code: MANAGER_ERROR_CODES.DELETE_FAILED, message: "theme directory still present after removal" };
    }

    scannerRemove(themeId);
    cleanupSoundOverrides(themeId, snapshot);
    try { fs.rmSync(path.join(dirs.themeCache, themeId), { recursive: true, force: true }); } catch {}
    try { rebuildAllMenus(); } catch {}

    // Readback: the theme must no longer resolve.
    let stillResolves = false;
    try {
      const shape = themeLoader.validateThemeShape(themeId);
      stillResolves = !!(shape && shape.ok);
    } catch {
      stillResolves = false;
    }
    if (stillResolves) {
      return { status: "ok", commit, uninstallStatus: "retry-required", reason: "readback", removed: null };
    }

    return {
      status: "ok",
      commit,
      uninstallStatus: "ok",
      removed: { id: themeId, version: marker.version },
    };
  }

  function scannerRemove(themeId) {
    if (state.installed && typeof state.installed.delete === "function") {
      state.installed.delete(themeId);
    }
  }

  // ── Startup orphan cleanup ──

  function cleanupOrphans(opts = {}) {
    const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : ORPHAN_MAX_AGE_MS;
    const liveNonce = state.operation ? state.operation.nonce : null;
    const cutoff = now() - maxAgeMs;
    const removed = [];
    for (const root of [dirs.downloads, dirs.staging]) {
      let entries = [];
      try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const parsed = downloadModule.parseOfficialArtifactName(entry.name, path);
        if (!parsed) continue;
        if (parsed.suffix === ".part" && !entry.isFile()) continue;
        if (parsed.suffix === "" && !entry.isDirectory()) continue;
        if (liveNonce && parsed.nonce === liveNonce) continue;
        const full = path.join(root, entry.name);
        let stat;
        try { stat = fs.lstatSync(full); } catch { continue; }
        if (stat.isSymbolicLink()) continue;
        if (stat.mtimeMs > cutoff) continue;
        try {
          fs.rmSync(full, { recursive: parsed.suffix === "", force: true });
          removed.push(full);
        } catch {}
      }
    }
    return removed;
  }

  return {
    ensureCatalogReady,
    getCatalogStatus: () => ({ status: state.catalogStatus, ...catalogStatusReport() }),
    listOfficialThemes,
    decorateThemeMetadata,
    installTheme,
    cancelInstall,
    getOperationState: () => progressSnapshot(),
    commitStagedInstall,
    uninstall,
    cleanupOrphans,
    refreshInstalledScan: scanInstalled,
    isManagedTheme,
    refreshCatalog,
    _state: state,
    _dirs: dirs,
  };
}

module.exports = createOfficialThemeMain;
module.exports.MANAGER_ERROR_CODES = MANAGER_ERROR_CODES;
module.exports.ORPHAN_MAX_AGE_MS = ORPHAN_MAX_AGE_MS;
module.exports.OFFICIAL_THEME_DIALOG_MAX_BYTES = OFFICIAL_THEME_DIALOG_MAX_BYTES;
module.exports.PROGRESS_MIN_INTERVAL_MS = PROGRESS_MIN_INTERVAL_MS;
module.exports.CATALOG_RETRY_BACKOFF_MS = CATALOG_RETRY_BACKOFF_MS;
module.exports.__test = { rmWithRetry, isBusyFsError, mapWithConcurrency };
