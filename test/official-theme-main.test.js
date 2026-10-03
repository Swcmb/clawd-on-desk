"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createOfficialThemeMain = require("../src/official-theme-main");
const { MANAGER_ERROR_CODES } = createOfficialThemeMain;
const downloadModule = require("../src/official-theme-download");
const installerModule = require("../src/official-theme-installer");
const catalogModule = require("../src/official-theme-catalog");
const { createSettingsController } = require("../src/settings-controller");
const themeLoader = require("../src/theme-loader");
const { hashSageFixture } = require("./helpers/zip-builder");
const { createFakeNet, streamResponse } = require("./helpers/fake-official-net");

const SRC_DIR = path.join(__dirname, "..", "src");
const APP_VERSION = "1.5.0";
const NONCE = "a".repeat(32);
const NOTICE_URL = `https://github.com/rullerzhou-afk/clawd-themes/blob/${"1".repeat(40)}/themes/hash-sage/LICENSE`;
const SHOWCASE_URL = "https://hash-sage-art.pages.dev/progress/";

function buildZipEntry(zip) {
  return {
    id: "hash-sage",
    version: "1.0.0",
    minAppVersion: "1.0.0",
    name: { en: "Hash Sage" },
    description: { en: "A cloud-riding pixel sage." },
    archive: {
      url: "https://github.com/rullerzhou-afk/clawd-themes/releases/download/hash-sage-v1.0.0/hash-sage-1.0.0.clawd-theme.zip",
      bytes: zip.length,
      unpackedBytes: zip.unpackedBytes,
      sha256: crypto.createHash("sha256").update(zip).digest("hex"),
    },
    showcase: { url: SHOWCASE_URL },
    license: {
      spdx: "LicenseRef",
      noticeUrl: NOTICE_URL,
      notice: { en: "All rights reserved. Not affiliated with OpenAI." },
    },
  };
}

function makeCatalog(entry, catalogVersion = 1) {
  return { schemaVersion: 1, catalogVersion, themes: [entry] };
}

function makeNetFor(zip) {
  return createFakeNet((req) => {
    streamResponse(req, { chunks: [zip], headers: { "content-length": String(zip.length) } });
  });
}

// Lets the timers phase run before looking for the promise a background retry
// installs; the retry is a plain setTimeout, so setImmediate alone can overtake
// it.
const nextRetryTurn = () => new Promise((resolve) => setTimeout(resolve, 1));

// Runs the bounded background-retry chain to exhaustion. Returns as soon as no
// further retry is scheduled, which is also the assertion that the budget is
// finite.
async function drainCatalogRetries(manager, limit = 12) {
  for (let i = 0; i < limit; i += 1) {
    if (manager._state.catalogRetryTimer === null) return;
    await nextRetryTurn();
    const pending = manager._state.catalogRetryPromise;
    if (pending) await pending;
  }
  throw new Error("catalog retry chain never settled");
}

let tmp;
let prefsPath;
let manager;
let controller;
let activeId;
const holder = { manager: null };
let activationLog = [];

function createHarness(options = {}) {
  tmp = options.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), "clawd-official-main-"));
  const zip = options.zip || hashSageFixture();
  const entry = options.entry || buildZipEntry(zip);
  const catalog = options.catalog || makeCatalog(entry, options.catalogVersion || 1);
  themeLoader.init(SRC_DIR, tmp);
  activeId = options.activeId || null;

  prefsPath = path.join(tmp, "prefs.json");
  activationLog = [];
  controller = createSettingsController({
    prefsPath,
    injectedDeps: {
      get officialThemeManager() { return holder.manager; },
      activateTheme: (id, variantId, overrides) => {
        activationLog.push({ id, variantId: variantId ?? null, overrides: overrides ?? null });
        activeId = id;
        const resolved = typeof options.resolveActivationVariant === "function"
          ? options.resolveActivationVariant(id, variantId)
          : (variantId || "default");
        return { themeId: id, variantId: resolved };
      },
      waitForThemeReloadSettled: () => Promise.resolve({ status: "settled" }),
      getActiveTheme: () => (activeId ? { _id: activeId } : null),
      getThemeInfo: () => ({ builtin: false, active: activeId === "hash-sage" }),
      removeThemeDir: () => {},
    },
  });

  manager = createOfficialThemeMain({
    fs: options.fs || fs,
    path,
    net: options.net || makeNetFor(zip),
    userDataDir: tmp,
    themeLoader,
    settingsController: controller,
    getActiveTheme: () => (activeId ? { _id: activeId } : null),
    waitForThemeReloadSettled: () => Promise.resolve({ status: options.settleStatus || "settled" }),
    rebuildAllMenus: () => {},
    sendToSettingsWindow: options.sendToSettingsWindow || (() => {}),
    getAppVersion: () => APP_VERSION,
    now: options.now,
    fetchCatalogText: options.fetchCatalogText
      || (() => Promise.resolve(JSON.stringify(catalog))),
    // Off unless a test asks for it: the production backoff is 2s/8s, and a
    // timer outliving a finished test would fire into an already-removed
    // userDataDir. The retry suite opts in with explicit zero delays.
    catalogRetryBackoffMs: Object.prototype.hasOwnProperty.call(options, "catalogRetryBackoffMs")
      ? options.catalogRetryBackoffMs
      : [],
    downloadArchive: options.downloadArchive,
    ensurePreviewFile: options.ensurePreviewFile,
  });
  holder.manager = manager;
  return { zip, entry, catalog, manager, controller };
}

afterEach(() => {
  themeLoader.init(SRC_DIR, null);
  holder.manager = null;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe("official theme main", () => {
  it("lists catalog entries as available before install", async () => {
    const { manager } = createHarness();
    const listing = await manager.listOfficialThemes();
    assert.strictEqual(listing.status, "ok");
    assert.strictEqual(listing.catalogStatus, "ok");
    assert.strictEqual(listing.themes.length, 1);
    assert.strictEqual(listing.themes[0].id, "hash-sage");
    assert.strictEqual(listing.themes[0].officialThemeState, "available");
    assert.strictEqual(listing.themes[0].officialThemeBytes > 0, true);
    assert.strictEqual(listing.themes[0].officialThemeShowcaseUrl, SHOWCASE_URL);
    assert.strictEqual(listing.themes[0].officialThemeLicense, undefined);
  });

  it("exposes only the verified local preview URL to Settings", async () => {
    const zip = hashSageFixture();
    const entry = buildZipEntry(zip);
    entry.preview = {
      url: "https://github.com/rullerzhou-afk/clawd-themes/releases/download/hash-sage-v1.0.0/hash-sage-1.0.0.preview.webp",
      bytes: 7,
      sha256: "b".repeat(64),
    };
    const calls = [];
    const { manager } = createHarness({
      zip,
      entry,
      ensurePreviewFile: async (options) => {
        calls.push(options.entry.id);
        const target = path.join(options.userDataDir, "official-theme", "previews", "hash-sage.webp");
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "preview");
        return { path: target, cached: false };
      },
    });
    const listing = await manager.listOfficialThemes();
    assert.deepStrictEqual(calls, ["hash-sage"]);
    assert.match(listing.themes[0].previewFileUrl, /^file:\/\//);
    assert.ok(!listing.themes[0].previewFileUrl.includes("raw.githubusercontent.com"));
  });

  it("installs, then reports ALREADY_INSTALLED and enforces target conflict", async () => {
    const { manager } = createHarness();
    const result = await manager.installTheme("hash-sage");
    assert.strictEqual(result.status, "ok");
    assert.ok(fs.existsSync(path.join(tmp, "themes", "hash-sage", "theme.json")));
    assert.ok(fs.existsSync(path.join(tmp, "themes", "hash-sage", installerModule.MARKER_FILENAME)));
    assert.strictEqual(fs.existsSync(downloadModule.officialThemeDirs(tmp).staging) || true, true);

    const again = await manager.installTheme("hash-sage");
    assert.strictEqual(again.code, MANAGER_ERROR_CODES.ALREADY_INSTALLED);
  });

  it("refuses to install over a non-managed directory with the same id", async () => {
    const { manager } = createHarness();
    fs.mkdirSync(path.join(tmp, "themes", "hash-sage"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "themes", "hash-sage", "theme.json"), "{}");
    const result = await manager.installTheme("hash-sage");
    assert.strictEqual(result.code, MANAGER_ERROR_CODES.TARGET_CONFLICT);
  });

  it("rejects a catalog entry that collides with a built-in theme id", async () => {
    const zip = hashSageFixture();
    const entry = buildZipEntry(zip);
    entry.id = "clawd";
    entry.name = { en: "Imposter Clawd" };
    entry.archive.url = "https://github.com/rullerzhou-afk/clawd-themes/releases/download/clawd-v1.0.0/clawd-1.0.0.clawd-theme.zip";
    entry.showcase.url = "https://clawd-art.pages.dev/progress/";
    entry.license.noticeUrl = `https://github.com/rullerzhou-afk/clawd-themes/blob/${"1".repeat(40)}/themes/clawd/LICENSE`;
    const { manager } = createHarness({ zip, entry });

    const listing = await manager.listOfficialThemes();
    assert.strictEqual(listing.themes.some((theme) => theme.id === "clawd"), false);
    const builtin = manager.decorateThemeMetadata({ id: "clawd", name: "Clawd", builtin: true });
    assert.strictEqual(builtin.officialTheme, undefined, "catalog collision must not relabel the built-in card");

    const result = await manager.installTheme("clawd");
    assert.strictEqual(result.code, MANAGER_ERROR_CODES.TARGET_CONFLICT);
    assert.strictEqual(fs.existsSync(path.join(tmp, "themes", "clawd")), false);

    const commit = manager.commitStagedInstall({
      themeId: "clawd",
      version: entry.version,
      archiveSha256: entry.archive.sha256,
      nonce: NONCE,
    });
    assert.strictEqual(commit.code, MANAGER_ERROR_CODES.TARGET_CONFLICT, "in-lock check repeats the rejection");
  });

  it("derives repair-required for a marker-owned theme that fails shape validation on restart", async () => {
    const { manager } = createHarness();
    await manager.installTheme("hash-sage");
    // Simulate corruption after install + process restart: rebuild the manager.
    fs.writeFileSync(path.join(tmp, "themes", "hash-sage", "theme.json"), "{ broken", "utf8");
    const restarted = createOfficialThemeMain({
      fs, path, userDataDir: tmp, themeLoader, settingsController: controller,
      getActiveTheme: () => null, rebuildAllMenus: () => {}, sendToSettingsWindow: () => {},
      getAppVersion: () => APP_VERSION, fetchCatalogText: () => Promise.resolve(JSON.stringify(makeCatalog(buildZipEntry(hashSageFixture())))),
    });
    holder.manager = restarted;
    const listing = await restarted.listOfficialThemes();
    assert.strictEqual(listing.themes[0].officialThemeState, "repair-required");

    const blocked = await restarted.installTheme("hash-sage");
    assert.strictEqual(blocked.code, MANAGER_ERROR_CODES.REPAIR_REQUIRED);
  });

  it("cleans only old, strictly named manager orphans", () => {
    const { manager } = createHarness();
    const dirs = downloadModule.officialThemeDirs(tmp);
    fs.mkdirSync(dirs.downloads, { recursive: true });
    fs.mkdirSync(dirs.staging, { recursive: true });
    const oldPart = path.join(dirs.downloads, `hash-sage-1.0.0-${NONCE}.part`);
    const freshPart = path.join(dirs.downloads, `hash-sage-1.0.0-${"b".repeat(32)}.part`);
    const badName = path.join(dirs.downloads, "not-a-theme.part");
    fs.writeFileSync(oldPart, "x");
    fs.writeFileSync(freshPart, "x");
    fs.writeFileSync(badName, "x");
    const old = Date.now() - (48 * 60 * 60 * 1000);
    fs.utimesSync(oldPart, old / 1000, old / 1000);
    const removed = manager.cleanupOrphans();
    assert.ok(removed.includes(oldPart));
    assert.ok(fs.existsSync(freshPart));
    assert.ok(fs.existsSync(badName));
  });

  it("flags a known official id occupied by an unmanaged directory as a conflict", async () => {
    const { manager } = createHarness();
    fs.mkdirSync(path.join(tmp, "themes", "hash-sage"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "themes", "hash-sage", "theme.json"), JSON.stringify({ name: "x" }));
    await manager.ensureCatalogReady();
    const decorated = manager.decorateThemeMetadata({ id: "hash-sage", name: "x" });
    assert.strictEqual(decorated.officialThemeConflict, true);
    assert.strictEqual(decorated.officialThemeState, "conflict");
    assert.strictEqual(decorated.officialThemeCanUninstall, false);
  });

  it("never writes to the real user themes, home, or repository theme dirs", async () => {
    const realUserThemes = path.join(os.homedir(), ".clawd", "themes");
    const homeBefore = fs.existsSync(realUserThemes) ? fs.readdirSync(realUserThemes).sort() : null;
    const repoThemes = path.join(__dirname, "..", "themes");
    const repoBefore = fs.readdirSync(repoThemes).sort();

    const { manager } = createHarness();
    const result = await manager.installTheme("hash-sage");
    assert.strictEqual(result.status, "ok", result.message);
    assert.ok(fs.existsSync(path.join(tmp, "themes", "hash-sage")));

    const homeAfter = fs.existsSync(realUserThemes) ? fs.readdirSync(realUserThemes).sort() : null;
    assert.deepStrictEqual(homeAfter, homeBefore);
    assert.deepStrictEqual(fs.readdirSync(repoThemes).sort(), repoBefore);
  });

  it("fails an archive whose real unpacked size exceeds the catalog unpackedBytes", async () => {
    const zip = hashSageFixture();
    const entry = buildZipEntry(zip);
    entry.archive.unpackedBytes = 4; // under-declared vs the real fixture
    const { manager } = createHarness({ zip, entry });

    const result = await manager.installTheme("hash-sage");
    assert.strictEqual(result.status, "error");
    assert.strictEqual(fs.existsSync(path.join(tmp, "themes", "hash-sage")), false, "no target");
    const dirs = downloadModule.officialThemeDirs(tmp);
    assert.deepStrictEqual(fs.existsSync(dirs.staging) ? fs.readdirSync(dirs.staging) : [], [], "no staging");
    assert.deepStrictEqual(fs.existsSync(dirs.downloads) ? fs.readdirSync(dirs.downloads) : [], [], "no .part");
  });

  it("fails an archive whose real unpacked size is smaller than the catalog declaration", async () => {
    const zip = hashSageFixture();
    const entry = buildZipEntry(zip);
    entry.archive.unpackedBytes += 1;
    const { manager } = createHarness({ zip, entry });

    const result = await manager.installTheme("hash-sage");
    assert.strictEqual(result.status, "error");
    assert.match(result.message, /unpacked byte count did not match catalog/);
    assert.strictEqual(fs.existsSync(path.join(tmp, "themes", "hash-sage")), false, "no target");
  });

  it("refuses a lower first network catalog when the disk cache holds a higher version", async () => {
    const entry = buildZipEntry(hashSageFixture());
    const { manager } = createHarness({
      fetchCatalogText: () => Promise.resolve(JSON.stringify(makeCatalog(entry, 2))),
    });
    // Fresh process: no in-memory LKG yet; disk cache is v3.
    catalogModule.writeCatalogCache({ userDataDir: tmp, catalog: makeCatalog(entry, 3) });

    await manager.ensureCatalogReady();

    assert.strictEqual(manager._state.catalog.catalogVersion, 3, "cached v3 retained in memory");
    assert.strictEqual(manager._state.catalogStatus, "offline");
    const onDisk = catalogModule.readCatalogCache({ userDataDir: tmp });
    assert.strictEqual(onDisk.catalogVersion, 3, "disk cache must not be overwritten by v2");
  });

  it("reports why the official list is empty after a cold fetch failure with no cache", async () => {
    let fetches = 0;
    const { manager } = createHarness({
      fetchCatalogText: () => {
        fetches += 1;
        return Promise.reject(Object.assign(new Error("catalog request stalled"), {
          code: catalogModule.ERROR_CODES.CATALOG_OFFLINE,
        }));
      },
    });
    assert.strictEqual(fs.existsSync(catalogModule.catalogCachePath(tmp)), false, "first run: no disk cache");

    const listing = await manager.listOfficialThemes();

    assert.strictEqual(listing.status, "ok");
    assert.strictEqual(listing.themes.length, 0, "no validated catalog means no cards");
    // The empty list has to carry why it is empty and when we looked, or the
    // Theme tab drops the whole Official themes section with nothing to show.
    assert.strictEqual(listing.catalogStatus, "offline");
    assert.strictEqual(listing.catalogReason, catalogModule.ERROR_CODES.CATALOG_OFFLINE);
    assert.strictEqual(typeof listing.checkedAt, "string");
    assert.ok(listing.checkedAt.length > 0, "a failed attempt must still be timestamped");
    assert.strictEqual(fetches, 1);

    const meta = catalogModule.readCatalogAttemptMeta({ userDataDir: tmp });
    assert.strictEqual(meta.status, "offline");
    assert.strictEqual(meta.reason, catalogModule.ERROR_CODES.CATALOG_OFFLINE);
    assert.strictEqual(meta.checkedAt, listing.checkedAt, "the record matches what the UI was told");
    assert.strictEqual(meta.catalogVersion, null, "no last-known-good existed to report");
  });

  it("distinguishes a rejected catalog document from an unreachable endpoint", async () => {
    const { manager } = createHarness({
      fetchCatalogText: () => Promise.resolve("{not json"),
    });

    const listing = await manager.listOfficialThemes();

    assert.strictEqual(listing.themes.length, 0);
    assert.strictEqual(listing.catalogStatus, "invalid");
    assert.strictEqual(listing.catalogReason, catalogModule.ERROR_CODES.CATALOG_INVALID);
    assert.ok(listing.checkedAt);
    assert.strictEqual(catalogModule.readCatalogAttemptMeta({ userDataDir: tmp }).status, "invalid");
  });

  it("recovers the official list through the background retry without a manual refresh", async () => {
    const zip = hashSageFixture();
    const entry = buildZipEntry(zip);
    // A preview is declared so the adopted catalog survives the cache
    // round-trip, exactly like the published entries do.
    entry.preview = {
      url: "https://github.com/rullerzhou-afk/clawd-themes/releases/download/hash-sage-v1.0.0/hash-sage-1.0.0.preview.webp",
      bytes: 7,
      sha256: "b".repeat(64),
    };
    const catalog = makeCatalog(entry, 3);
    let fetches = 0;
    const { manager } = createHarness({
      catalog,
      catalogRetryBackoffMs: [0, 0],
      ensurePreviewFile: async () => ({ path: null }),
      fetchCatalogText: () => {
        fetches += 1;
        // The cold fetch dies like a stalled first run; the retry gets through.
        if (fetches === 1) {
          return Promise.reject(Object.assign(new Error("catalog request stalled"), {
            code: catalogModule.ERROR_CODES.CATALOG_OFFLINE,
          }));
        }
        return Promise.resolve(JSON.stringify(catalog));
      },
    });

    assert.strictEqual(await manager.ensureCatalogReady(), "offline");
    assert.strictEqual(fetches, 1, "the cold attempt alone does not recover");
    assert.strictEqual(manager._state.catalog, null);

    await drainCatalogRetries(manager);

    assert.strictEqual(fetches, 2, "the background retry re-attempted the endpoint");
    assert.strictEqual(manager._state.catalog.catalogVersion, 3, "the retry adopted the catalog");
    assert.strictEqual(manager._state.catalogStatus, "ok");
    assert.strictEqual(manager._state.catalogReason, null);
    assert.strictEqual(
      catalogModule.readCatalogAttemptMeta({ userDataDir: tmp }),
      null,
      "a recovered catalog leaves nothing degraded to report",
    );
    assert.strictEqual(catalogModule.readCatalogCache({ userDataDir: tmp }).catalogVersion, 3);

    const listing = await manager.listOfficialThemes();
    assert.strictEqual(listing.catalogStatus, "ok");
    assert.strictEqual(listing.themes.length, 1);
    assert.strictEqual(listing.themes[0].id, "hash-sage");
  });

  it("spends its background retry budget once per process and stops", async () => {
    let fetches = 0;
    const { manager } = createHarness({
      catalogRetryBackoffMs: [0, 0],
      fetchCatalogText: () => {
        fetches += 1;
        return Promise.reject(Object.assign(new Error("catalog request stalled"), {
          code: catalogModule.ERROR_CODES.CATALOG_OFFLINE,
        }));
      },
    });

    assert.strictEqual(await manager.ensureCatalogReady(), "offline");
    await drainCatalogRetries(manager);

    assert.strictEqual(fetches, 3, "cold attempt plus exactly two background retries");
    assert.strictEqual(manager._state.catalogRetryAttempt, 2);
    assert.strictEqual(manager._state.catalogRetryTimer, null);

    // A later explicit attempt is still allowed, but it must not refill the
    // background budget for this process.
    assert.strictEqual(await manager.ensureCatalogReady(), "offline");
    assert.strictEqual(fetches, 4);
    await drainCatalogRetries(manager);
    assert.strictEqual(fetches, 4, "the retry budget stays spent");
  });

  it("a regressing catalog arriving on a background retry cannot overwrite a higher last-known-good", async () => {
    const entry = buildZipEntry(hashSageFixture());
    let fetches = 0;
    const { manager } = createHarness({
      catalogRetryBackoffMs: [0, 0],
      fetchCatalogText: () => {
        fetches += 1;
        if (fetches === 1) {
          return Promise.reject(Object.assign(new Error("catalog request stalled"), {
            code: catalogModule.ERROR_CODES.CATALOG_OFFLINE,
          }));
        }
        // The endpoint is serving a stale edge copy; retrying must not help.
        return Promise.resolve(JSON.stringify(makeCatalog(entry, 1)));
      },
    });
    catalogModule.writeCatalogCache({ userDataDir: tmp, catalog: makeCatalog(entry, 4) });

    assert.strictEqual(await manager.ensureCatalogReady(), "offline");
    assert.strictEqual(manager._state.catalog.catalogVersion, 4, "cold fetch fell back to the disk cache");

    await drainCatalogRetries(manager);

    assert.ok(fetches >= 2, "the retry actually re-attempted the endpoint");
    assert.strictEqual(manager._state.catalog.catalogVersion, 4, "the regression must not win");
    assert.strictEqual(manager._state.catalogStatus, "offline");
    assert.strictEqual(manager._state.catalogReason, catalogModule.ERROR_CODES.CATALOG_REGRESSION);
    assert.strictEqual(catalogModule.readCatalogCache({ userDataDir: tmp }).catalogVersion, 4);
    const meta = catalogModule.readCatalogAttemptMeta({ userDataDir: tmp });
    assert.strictEqual(meta.status, "offline");
    assert.strictEqual(meta.reason, catalogModule.ERROR_CODES.CATALOG_REGRESSION);
    assert.strictEqual(meta.catalogVersion, 4, "the retained last-known-good is recorded");
  });

  it("clears a previous failure record once a catalog is adopted", async () => {
    const { manager } = createHarness();
    assert.strictEqual(catalogModule.writeCatalogAttemptMeta({
      userDataDir: tmp,
      status: "offline",
      reason: catalogModule.ERROR_CODES.CATALOG_OFFLINE,
      checkedAt: "2026-10-03T09:00:00.000Z",
      catalogVersion: null,
    }), true);

    const listing = await manager.listOfficialThemes();

    assert.strictEqual(listing.catalogStatus, "ok");
    assert.strictEqual(listing.catalogReason, null);
    assert.strictEqual(catalogModule.readCatalogAttemptMeta({ userDataDir: tmp }), null);
  });

  it("backfills the last attempt time from the persisted record before this process fetches", async () => {
    const { manager } = createHarness();
    catalogModule.writeCatalogAttemptMeta({
      userDataDir: tmp,
      status: "offline",
      reason: catalogModule.ERROR_CODES.CATALOG_OFFLINE,
      checkedAt: "2026-10-03T09:00:00.000Z",
      catalogVersion: 4,
    });

    assert.strictEqual(manager._state.catalogCheckedAt, null, "this process has not attempted yet");
    const status = manager.getCatalogStatus();
    assert.strictEqual(status.status, "uninitialized");
    assert.strictEqual(status.checkedAt, "2026-10-03T09:00:00.000Z");
  });

  it("never regresses below the in-memory last-known-good when cache persistence fails", async () => {
    const entry = buildZipEntry(hashSageFixture());
    const fetchQueue = [makeCatalog(entry, 3), makeCatalog(entry, 2)];
    const failingFs = Object.create(fs);
    const realWrite = fs.writeFileSync.bind(fs);
    failingFs.writeFileSync = (target, ...rest) => {
      if (String(target).includes("catalog-v1.json")) {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      }
      return realWrite(target, ...rest);
    };
    const { manager } = createHarness({
      fs: failingFs,
      fetchCatalogText: () => Promise.resolve(JSON.stringify(fetchQueue.shift())),
    });
    // Seed a v1 on-disk cache; reads go through the delegating fs.
    catalogModule.writeCatalogCache({ userDataDir: tmp, catalog: makeCatalog(entry, 1) });

    await manager.ensureCatalogReady();
    assert.strictEqual(manager._state.catalog.catalogVersion, 3, "v3 adopted in memory despite cache write failure");

    await manager.refreshCatalog({ force: true });
    assert.strictEqual(manager._state.catalog.catalogVersion, 3, "lower fetched v2 must not regress v3");
    assert.strictEqual(manager._state.catalogStatus, "offline");
  });

  it("allows only one concurrent install operation", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const realDownload = downloadModule.downloadArchive;
    const { manager } = createHarness({
      downloadArchive: async (opts) => {
        await gate;
        return realDownload(opts);
      },
    });
    const first = manager.installTheme("hash-sage");
    const second = await manager.installTheme("hash-sage");
    assert.strictEqual(second.code, MANAGER_ERROR_CODES.BUSY);
    release();
    const result = await first;
    assert.strictEqual(result.status, "ok", result.message);
  });

  it("clears install single-flight after a catalog failure so retry is possible", async () => {
    let fetches = 0;
    const { manager } = createHarness({
      fetchCatalogText: () => {
        fetches += 1;
        return Promise.reject(Object.assign(new Error("offline"), { code: catalogModule.ERROR_CODES.CATALOG_OFFLINE }));
      },
    });

    const first = await manager.installTheme("hash-sage");
    const second = await manager.installTheme("hash-sage");
    assert.strictEqual(first.code, MANAGER_ERROR_CODES.CATALOG_UNAVAILABLE);
    assert.strictEqual(second.code, MANAGER_ERROR_CODES.CATALOG_UNAVAILABLE);
    assert.strictEqual(fetches, 2);
    assert.strictEqual(manager._state.installInFlight, false);
  });

  it("throttles sub-percent progress bursts while preserving phase and final updates", async () => {
    const events = [];
    const realDownload = downloadModule.downloadArchive;
    const { manager } = createHarness({
      now: () => 1000,
      sendToSettingsWindow: (channel, payload) => events.push({ channel, payload }),
      downloadArchive: async (options) => {
        for (let received = 1; received <= 100; received += 1) {
          options.onProgress({
            receivedBytes: received,
            totalBytes: options.entry.archive.bytes,
          });
        }
        return realDownload(options);
      },
    });

    const result = await manager.installTheme("hash-sage");
    assert.strictEqual(result.status, "ok", result.message);
    const live = events.filter((event) => event.payload && event.payload.id === "hash-sage");
    assert.ok(live.length < 30, `expected throttled progress, got ${live.length} events`);
    assert.ok(live.some((event) => event.payload.phase === "extracting"));
    assert.ok(live.some((event) => event.payload.phase === "installing"));
  });

  it("does not claim cancellation once the in-lock install phase has started", () => {
    const { manager } = createHarness();
    let aborted = false;
    manager._state.operation = {
      id: "hash-sage",
      phase: "installing",
      controller: { abort: () => { aborted = true; } },
    };
    const result = manager.cancelInstall();
    assert.deepStrictEqual(result, { status: "ok", cancelled: false, id: "hash-sage" });
    assert.strictEqual(aborted, false);
  });
});

describe("official theme uninstall", () => {
  async function installAndActivate(options = {}) {
    const harness = createHarness(options);
    const installed = await harness.manager.installTheme("hash-sage");
    assert.strictEqual(installed.status, "ok", installed.message);
    // Seed theme-scoped preferences the uninstall must clear.
    harness.controller.applyUpdate("themeOverrides", {
      "hash-sage": { disabled: ["working"], sounds: { complete: { file: "complete.mp3" } } },
      clawd: {},
    });
    harness.controller.applyUpdate("idleVisual", { "hash-sage": "idle.svg" });
    harness.controller.applyUpdate("themeVariant", { "hash-sage": "cozy" });
    const soundDir = path.join(tmp, "sound-overrides", "hash-sage");
    fs.mkdirSync(soundDir, { recursive: true });
    fs.writeFileSync(path.join(soundDir, "complete.mp3"), "clawd-managed");
    fs.mkdirSync(path.join(tmp, "theme-cache", "hash-sage"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "theme-cache", "hash-sage", "stale"), "x");
    if (options.activate !== false) activeId = "hash-sage";
    if (options.failingDelete) {
      const failingFs = Object.create(fs);
      failingFs.rmSync = (target, opts) => {
        if (String(target).startsWith(path.join(tmp, "themes", "hash-sage"))) {
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        }
        return fs.rmSync(target, opts);
      };
      harness.manager = createOfficialThemeMain({
        fs: failingFs,
        path,
        userDataDir: tmp,
        themeLoader,
        settingsController: harness.controller,
        getActiveTheme: () => (activeId ? { _id: activeId } : null),
        waitForThemeReloadSettled: () => Promise.resolve({ status: "settled" }),
        rebuildAllMenus: () => {},
        sendToSettingsWindow: () => {},
        getAppVersion: () => APP_VERSION,
        fetchCatalogText: () => Promise.resolve(JSON.stringify(buildCatalogFor(options))),
      });
      holder.manager = harness.manager;
    }
    return harness;
  }

  it("switches active official themes back to clawd, deletes the target and clears prefs", async () => {
    await installAndActivate();
    const result = await controller.applyCommand("officialTheme.uninstall", { themeId: "hash-sage" });
    assert.strictEqual(result.status, "ok", result.message);
    assert.strictEqual(result.uninstallStatus, "ok");
    assert.strictEqual(activeId, "clawd");
    assert.strictEqual(controller.get("theme"), "clawd");
    assert.strictEqual(fs.existsSync(path.join(tmp, "themes", "hash-sage")), false);
    assert.strictEqual(controller.get("themeOverrides")["hash-sage"], undefined);
    assert.strictEqual(controller.get("idleVisual")["hash-sage"], undefined);
    assert.strictEqual(controller.get("themeVariant")["hash-sage"], undefined);
    assert.strictEqual(controller.get("themeVariant").clawd, "default");
    assert.strictEqual(fs.existsSync(path.join(tmp, "theme-cache", "hash-sage")), false);
    assert.strictEqual(fs.existsSync(path.join(tmp, "sound-overrides", "hash-sage")), false);
  });

  it("reuses the saved Clawd variant and override map when uninstalling an active theme", async () => {
    await installAndActivate();
    controller.applyUpdate("themeVariant", { "hash-sage": "cozy", clawd: "cozy" });
    controller.applyUpdate("themeOverrides", {
      "hash-sage": { disabled: ["juggling"] },
      clawd: { disabled: ["working"] },
    });

    const result = await controller.applyCommand("officialTheme.uninstall", { themeId: "hash-sage" });
    assert.strictEqual(result.status, "ok", result.message);

    const last = activationLog[activationLog.length - 1];
    assert.strictEqual(last.id, "clawd");
    assert.strictEqual(last.variantId, "cozy", "saved Clawd variant is used");
    assert.deepStrictEqual(last.overrides, { disabled: ["working"] }, "saved Clawd overrides are used");
    assert.strictEqual(controller.get("themeVariant").clawd, "cozy");
    assert.deepStrictEqual(controller.get("themeOverrides").clawd, { disabled: ["working"] });
    assert.strictEqual(controller.get("themeOverrides")["hash-sage"], undefined);
  });

  it("commits the runtime-resolved fallback variant when the saved variant is dead", async () => {
    await installAndActivate({ resolveActivationVariant: () => "default" });
    controller.applyUpdate("themeVariant", { clawd: "dead-variant" });

    const result = await controller.applyCommand("officialTheme.uninstall", { themeId: "hash-sage" });
    assert.strictEqual(result.status, "ok", result.message);
    assert.strictEqual(activationLog[activationLog.length - 1].variantId, "dead-variant");
    assert.strictEqual(controller.get("themeVariant").clawd, "default", "resolved fallback is committed");
    assert.strictEqual(controller.get("themeVariant")["hash-sage"], undefined);
  });

  it("fails closed when the shared selection helper is missing", async () => {
    const harness = await installAndActivate();
    const result = await harness.manager.uninstall({ themeId: "hash-sage" }, { snapshot: {} }, {});
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.code, MANAGER_ERROR_CODES.SELECTION_FAILED);
    assert.ok(fs.existsSync(path.join(tmp, "themes", "hash-sage")), "target preserved");
  });

  it("returns top-level ok + retry-required when the runtime switched but deletion failed", async () => {
    await installAndActivate({ failingDelete: true });
    const result = await controller.applyCommand("officialTheme.uninstall", { themeId: "hash-sage" });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.uninstallStatus, "retry-required");
    // Controller must still commit the fallback so prefs and runtime agree.
    assert.strictEqual(controller.get("theme"), "clawd");
    assert.ok(fs.existsSync(path.join(tmp, "themes", "hash-sage")));
  });

  it("does not delete when the reload never settles", async () => {
    await installAndActivate({ settleStatus: "timeout" });
    const result = await controller.applyCommand("officialTheme.uninstall", { themeId: "hash-sage" });
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.uninstallStatus, "retry-required");
    assert.strictEqual(controller.get("theme"), "clawd");
    assert.ok(fs.existsSync(path.join(tmp, "themes", "hash-sage")));
  });

  it("treats a foreign-source marker as unmanaged (no claim, no overwrite, no delete)", async () => {
    const { manager } = createHarness();
    const themeDir = path.join(tmp, "themes", "hash-sage");
    fs.mkdirSync(themeDir, { recursive: true });
    fs.writeFileSync(path.join(themeDir, "theme.json"), "{}");
    const valid = installerModule.buildMarker({
      id: "hash-sage",
      version: "1.0.0",
      archiveSha256: "a".repeat(64),
      sourceRepository: installerModule.OFFICIAL_SOURCE_REPOSITORY,
      installedAt: new Date(0).toISOString(),
    });
    fs.writeFileSync(
      path.join(themeDir, installerModule.MARKER_FILENAME),
      JSON.stringify({ ...valid, sourceRepository: "evil/other-repo" }),
      "utf8",
    );

    assert.strictEqual(manager.isManagedTheme("hash-sage"), false);
    const install = await manager.installTheme("hash-sage");
    assert.strictEqual(install.code, MANAGER_ERROR_CODES.TARGET_CONFLICT);

    const uninstall = await controller.applyCommand("officialTheme.uninstall", { themeId: "hash-sage" });
    assert.strictEqual(uninstall.status, "error");
    assert.ok(fs.existsSync(themeDir));
  });

  it("refuses to uninstall a directory without a valid marker", async () => {
    const { manager } = createHarness();
    fs.mkdirSync(path.join(tmp, "themes", "hash-sage"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "themes", "hash-sage", "theme.json"), "{}");
    const result = await controller.applyCommand("officialTheme.uninstall", { themeId: "hash-sage" });
    assert.strictEqual(result.status, "error");
    assert.ok(fs.existsSync(path.join(tmp, "themes", "hash-sage")));
  });
});

function buildCatalogFor(options = {}) {
  const zip = options.zip || hashSageFixture();
  return makeCatalog(buildZipEntry(zip), options.catalogVersion || 1);
}
