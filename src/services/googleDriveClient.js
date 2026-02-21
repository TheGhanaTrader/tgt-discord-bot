// src/services/googleDriveClient.js
"use strict";

const { google } = require("googleapis");

function mustGetEnv(name) {
  const v = String(process.env[name] || "").trim();
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function getEnv(name, fallback = "") {
  const v = String(process.env[name] || "").trim();
  return v || fallback;
}

function hasEnv(name) {
  return Boolean(String(process.env[name] || "").trim());
}

/**
 * --- Auth mode selection ---
 * 1) Prefer OAuth (your Gmail) when refresh token exists
 * 2) Fallback to Service Account if present (for safe transition)
 */

function parseServiceAccountJson() {
  const raw = mustGetEnv("GDRIVE_SERVICE_ACCOUNT_JSON");

  // Railway can store multiline; also allow base64 (optional)
  let txt = raw;
  if (!raw.startsWith("{") && /^[A-Za-z0-9+/=]+$/.test(raw)) {
    try {
      txt = Buffer.from(raw, "base64").toString("utf8");
    } catch {
      // ignore; will fail JSON.parse below
    }
  }

  try {
    return JSON.parse(txt);
  } catch {
    throw new Error(
      "GDRIVE_SERVICE_ACCOUNT_JSON is not valid JSON (or valid base64 JSON)."
    );
  }
}

function createDriveViaServiceAccount() {
  const sa = parseServiceAccountJson();

  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  return google.drive({ version: "v3", auth });
}

function createDriveViaOAuth() {
  const clientId = mustGetEnv("GDRIVE_OAUTH_CLIENT_ID");
  const clientSecret = mustGetEnv("GDRIVE_OAUTH_CLIENT_SECRET");
  const redirectUri = mustGetEnv("GDRIVE_OAUTH_REDIRECT_URI");

  const refreshToken = String(process.env.GDRIVE_OAUTH_REFRESH_TOKEN || "").trim();
  if (!refreshToken) {
    // We intentionally do NOT try to run interactive auth here.
    // Next step will generate the refresh token and you’ll paste it into Railway.
    throw new Error(
      "Missing env: GDRIVE_OAUTH_REFRESH_TOKEN (OAuth client is set, but refresh token not added yet)."
    );
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  auth.setCredentials({ refresh_token: refreshToken });

  return google.drive({ version: "v3", auth });
}

function createDrive() {
  // Prefer OAuth if configured (your Gmail Drive)
  const hasOAuthCore =
    hasEnv("GDRIVE_OAUTH_CLIENT_ID") &&
    hasEnv("GDRIVE_OAUTH_CLIENT_SECRET") &&
    hasEnv("GDRIVE_OAUTH_REDIRECT_URI");

  if (hasOAuthCore && hasEnv("GDRIVE_OAUTH_REFRESH_TOKEN")) {
    return createDriveViaOAuth();
  }

  // Safe fallback: service account (during transition)
  if (hasEnv("GDRIVE_SERVICE_ACCOUNT_JSON")) {
    return createDriveViaServiceAccount();
  }

  // If OAuth core exists but refresh token missing, throw the correct next-step error
  if (hasOAuthCore) {
    return createDriveViaOAuth(); // will throw Missing refresh token
  }

  throw new Error(
    "Google Drive auth not configured. Set OAuth vars (preferred) or GDRIVE_SERVICE_ACCOUNT_JSON."
  );
}

async function findFolderByName(drive, name) {
  const q = [
    "mimeType='application/vnd.google-apps.folder'",
    "trashed=false",
    `name='${String(name).replace(/'/g, "\\'")}'`,
  ].join(" and ");

  const res = await drive.files.list({
    q,
    fields: "files(id,name,createdTime)",
    spaces: "drive",
    pageSize: 10,
  });

  const files = res?.data?.files || [];
  return files[0] || null;
}

async function createFolder(drive, name) {
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
    },
    fields: "id,name",
  });

  return res?.data || null;
}

async function ensureWriterShare(drive, fileId, email) {
  const shareEmail = String(email || "").trim();
  if (!shareEmail) return;

  // Try to list existing permissions to avoid duplicates (best-effort)
  let hasIt = false;
  try {
    const p = await drive.permissions.list({
      fileId,
      fields: "permissions(id,type,emailAddress,role)",
      pageSize: 100,
    });

    const perms = p?.data?.permissions || [];
    hasIt = perms.some(
      (x) =>
        x?.type === "user" &&
        String(x?.emailAddress || "").toLowerCase() === shareEmail.toLowerCase()
    );
  } catch {
    // ignore; we can still attempt to create permission
  }

  if (hasIt) return;

  // IMPORTANT: sendNotificationEmail false to avoid email noise
  await drive.permissions.create({
    fileId,
    sendNotificationEmail: false,
    requestBody: {
      type: "user",
      role: "writer",
      emailAddress: shareEmail,
    },
  });
}

async function ensureBackupFolder() {
  const drive = createDrive();

  const folderName = getEnv("GDRIVE_BACKUP_FOLDER_NAME", "TGT_DAILY_BACKUPS");
  const shareWith = getEnv("GDRIVE_SHARE_WITH_EMAIL", "");

  let folder = await findFolderByName(drive, folderName).catch(() => null);

  if (!folder?.id) {
    folder = await createFolder(drive, folderName);
  }

  if (!folder?.id) throw new Error("Failed to create/find Drive folder.");

  // Optional: share folder to your Gmail so you can see it under "Shared with me"
  if (shareWith) {
    await ensureWriterShare(drive, folder.id, shareWith).catch((e) => {
      console.log("⚠️ GDRIVE_SHARE_FAILED:", e?.message || e);
    });
  }

  return { drive, folderId: folder.id, folderName };
}

async function uploadFileToFolder(drive, folderId, localPath, driveName, mime) {
  const fs = require("fs");

  const stream = fs.createReadStream(localPath);
  const res = await drive.files.create({
    requestBody: {
      name: driveName,
      parents: [folderId],
    },
    media: {
      mimeType: mime || "application/octet-stream",
      body: stream,
    },
    fields: "id,name,webViewLink",
  });

  return res?.data || null;
}

async function listChildren(drive, folderId) {
  const q = [`'${folderId}' in parents`, "trashed=false"].join(" and ");

  const res = await drive.files.list({
    q,
    fields: "files(id,name,createdTime)",
    spaces: "drive",
    pageSize: 1000,
  });

  return res?.data?.files || [];
}

async function deleteFile(drive, fileId) {
  await drive.files.delete({ fileId });
}

module.exports = {
  ensureBackupFolder,
  uploadFileToFolder,
  listChildren,
  deleteFile,
};