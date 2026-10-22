"use strict";

const { spawnSync } = require("node:child_process");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

function escapeXml(value) {
 return String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
 })[character]);
}

function git(projectDir, args) {
 const result = spawnSync("git", args, { cwd: projectDir, encoding: "utf8" });
 return result.status === 0 ? result.stdout.trim() : "";
}

exports.generateAppStream = function generateAppStream(projectDir) {
 const pkg = JSON.parse(readFileSync(path.join(projectDir, "package.json"), "utf8"));
 const { appId, publish, snapcraft } = pkg.build;
 const repository = `https://github.com/${publish.owner}/${publish.repo}`;
 const author = typeof pkg.author === "string" ? pkg.author.split(/\s*</)[0] : pkg.author.name;
 const tagDate = git(projectDir, ["for-each-ref", `refs/tags/${pkg.version}`, "--format=%(creatordate:short)"]);
 const date = tagDate || git(projectDir, ["log", "-1", "--format=%cs"]);
 const revision = tagDate ? pkg.version : git(projectDir, ["rev-parse", "HEAD"]);
 // Untagged builds use the commit date, never the build date. Source archives
 // without Git data omit release history rather than invent a release date.
 const release = date ? `
 <releases>
  <release version="${escapeXml(pkg.version)}" date="${escapeXml(date)}" type="${tagDate ? "stable" : "development"}">${tagDate ? `
   <url type="details">${escapeXml(`${repository}/releases/tag/${pkg.version}`)}</url>
  ` : ""}</release>
 </releases>` : "";
 const screenshot = revision ? `
 <screenshots>
  <screenshot type="default">
   <image>${escapeXml(`${repository}/raw/${revision}/assets/sidra-screenshot.png`)}</image>
  </screenshot>
 </screenshots>` : "";
 const xml = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
 <id>${escapeXml(appId)}</id>
 <name>${escapeXml(pkg.productName)}</name>
 <summary>${escapeXml(snapcraft[snapcraft.base].summary)}</summary>
 <metadata_license>CC0-1.0</metadata_license>
 <project_license>${escapeXml(pkg.license)}</project_license>
 <developer><name>${escapeXml(author)}</name></developer>
 <description>
  <p>Listen to Apple Music and Apple Music Classical from your desktop.</p>
  <p>An Apple Music subscription is required for playback.</p>
 </description>
 <launchable type="desktop-id">${escapeXml(appId)}.desktop</launchable>
 <url type="homepage">${escapeXml(pkg.homepage)}</url>
 <url type="bugtracker">${escapeXml(`${repository}/issues`)}</url>
 <categories><category>AudioVideo</category><category>Audio</category><category>Music</category></categories>
 <content_rating type="oars-1.1"/>${screenshot}${release}
</component>
`;
 const outputDir = path.join(projectDir, "release", "metainfo");
 mkdirSync(outputDir, { recursive: true });
 const output = path.join(outputDir, `${appId}.metainfo.xml`);
 writeFileSync(output, xml);
 return output;
};
