// src/services/contractPdf.js
const fs = require("fs");
const path = require("path");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const { templatePdfPath } = require("../config/contractGate");

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
  const { width, height } = lastPage.getSize();
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

  const outDir = path.join(process.cwd(), "data", "contracts");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const fileName = `Contract_${safeName(username)}_${userId}_${acceptedAtUtc.replace(/[:]/g, "-")}.pdf`;
  const outPath = path.join(outDir, fileName);

  const outBytes = await pdfDoc.save();
  fs.writeFileSync(outPath, outBytes);

  return { outPath, fileName };
}

module.exports = { generatePersonalizedContractPdf };
