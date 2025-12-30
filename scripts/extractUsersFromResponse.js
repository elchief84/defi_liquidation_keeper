#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

function readJsonFile(jsonPath) {
  let raw;
  try {
    raw = fs.readFileSync(jsonPath, "utf8");
  } catch (error) {
    throw new Error(`Impossibile leggere il file: ${jsonPath}\n${error.message}`);
  }

  if (raw.trim() === "") return null;

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`JSON non valido in: ${jsonPath}\n${error.message}`);
  }
}

function collectUserStrings(value, out) {
  if (value == null) return;

  if (Array.isArray(value)) {
    for (const item of value) collectUserStrings(item, out);
    return;
  }

  if (typeof value !== "object") return;

  if (Object.prototype.hasOwnProperty.call(value, "user")) {
    const userValue = value.user;
    if (typeof userValue === "string") out.push(userValue);
    else if (Array.isArray(userValue)) {
      for (const item of userValue) {
        if (typeof item === "string") out.push(item);
      }
    }
  }

  for (const key of Object.keys(value)) {
    collectUserStrings(value[key], out);
  }
}

function main() {
  const inputArg = process.argv[2] || "data/response.json";
  const inputPath = path.resolve(process.cwd().replaceAll(' ', '\ '), inputArg);
  const outputPath = path.resolve(process.cwd(), "data/targets.json");

  const parsed = readJsonFile(inputPath);
  if (parsed == null) {
    process.stderr.write(`File vuoto: ${inputArg}\n`);
    fs.writeFileSync(outputPath, "[]\n", "utf8");
    process.stdout.write("[]\n");
    return;
  }

  const rows = parsed?.result?.rows;
  const users = [];
  collectUserStrings(rows, users);

  fs.writeFileSync(outputPath, `${JSON.stringify(users, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(users, null, 2)}\n`);
}

main();
