// src/utils/certificateGenerator.js
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const QRCode = require("qrcode");
const { createCanvas, loadImage } = require("canvas");

// ---------- TEMP Paths (NO /data) ----------
const TMP_DIR = path.join(os.tmpdir(), "tgt-certificates");

// Keep branding assets local (read-only)
const BG_PATH = path.join(process.cwd(), "assets", "branding", "certificate-bg.png");
const LOGO_PATH = path.join(process.cwd(), "assets", "branding", "tgt-logo.png");

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ---------- Canvas ----------
const WIDTH = 1600;
const HEIGHT = 1000;

// ---------- Cache ----------
let _bgImg = null;
let _logoImg = null;

async function safeLoadImage(fileOrBuffer, tag) {
  try {
    return await loadImage(fileOrBuffer);
  } catch (err) {
    console.log(`${tag}_LOAD_FAIL:`, err?.message || err);
    return null;
  }
}

async function getBgImage() {
  if (_bgImg) return _bgImg;
  if (!fs.existsSync(BG_PATH)) return null;
  const img = await safeLoadImage(BG_PATH, "BG");
  _bgImg = img; // cache even if null to avoid repeated failures
  return _bgImg;
}

async function getLogoImage() {
  if (_logoImg) return _logoImg;
  if (!fs.existsSync(LOGO_PATH)) return null;
  const img = await safeLoadImage(LOGO_PATH, "LOGO");
  _logoImg = img;
  return _logoImg;
}

function drawCover(ctx, img) {
  const scale = Math.max(WIDTH / img.width, HEIGHT / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, (WIDTH - w) / 2, (HEIGHT - h) / 2, w, h);
}

function safeFileName(s) {
  return String(s || "user").replace(/[^\w\-]+/g, "_").slice(0, 40);
}

function safeMonthSlug(month) {
  return String(month || "month").trim().replace(/[^\w\-]+/g, "_").slice(0, 30);
}

function genVerificationCode16() {
  return crypto.randomBytes(8).toString("hex").toUpperCase(); // 16 chars
}

// ---------- Railway Bucket (S3-compatible) ----------
function getS3Config() {
  const endpoint = String(process.env.AWS_ENDPOINT_URL || "").trim();
  const bucket = String(process.env.AWS_S3_BUCKET_NAME || "").trim();
  const region = String(process.env.AWS_DEFAULT_REGION || "auto").trim();
  const accessKeyId = String(process.env.AWS_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(process.env.AWS_SECRET_ACCESS_KEY || "").trim();

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "Bucket env vars missing. Required: AWS_ENDPOINT_URL, AWS_S3_BUCKET_NAME, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (and AWS_DEFAULT_REGION optional)."
    );
  }
  return { endpoint, bucket, region, accessKeyId, secretAccessKey };
}

async function uploadPngToBucket({ key, buffer }) {
  const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
  const { endpoint, bucket, region, accessKeyId, secretAccessKey } = getS3Config();

  const s3 = new S3Client({
    region,
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: "image/png",
    })
  );

  return { bucket, key };
}

// ---------- QR (BUFFER SAFE + NEVER CRASH) ----------
async function drawQR(ctx, verificationCode) {
  try {
    const base = process.env.CERT_VERIFY_BASE_URL || "https://theghanatrader.com/verify";
    const url = `${base}?code=${encodeURIComponent(verificationCode)}`;

    const pngBuffer = await QRCode.toBuffer(url, {
      type: "png",
      errorCorrectionLevel: "M",
      scale: 6,
      margin: 1,
    });

    const img = await safeLoadImage(pngBuffer, "QR");
    if (!img) return;

    const size = 140;
    const x = 90;
    const y = HEIGHT - 90 - size;

    // backing plate
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(x - 10, y - 10, size + 20, size + 20);
    ctx.restore();

    ctx.drawImage(img, x, y, size, size);

    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "18px Georgia";
    ctx.textAlign = "left";
    ctx.fillText("Scan to verify", x, y + size + 24);
    ctx.restore();
  } catch (err) {
    console.log("QR_FAIL:", err?.message || err);
  }
}

async function generateCertificatePNG({ username, userId, rank, reward, month, verificationCode }) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  const gold = "#C9A24D";
  const white = "rgba(255,255,255,0.92)";
  const centerX = WIDTH / 2;

  const name = String(username || "Member");
  const uid = String(userId || "unknown");
  const safeMonth = safeMonthSlug(month);

  const code =
    typeof verificationCode === "string" && verificationCode.trim().length
      ? verificationCode.trim().toUpperCase().slice(0, 32)
      : genVerificationCode16();

  // ---------- Background ----------
  const bg = await getBgImage();
  if (bg) drawCover(ctx, bg);
  else {
    ctx.fillStyle = "#0b0b0b";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }

  // ---------- Prestige overlay ----------
  ctx.save();
  ctx.globalAlpha = 0.38;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.globalAlpha = 1;
  const vignette = ctx.createRadialGradient(centerX, HEIGHT / 2, 200, centerX, HEIGHT / 2, 820);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.globalAlpha = 0.22;
  const topBand = ctx.createLinearGradient(0, 0, 0, 360);
  topBand.addColorStop(0, "rgba(0,0,0,0.55)");
  topBand.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = topBand;
  ctx.fillRect(0, 0, WIDTH, 360);
  ctx.restore();

  // ---------- Border ----------
  ctx.save();
  ctx.strokeStyle = gold;
  ctx.lineWidth = 16;
  ctx.strokeRect(40, 40, WIDTH - 80, HEIGHT - 80);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(201,162,77,0.9)";
  ctx.strokeRect(70, 70, WIDTH - 140, HEIGHT - 140);
  ctx.restore();

  // ---------- Logo + watermark (safe) ----------
  const logo = await getLogoImage();
  if (logo) {
    const w = 160;
    const h = Math.round((logo.height / logo.width) * w);
    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.drawImage(logo, Math.round(centerX - w / 2), 95, w, h);
    ctx.restore();

    // watermark
    const wmW = 520;
    const wmH = Math.round((logo.height / logo.width) * wmW);
    ctx.save();
    ctx.globalAlpha = 0.10;
    ctx.drawImage(logo, Math.round(centerX - wmW / 2), 420, wmW, wmH);
    ctx.restore();
  }

  // ---------- Header ----------
  ctx.save();
  ctx.textAlign = "center";
  ctx.fillStyle = gold;
  ctx.font = "bold 64px Georgia";
  ctx.fillText("CERTIFICATE OF HONOR", centerX, 240);

  ctx.font = "28px Georgia";
  ctx.fillStyle = "rgba(201,162,77,0.95)";
  ctx.fillText("The Ghana Trader — Monthly Honors", centerX, 290);
  ctx.restore();

  // ---------- Body ----------
  ctx.save();
  ctx.fillStyle = white;
  ctx.textAlign = "center";

  ctx.font = "bold 56px Georgia";
  ctx.fillText(name, centerX, 440);

  ctx.font = "30px Georgia";
  ctx.fillText(`Rank: ${String(rank ?? "")}`, centerX, 510);
  ctx.fillText(`Reward: ${String(reward ?? "")}`, centerX, 560);
  ctx.fillText(`Month: ${String(month ?? "")}`, centerX, 610);
  ctx.restore();

  // ---------- Signature ----------
  ctx.save();
  ctx.textAlign = "center";
  ctx.fillStyle = gold;
  ctx.font = "italic 46px Georgia";
  ctx.fillText("TheGhanaTrader", centerX, 745);

  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = "22px Georgia";
  ctx.fillText("Founder & Lead Trader", centerX, 785);
  ctx.restore();

  // ---------- Verification text ----------
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.font = "20px monospace";
  ctx.textAlign = "right";
  ctx.fillText(`Verification Code: ${code}`, WIDTH - 90, HEIGHT - 90);
  ctx.restore();

  // ---------- QR (never allowed to crash) ----------
  await drawQR(ctx, code);

  // ---------- Save (TEMP) + Upload (Bucket best-effort) ----------
  const stamp = Date.now();
  const fileName = `honors_${safeMonth}_${safeFileName(name)}_${safeFileName(uid)}_${stamp}.png`;
  const filePath = path.join(TMP_DIR, fileName);

  const pngBuffer = canvas.toBuffer("image/png");

  // TEMP write for Discord AttachmentBuilder(filePath) compatibility
  fs.writeFileSync(filePath, pngBuffer);

  // Permanent upload to bucket (no /data) — BEST EFFORT (never crash ceremony)
  let uploaded = null;
  try {
    const key = `certificates/${fileName}`;
    uploaded = await uploadPngToBucket({ key, buffer: pngBuffer });
  } catch (e) {
    console.log("CERT_BUCKET_UPLOAD_FAIL:", e?.message || e);
  }

  const outPath = uploaded ? `s3://${uploaded.bucket}/${uploaded.key}` : null;

  return {
    filePath, // temp local path for immediate DM attachment
    verificationCode: code,
    bucketKey: uploaded?.key || null,
    bucketName: uploaded?.bucket || null,
    outPath, // s3 locator (not assuming public)
  };
}

module.exports = { generateCertificatePNG };
