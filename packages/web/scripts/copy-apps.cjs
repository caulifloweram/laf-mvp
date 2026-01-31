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

copyDir(clientWebDist, path.join(webDist, "client"));
copyDir(broadcasterWebDist, path.join(webDist, "broadcaster"));
console.log("copy-apps: copied client and broadcaster into dist/");
