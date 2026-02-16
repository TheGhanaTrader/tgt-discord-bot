// src/services/contractPdf.js
const fs = require("fs");
const path = require("path");
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
  // Requires dependency: @aws-sdk/client-s3
  const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

  const { endpoint, bucket, region, accessKeyId, secretAccessKey } = getS3Config();

  const s3 = new S3Client({
    region,
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true, // important for many S3-compatible endpoints (incl. Railway)
  });

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: Buffer.from(bytes),
      ContentType: "application/pdf",
    })
  );

  // We return a stable locator string (not assuming public access)
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
  // Places a small "Acceptance Record" block near bottom of last page.
  // If you want it elsewhere, change x/y.
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

  // ✅ Upload to Railway Bucket (NO /data writes)
  const key = `contracts/${fileName}`;
  const uploaded = await uploadPdfToBucket({ key, bytes: outBytes });

  // Keep return shape stable. outPath becomes a bucket locator.
  // (Later we’ll store uploaded.key / bucket in Postgres instead of filesystem paths.)
  const outPath = `s3://${uploaded.bucket}/${uploaded.key}`;

  return { outPath, fileName, bucketKey: uploaded.key, bucketName: uploaded.bucket };
}

module.exports = { generatePersonalizedContractPdf };
