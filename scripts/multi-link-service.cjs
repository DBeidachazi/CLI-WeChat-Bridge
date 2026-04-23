#!/usr/bin/env node
"use strict";

const chokidar = require("chokidar");
const fs = require("fs-extra");
const path = require("node:path");

const args = process.argv.slice(2);

function readOption(name, defaultValue = "") {
  const index = args.indexOf(name);
  if (index === -1) {
    return defaultValue;
  }
  return args[index + 1] ?? defaultValue;
}

function hasFlag(name) {
  return args.includes(name);
}

const sharedRoot = path.resolve(
  readOption("--shared-root", path.join(process.cwd(), ".linkai"))
);
const targetRoots = readOption("--target-roots", "")
  .split(path.delimiter)
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => path.resolve(entry));
const once = hasFlag("--once");

function targetDocNameForRoot(root) {
  const name = path.basename(root);
  if (name === ".claude") {
    return "CLAUDE.md";
  }
  if (name === ".gemini") {
    return "GEMINI.md";
  }
  return "AGENT.md";
}

const MANAGED_DOC_NAMES = ["AGENT.md", "CLAUDE.md", "GEMINI.md"];
const SKILLS_DIRNAME = "skills";
const cooldownMs = 500;
let isSyncing = false;
let releaseLockTimer = null;

function log(message) {
  process.stderr.write(`[multi-link-service] ${message}\n`);
}

function scheduleUnlock() {
  if (releaseLockTimer) {
    clearTimeout(releaseLockTimer);
  }
  releaseLockTimer = setTimeout(() => {
    isSyncing = false;
    releaseLockTimer = null;
  }, cooldownMs);
}

function buildDocGroups() {
  return [
    [
      path.join(sharedRoot, "AGENT.shared.md"),
      ...targetRoots.map((root) => path.join(root, targetDocNameForRoot(root))),
    ].map((entry) => path.resolve(entry)),
  ];
}

function buildSkillsRoots() {
  return [
    path.join(sharedRoot, SKILLS_DIRNAME),
    ...targetRoots.map((root) => path.join(root, SKILLS_DIRNAME)),
  ].map((entry) => path.resolve(entry));
}

function ensureBaseLayout() {
  fs.ensureDirSync(sharedRoot);
  fs.ensureDirSync(path.join(sharedRoot, SKILLS_DIRNAME));
  for (const targetRoot of targetRoots) {
    fs.ensureDirSync(targetRoot);
    fs.ensureDirSync(path.join(targetRoot, SKILLS_DIRNAME));
    for (const docName of MANAGED_DOC_NAMES) {
      if (docName !== targetDocNameForRoot(targetRoot)) {
        fs.rmSync(path.join(targetRoot, docName), {
          recursive: true,
          force: true,
        });
      }
    }
  }
}

function pathsEqual(left, right) {
  return path.resolve(left) === path.resolve(right);
}

function normalizeRelativeSkillPath(filePath) {
  const skillsRoots = buildSkillsRoots();
  for (const root of skillsRoots) {
    if (pathsEqual(filePath, root)) {
      return "";
    }
    if (filePath.startsWith(`${root}${path.sep}`)) {
      return path.relative(root, filePath);
    }
  }
  return null;
}

function groupForFile(filePath) {
  const normalized = path.resolve(filePath);
  for (const group of buildDocGroups()) {
    if (group.some((entry) => pathsEqual(entry, normalized))) {
      return group;
    }
  }

  const relativeSkillPath = normalizeRelativeSkillPath(normalized);
  if (relativeSkillPath !== null && relativeSkillPath !== "") {
    return buildSkillsRoots().map((root) => path.join(root, relativeSkillPath));
  }

  return null;
}

function copyIntoGroup(sourcePath, group) {
  if (!fs.existsSync(sourcePath)) {
    return;
  }

  for (const targetPath of group) {
    if (pathsEqual(targetPath, sourcePath)) {
      continue;
    }
    if (fs.existsSync(targetPath)) {
      const sourceBuffer = fs.readFileSync(sourcePath);
      const targetBuffer = fs.readFileSync(targetPath);
      if (sourceBuffer.equals(targetBuffer)) {
        continue;
      }
    }
    fs.ensureDirSync(path.dirname(targetPath));
    fs.copySync(sourcePath, targetPath, { overwrite: true });
    log(`synced ${sourcePath} -> ${targetPath}`);
  }
}

function seedMissingFilesInGroup(group) {
  const existing = group.find(
    (entry) => fs.existsSync(entry) && fs.statSync(entry).isFile()
  );
  if (!existing) {
    return;
  }
  copyIntoGroup(existing, group);
}

function walkFiles(rootPath, relativePrefix = "") {
  if (!fs.existsSync(rootPath)) {
    return [];
  }

  const entries = fs.readdirSync(rootPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = relativePrefix
      ? path.join(relativePrefix, entry.name)
      : entry.name;
    const absolutePath = path.join(rootPath, relativePath);
    if (entry.isDirectory()) {
      files.push(...walkFiles(absolutePath, relativePath));
      continue;
    }
    if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

function seedInitialState() {
  for (const group of buildDocGroups()) {
    seedMissingFilesInGroup(group);
  }

  const skillsRoots = buildSkillsRoots();
  const relativeFiles = new Set();
  for (const root of skillsRoots) {
    for (const relativeFile of walkFiles(root)) {
      relativeFiles.add(relativeFile);
    }
  }

  for (const relativeFile of relativeFiles) {
    const group = skillsRoots.map((root) => path.join(root, relativeFile));
    seedMissingFilesInGroup(group);
  }
}

function shouldWatchTarget(targetPath) {
  if (fs.existsSync(targetPath)) {
    return true;
  }
  return fs.existsSync(path.dirname(targetPath));
}

function buildWatchTargets() {
  const targets = new Set();
  for (const group of buildDocGroups()) {
    for (const entry of group) {
      if (shouldWatchTarget(entry)) {
        targets.add(entry);
      }
    }
  }

  for (const entry of buildSkillsRoots()) {
    if (shouldWatchTarget(entry)) {
      targets.add(entry);
    }
  }

  return [...targets];
}

function handleSourceChange(sourcePath) {
  if (isSyncing) {
    return;
  }
  const group = groupForFile(sourcePath);
  if (!group) {
    return;
  }
  if (!(fs.existsSync(sourcePath) && fs.statSync(sourcePath).isFile())) {
    return;
  }

  isSyncing = true;
  try {
    copyIntoGroup(sourcePath, group);
  } finally {
    scheduleUnlock();
  }
}

function main() {
  if (targetRoots.length === 0) {
    log("No target roots were provided. Nothing to sync.");
    process.exit(0);
  }

  ensureBaseLayout();
  seedInitialState();

  if (once) {
    log("completed one-shot sync");
    process.exit(0);
  }

  const watchTargets = buildWatchTargets();

  log(
    `starting chokidar sync service sharedRoot=${sharedRoot} targets=${targetRoots.join(",")}`
  );

  const watcher = chokidar.watch(watchTargets, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  watcher.on("add", handleSourceChange);
  watcher.on("change", handleSourceChange);

  const shutdown = async () => {
    if (releaseLockTimer) {
      clearTimeout(releaseLockTimer);
      releaseLockTimer = null;
    }
    await watcher.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
