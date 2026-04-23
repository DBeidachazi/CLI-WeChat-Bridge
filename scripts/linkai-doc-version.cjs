#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const INITIAL_VERSION = "1.0.0";
const MODULE_TITLE_PATTERN = /<title>\s*([^<]+?)\s*<\/title>/u;
const MODULE_VERSION_PATTERN = /<version>\s*([^<]+?)\s*<\/version>/u;
const VERSION_MARKER_PATTERN =
  /<!--\s*linkai:version=([0-9]+(?:\.[0-9]+){2})\s*-->/u;
const VERSION_MARKER_REPLACE_PATTERN =
  /<!--\s*linkai:version=[0-9]+(?:\.[0-9]+){2}\s*-->/u;
const MARKDOWN_EXTENSION_PATTERN = /\.md$/u;
const SHARED_STEM_PATTERN = /\.shared$/u;
const PATCH_FILENAME_PATTERN = /^(.+)-([0-9]+(?:\.[0-9]+){2})\.md$/u;

function readOption(name, defaultValue = "") {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return defaultValue;
  }
  return process.argv[index + 1] ?? defaultValue;
}

function log(message) {
  process.stderr.write(`[linkai-doc-version] ${message}\n`);
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map((part) => Number(part));
  const rightParts = right.split(".").map((part) => Number(part));
  for (let index = 0; index < 3; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

function parseModuleConfig(configPath) {
  const xml = fs.readFileSync(configPath, "utf8");
  const title = xml.match(MODULE_TITLE_PATTERN)?.[1];
  const version = xml.match(MODULE_VERSION_PATTERN)?.[1];
  if (!(title && version)) {
    throw new Error(`Invalid LinkAI module config: ${configPath}`);
  }
  return { title, version };
}

function readCurrentVersion(content) {
  return content.match(VERSION_MARKER_PATTERN)?.[1] ?? INITIAL_VERSION;
}

function writeVersionMarker(content, version) {
  const marker = `<!-- linkai:version=${version} -->`;
  if (VERSION_MARKER_REPLACE_PATTERN.test(content)) {
    return content.replace(VERSION_MARKER_REPLACE_PATTERN, marker);
  }
  return `${marker}\n\n${content}`;
}

function patchCandidates(configDir, title) {
  const stem = title.replace(MARKDOWN_EXTENSION_PATTERN, "");
  const relaxedStem = stem.replace(SHARED_STEM_PATTERN, ".share");
  const allowedStems = new Set([stem, relaxedStem]);
  return fs
    .readdirSync(configDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .map((name) => {
      const match = name.match(PATCH_FILENAME_PATTERN);
      if (!(match && allowedStems.has(match[1]))) {
        return null;
      }
      return {
        filePath: path.join(configDir, name),
        version: match[2],
      };
    })
    .filter(Boolean)
    .sort((left, right) => compareVersions(left.version, right.version));
}

function applyMissingPatches({ sharedRoot, configPath }) {
  const configDir = path.dirname(configPath);
  const { title, version: targetVersion } = parseModuleConfig(configPath);
  const docPath = path.join(sharedRoot, title);
  fs.mkdirSync(path.dirname(docPath), { recursive: true });

  let content = fs.existsSync(docPath) ? fs.readFileSync(docPath, "utf8") : "";
  const currentVersion = readCurrentVersion(content);
  if (compareVersions(currentVersion, targetVersion) >= 0) {
    return;
  }

  const patches = patchCandidates(configDir, title).filter(
    (patch) =>
      compareVersions(patch.version, currentVersion) > 0 &&
      compareVersions(patch.version, targetVersion) <= 0
  );

  for (const patch of patches) {
    const patchContent = fs.readFileSync(patch.filePath, "utf8").trim();
    if (!patchContent) {
      continue;
    }
    content = `${content.trimEnd()}\n\n<!-- linkai:patch-start version=${patch.version} -->\n${patchContent}\n<!-- linkai:patch-end version=${patch.version} -->\n`;
  }

  content = writeVersionMarker(content, targetVersion);
  fs.writeFileSync(docPath, content, "utf8");
  log(`${title}: ${currentVersion} -> ${targetVersion}`);
}

function main() {
  const sharedRoot = path.resolve(
    readOption("--shared-root", path.join(process.cwd(), ".linkai"))
  );
  const configPath = path.resolve(
    readOption("--config", path.join(sharedRoot, "config", "markdown.xml"))
  );
  if (!fs.existsSync(configPath)) {
    return;
  }
  applyMissingPatches({ sharedRoot, configPath });
}

main();
