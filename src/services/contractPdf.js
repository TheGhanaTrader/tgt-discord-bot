// src/services/contractPdf.js
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const { templatePdfPath } = require("../config/contractGate");

// AWS S3-compatible (Railway Bucket) — loaded only when needed
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

async function uploadPdfToBucket({ key, bytes }) {
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
      Body: Buffer.from(bytes),
      ContentType: "application/pdf",
      ContentDisposition: `attachment; filename="${path.basename(key)}"`,
    })
  );

  return { bucket, key };
}

function safeName(str) {
  return String(str || "")
    .replace(/[^\w\- ]/g, "")
    .trim()
    .slice(0, 60);
}

async function generatePersonalizedContractPdf({ username, userId, tier, acceptedAtUtc }) {
  const absTemplate = path.join(process.cwd(), templatePdfPath);

  if (!fs.existsSync(absTemplate)) {
    throw new Error(`Contract template PDF not found at: ${absTemplate}`);
  }

  const templateBytes = fs.readFileSync(absTemplate);
  const pdfDoc = await PDFDocument.load(templateBytes);

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();
  const lastPage = pages[pages.length - 1];

  // ---- Stamp settings (safe defaults) ----
  const { width } = lastPage.getSize();
  const x = 50;
  const y = 60; // near bottom
  const size = 9;

  const lines = [
    "Acceptance Record (Auto-generated):",
    `Discord: ${safeName(username)} (${userId})`,
    `Tier at acceptance: ${tier}`,
    `Accepted (UTC): ${acceptedAtUtc}`,
    "Project: The Ghana Trader Desk",
  ];

  // Light box behind text (so it reads on any background)
  lastPage.drawRectangle({
    x: x - 6,
    y: y - 6,
    width: Math.min(width - 100, 420),
    height: 60,
    color: rgb(1, 1, 1),
    opacity: 0.85,
    borderColor: rgb(0.85, 0.85, 0.85),
    borderWidth: 1,
  });

  let yy = y + 42;
  for (const line of lines) {
    lastPage.drawText(line, {
      x,
      y: yy,
      size,
      font,
      color: rgb(0, 0, 0),
    });
    yy -= 11;
  }

  const fileName = `Contract_${safeName(username)}_${userId}_${acceptedAtUtc.replace(/[:]/g, "-")}.pdf`;
  const outBytes = await pdfDoc.save();

  // ✅ TEMP write (for DM + log attachment) — NO /data
  const tmpDir = path.join(os.tmpdir(), "tgt-contracts");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, fileName);
  fs.writeFileSync(filePath, Buffer.from(outBytes));

  // ✅ Upload to Railway Bucket (permanent storage)
  const key = `contracts/${fileName}`;
  const uploaded = await uploadPdfToBucket({ key, bytes: outBytes });

  // stable locator (not assuming public)
  const outPath = `s3://${uploaded.bucket}/${uploaded.key}`;

  return {
    filePath,              // local temp path for AttachmentBuilder
    fileName,
    outPath,               // bucket locator
    bucketKey: uploaded.key,
    bucketName: uploaded.bucket,
  };
}

module.exports = { generatePersonalizedContractPdf };
