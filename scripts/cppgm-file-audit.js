#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_PATHS = ["dev"];
const DEFAULT_MAX_FILE_LINES = 1500;
const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
]);
const SKIP_DIRS = new Set([".git", "obj", "node_modules", "build", "dist"]);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const root = path.resolve(process.cwd(), options.root);
  const files = [];
  for (const inputPath of options.paths) {
    const targetPath = path.resolve(root, inputPath);
    await collectSourceFiles(targetPath, files);
  }

  files.sort();
  const violations = [];
  for (const filePath of files) {
    const text = await fs.readFile(filePath, "utf8");
    const lineCount = countLines(text);
    if (lineCount > options.maxFileLines) {
      violations.push({
        path: path.relative(root, filePath),
        lines: lineCount,
        limit: options.maxFileLines,
      });
    }
  }

  if (violations.length === 0) {
    const stageText = options.stage ? ` for ${options.stage}` : "";
    console.log(
      `File audit passed${stageText}: ${files.length} files checked; max file lines ${options.maxFileLines}.`,
    );
    return;
  }

  const stageText = options.stage ? ` for ${options.stage}` : "";
  console.log(
    `File audit failed${stageText}: ${violations.length} files exceed ${options.maxFileLines} lines.`,
  );
  for (const violation of violations) {
    console.log(`  ${violation.path}: ${violation.lines} lines (limit ${violation.limit})`);
  }
  process.exitCode = 1;
}

function parseArgs(argv) {
  const options = {
    root: ".",
    paths: [],
    maxFileLines: DEFAULT_MAX_FILE_LINES,
    stage: "",
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    const [key, inlineValue] = arg.split("=", 2);
    if (key === "--root") {
      options.root = readValue(argv, inlineValue, index, key);
      index += inlineValue == null ? 1 : 0;
      continue;
    }
    if (key === "--stage") {
      options.stage = readValue(argv, inlineValue, index, key);
      index += inlineValue == null ? 1 : 0;
      continue;
    }
    if (key === "--max-file-lines") {
      options.maxFileLines = parsePositiveInt(readValue(argv, inlineValue, index, key), key);
      index += inlineValue == null ? 1 : 0;
      continue;
    }
    if (key === "--path" || key === "--paths") {
      const value = readValue(argv, inlineValue, index, key);
      options.paths.push(...value.split(",").map((entry) => entry.trim()).filter(Boolean));
      index += inlineValue == null ? 1 : 0;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.paths.length === 0) {
    options.paths = [...DEFAULT_PATHS];
  }
  return options;
}

function readValue(argv, inlineValue, index, key) {
  const value = inlineValue ?? argv[index + 1];
  if (value == null || value.startsWith("--")) {
    throw new Error(`${key} requires a value`);
  }
  return value;
}

function parsePositiveInt(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

async function collectSourceFiles(targetPath, files) {
  const stat = await fs.stat(targetPath);
  if (stat.isFile()) {
    if (SOURCE_EXTENSIONS.has(path.extname(targetPath))) {
      files.push(targetPath);
    }
    return;
  }
  if (!stat.isDirectory()) {
    return;
  }

  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const childPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      await collectSourceFiles(childPath, files);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(childPath);
    }
  }
}

function countLines(text) {
  if (text.length === 0) {
    return 0;
  }
  const newlineCount = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlineCount : newlineCount + 1;
}

function printUsage() {
  process.stdout.write(`Usage:
  node scripts/cppgm-file-audit.js [--root DIR] [--paths dev] [--max-file-lines N] [--stage paN]

Checks C/C++ source and header files for file-size limits. Paths are relative to
--root, which defaults to the current working directory.
`);
}

main().catch((error) => {
  console.error(error?.message ?? String(error));
  process.exit(1);
});
