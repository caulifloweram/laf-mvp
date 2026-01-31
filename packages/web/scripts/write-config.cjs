const fs = require("fs");
const path = require("path");

const distDir = path.join(__dirname, "..", "dist");
const configPath = path.join(distDir, "config.json");

const apiUrl = process.env.API_URL || process.env.VITE_API_URL || "http://localhost:4000";
let relayWsUrl = process.env.RELAY_WS_URL || process.env.VITE_LAF_RELAY_URL || "ws://localhost:9000";
relayWsUrl = relayWsUrl.replace(/\/$/, "");
if (!relayWsUrl.startsWith("ws://") && !relayWsUrl.startsWith("wss://")) {
  relayWsUrl = "wss://" + relayWsUrl;
}

const config = {
  apiUrl: apiUrl.replace(/\/$/, ""),
  relayWsUrl,
};

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}
fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
console.log("write-config: wrote", configPath, config);
