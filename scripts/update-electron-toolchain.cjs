#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const packageJsonPath = "package.json";
const castLabsStableTagPattern = /^v(\d+)\.(\d+)\.(\d+)\+wvcus$/;
const electronBuilderRepo = "https://github.com/electron-userland/electron-builder.git";

function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function compareTriplets(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }

  return 0;
}

function parseCastLabsTag(tag) {
  const match = castLabsStableTagPattern.exec(tag);
  if (match === null) {
    return null;
  }

  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

function latestCastLabsElectronTag() {
  const refs = run("git", [
    "ls-remote",
    "--tags",
    "https://github.com/castlabs/electron-releases.git",
    "refs/tags/v*+wvcus",
  ]);

  const latest = refs
    .split(/\r?\n/)
    .map((line) => line.split(/\s+/)[1])
    .filter((ref) => ref !== undefined && !ref.endsWith("^{}"))
    .map((ref) => ref.replace("refs/tags/", ""))
    .map((tag) => ({ tag, parts: parseCastLabsTag(tag) }))
    .filter((entry) => entry.parts !== null)
    .sort((left, right) => compareTriplets(left.parts, right.parts))
    .at(-1);

  if (latest === undefined) {
    throw new Error("No stable CastLabs Electron WVCUS tags found");
  }

  return latest.tag;
}

function latestElectronBuilderTag(packageName) {
  const tagPattern = new RegExp(`^${packageName}@(\\d+)\\.(\\d+)\\.(\\d+)$`);
  const refs = run("git", [
    "ls-remote",
    "--tags",
    electronBuilderRepo,
    `refs/tags/${packageName}@*`,
  ]);

  const latest = refs
    .split(/\r?\n/)
    .map((line) => line.split(/\s+/)[1])
    .filter((ref) => ref !== undefined && !ref.endsWith("^{}"))
    .map((ref) => ref.replace("refs/tags/", ""))
    .map((tag) => {
      const match = tagPattern.exec(tag);
      return {
        tag,
        parts: match?.slice(1).map((part) => Number.parseInt(part, 10)) ?? null,
      };
    })
    .filter((entry) => entry.parts !== null)
    .sort((left, right) => compareTriplets(left.parts, right.parts))
    .at(-1);

  if (latest === undefined) {
    throw new Error(`No stable ${packageName} tags found`);
  }

  return latest.tag.replace(`${packageName}@`, "");
}

function setDependency(packageJson, section, name, value) {
  if (packageJson[section]?.[name] === undefined) {
    throw new Error(`${section}.${name} is missing from package.json`);
  }

  if (packageJson[section][name] === value) {
    return false;
  }

  packageJson[section][name] = value;
  console.log(`${name}: ${value}`);
  return true;
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const targets = {
  electron: `github:castlabs/electron-releases#${latestCastLabsElectronTag()}`,
  "electron-builder": `^${latestElectronBuilderTag("electron-builder")}`,
  "electron-updater": `^${latestElectronBuilderTag("electron-updater")}`,
};

const changed = [
  setDependency(packageJson, "devDependencies", "electron", targets.electron),
  setDependency(packageJson, "devDependencies", "electron-builder", targets["electron-builder"]),
  setDependency(packageJson, "dependencies", "electron-updater", targets["electron-updater"]),
].some(Boolean);

if (changed) {
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
} else {
  console.log("Electron toolchain is current");
}
