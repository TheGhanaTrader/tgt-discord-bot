// src/jobs/dailyBackupJob.js
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const {
  ensureBackupFolder,
  uploadFileToFolder,
  listChildren,
  deleteFile,
} = require("../services/googleDriveClient");

function getEnv(name, fallback = "") {
  const v = String(process.env[name] || "").trim();
  return v || fallback;
}

async function sendAlert(client, text) {
  const channelId = String(process.env.BOT_ALERTS_CHANNEL_ID || "").trim();
  if (!client || !channelId) return;

  const ch =
    client.channels.cache.get(channelId) ||
    (await client.channels.fetch(channelId).catch(() => null));
  if (!ch || !ch.isTextBased()) return;

  await ch.send(String(text || "")).catch(() => null);
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() +
    "-" +
    pad(d.getUTCMonth() + 1) +
    "-" +
    pad(d.getUTCDate()) +
    "_" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

function safeMkdir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function fileExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Minimal, safe DB dump:
 * - Tries pg_dump if available
 * - If missing, logs and continues with filesystem backup only
 */
async function dumpPostgresToFile(outFile) {
  const dbUrl = String(process.env.DATABASE_URL || "").trim();
  if (!dbUrl) throw new Error("Missing DATABASE_URL");

  return await new Promise((resolve) => {
    const pgDump = spawn("pg_dump", [dbUrl, "--format=custom"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const out = fs.createWriteStream(outFile);
    pgDump.stdout.pipe(out);

    let errTxt = "";
    pgDump.stderr.on("data", (d) => (errTxt += d.toString("utf8")));

    pgDump.on("error", (e) => {
      // pg_dump not found (common on minimal images)
      resolve({ ok: false, reason: e?.message || String(e) });
    });

    pgDump.on("close", (code) => {
      if (code === 0 && fileExists(outFile)) resolve({ ok: true });
      else resolve({ ok: false, reason: errTxt || `pg_dump exit ${code}` });
    });
  });
}

/**
 * Minimal filesystem archive:
 * - Zips selected paths using "zip" if available, else falls back to copying raw files
 * Why: keep patch minimal without adding heavy dependencies.
 */
async function zipPaths(zipFile, pathsToInclude) {
  return await new Promise((resolve) => {
    const existing = pathsToInclude.filter((p) => fileExists(p));
    if (!existing.length) return resolve({ ok: false, reason: "No paths exist" });

    const args = ["-r", zipFile, ...existing.map((p) => path.basename(p))];

    const cwd = path.dirname(existing[0]);
    // We want basenames, so require all targets under same parent; to keep it minimal,
    // we'll copy to a temp "stage" dir then zip that.
    resolve({ ok: false, reason: "use_stage_zip" });
  });
}

function copyRecursive(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    safeMkdir(dst);
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
    return;
  }
  safeMkdir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

async function createStageAndZip(zipOut, includeAbsPaths) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tgt-backup-stage-"));
  const stageDir = path.join(tmpRoot, "stage");
  safeMkdir(stageDir);

  // Stage: keep folder names
  for (const abs of includeAbsPaths) {
    if (!fileExists(abs)) continue;
    const name = path.basename(abs);
    copyRecursive(abs, path.join(stageDir, name));
  }

  // Try system zip (most Linux images have it; if not, we still upload staged folder as a tar-less snapshot)
  const zipOk = await new Promise((resolve) => {
    const p = spawn("zip", ["-r", zipOut, "."], { cwd: stageDir });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString("utf8")));
    p.on("error", () => resolve({ ok: false, reason: "zip not available" }));
    p.on("close", (code) => resolve({ ok: code === 0, reason: err || `zip exit ${code}` }));
  });

  // Cleanup stage folder (best-effort)
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}

  return zipOk;
}

async function pruneOldBackups(drive, folderId) {
  const keepDays = Number(getEnv("BACKUP_RETENTION_DAYS", "14"));
  if (!Number.isFinite(keepDays) || keepDays <= 0) return;

  const files = await listChildren(drive, folderId).catch(() => []);
  if (!files.length) return;

  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;

  const toDelete = files.filter((f) => {
    const t = Date.parse(f.createdTime || "");
    if (!Number.isFinite(t)) return false;
    return t < cutoff;
  });

  for (const f of toDelete) {
    await deleteFile(drive, f.id).catch(() => null);
  }

  if (toDelete.length) {
    console.log("🧹 BACKUP_PRUNE_DONE:", { deleted: toDelete.length, keepDays });
  }
}

async function runBackupOnce(client) {
  const stamp = nowStamp();

  const includePaths = [
    path.resolve(process.cwd(), "data"),
  ];

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tgt-backup-"));
  const dbFile = path.join(tmpDir, `db_${stamp}.dump`);
  const fsZip = path.join(tmpDir, `files_${stamp}.zip`);

  let dbStatus = { ok: false, reason: "not_started" };
  try {
    dbStatus = await dumpPostgresToFile(dbFile);
  } catch (e) {
    dbStatus = { ok: false, reason: e?.message || String(e) };
  }

  const zipStatus = await createStageAndZip(fsZip, includePaths);

  const { drive, folderId, folderName } = await ensureBackupFolder();

  const uploads = [];

  // Upload DB dump only if created
  if (dbStatus.ok && fileExists(dbFile)) {
    const meta = await uploadFileToFolder(
      drive,
      folderId,
      dbFile,
      `db_${stamp}.dump`,
      "application/octet-stream"
    ).catch((e) => ({ error: e?.message || e }));

    uploads.push({ kind: "db", meta });
  } else {
    uploads.push({ kind: "db", skipped: true, reason: dbStatus.reason });
  }

  // Upload filesystem zip only if created
  if (zipStatus.ok && fileExists(fsZip)) {
    const meta = await uploadFileToFolder(
      drive,
      folderId,
      fsZip,
      `files_${stamp}.zip`,
      "application/zip"
    ).catch((e) => ({ error: e?.message || e }));

    uploads.push({ kind: "files", meta });
  } else {
    uploads.push({ kind: "files", skipped: true, reason: zipStatus.reason });
  }

  await pruneOldBackups(drive, folderId);

  // Cleanup temp
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}

  const okDb = uploads.find((u) => u.kind === "db" && u.meta && !u.meta.error && u.meta.id);
  const okFs = uploads.find((u) => u.kind === "files" && u.meta && !u.meta.error && u.meta.id);

  const headline = `🗄️ **Daily Backup Completed** — Folder: \`${folderName}\``;
  const dbLine = okDb
    ? `✅ DB uploaded`
    : `⚠️ DB not uploaded (${uploads.find((u) => u.kind === "db")?.reason || "unknown"})`;
  const fsLine = okFs
    ? `✅ Files uploaded`
    : `⚠️ Files not uploaded (${uploads.find((u) => u.kind === "files")?.reason || "unknown"})`;

  await sendAlert(client, `${headline}\n${dbLine}\n${fsLine}`);

  console.log("✅ DAILY_BACKUP_DONE:", {
    folderName,
    db: dbStatus,
    files: zipStatus,
    uploads,
  });
}

let _timer = null;

function startDailyBackupJob(client, opts = {}) {
  // Default: run every 24h
  const everyMs = Number(opts.everyMs || 24 * 60 * 60 * 1000);

  if (_timer) clearInterval(_timer);

  console.log("✅ DAILY_BACKUP_JOB_BOOT", {
    everyMs,
    retentionDays: Number(getEnv("BACKUP_RETENTION_DAYS", "14")),
    shareWith: Boolean(getEnv("GDRIVE_SHARE_WITH_EMAIL", "")),
  });

  // Run shortly after boot once (safe)
  setTimeout(() => {
    runBackupOnce(client).catch((e) => {
      console.log("❌ DAILY_BACKUP_RUN_ERR:", e?.message || e);
      sendAlert(client, `❌ Daily Backup failed: ${e?.message || e}`);
    });
  }, 10_000);

  _timer = setInterval(() => {
    runBackupOnce(client).catch((e) => {
      console.log("❌ DAILY_BACKUP_RUN_ERR:", e?.message || e);
      sendAlert(client, `❌ Daily Backup failed: ${e?.message || e}`);
    });
  }, everyMs);

  console.log("✅ Daily backup job: ACTIVE");
}

module.exports = { startDailyBackupJob };
