// tools/getDriveRefreshToken.js
"use strict";

const http = require("http");
const { google } = require("googleapis");

function mustGetEnv(name) {
  const v = String(process.env[name] || "").trim();
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function main() {
  const clientId = mustGetEnv("GDRIVE_OAUTH_CLIENT_ID");
  const clientSecret = mustGetEnv("GDRIVE_OAUTH_CLIENT_SECRET");
  const redirectUri = "http://localhost:3333/oauth2callback";

  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const url = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/drive"],
  });

  console.log("\n1) Open this URL in your browser and approve:\n");
  console.log(url);
  console.log("\nWaiting for Google redirect on http://localhost:3333/oauth2callback ...\n");

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url || !req.url.startsWith("/oauth2callback")) {
        res.writeHead(404);
        return res.end("Not found");
      }

      const u = new URL(req.url, "http://localhost:3333");
      const code = u.searchParams.get("code");

      if (!code) {
        res.writeHead(400);
        return res.end("Missing code");
      }

      const { tokens } = await oAuth2Client.getToken(code);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Approved. You can close this tab and return to the terminal.");

      console.log("\n✅ TOKENS RECEIVED\n");
      console.log("REFRESH_TOKEN:\n" + (tokens.refresh_token || ""));
      console.log("\n(access_token present: " + Boolean(tokens.access_token) + ")\n");

      if (!tokens.refresh_token) {
        console.log(
          "⚠️ No refresh token returned. This usually means you already approved before.\n" +
            "Fix: revoke access in your Google Account > Security > Third-party access,\n" +
            "then run this script again."
        );
      }

      server.close();
    } catch (e) {
      console.error("❌ ERROR:", e?.message || e);
      res.writeHead(500);
      res.end("Error. Check terminal.");
      server.close();
    }
  });

  server.listen(3333);
}

main().catch((e) => {
  console.error("❌ FATAL:", e?.message || e);
  process.exit(1);
});