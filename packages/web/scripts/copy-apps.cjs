const fs = require("fs");
const path = require("path");

const webDist = path.join(__dirname, "..", "dist");
const clientWebDist = path.join(__dirname, "..", "..", "client-web", "dist");
const broadcasterWebDist = path.join(__dirname, "..", "..", "broadcaster-web", "dist");

function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn("copy-apps: source does not exist:", src);
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const srcPath = path.join(src, name);
    const destPath = path.join(dest, name);
    if (fs.statSync(srcPath).isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

copyDir(clientWebDist, webDist);
copyDir(broadcasterWebDist, path.join(webDist, "broadcaster"));

// So that /broadcaster (no trailing slash) redirects to /broadcaster/ and serves index.html
const serveJson = path.join(webDist, "serve.json");
fs.writeFileSync(
  serveJson,
  JSON.stringify(
    {
      trailingSlash: true,
      redirects: [{ source: "/broadcaster", destination: "/broadcaster/", type: 301 }],
    },
    null,
    2
  )
);

console.log("copy-apps: client at root, broadcaster at dist/broadcaster/");
