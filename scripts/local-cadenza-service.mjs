#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);
const demoRoot = path.resolve(scriptDir, "..");
const workspaceRoot = path.resolve(demoRoot, "..");
const serviceRepo = path.join(workspaceRoot, "cadenza-service");
const localDependency = "file:vendor/cadenza-service-local.tgz";
const packageName = "@cadenza.io/service";

function run(cmd, args, cwd, options = {}) {
  const output = execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
  return typeof output === "string" ? output.trim() : "";
}

function walkPackageJsons(dir, results = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === ".idea" ||
      entry.name === ".output" ||
      entry.name === ".playwright-cli" ||
      entry.name === "output"
    ) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkPackageJsons(fullPath, results);
      continue;
    }

    if (entry.isFile() && entry.name === "package.json") {
      results.push(fullPath);
    }
  }

  return results;
}

function getTargetPackageDirs() {
  return walkPackageJsons(demoRoot)
    .map((packageJsonPath) => path.dirname(packageJsonPath))
    .filter((packageDir) => {
      const packageJson = JSON.parse(
        readFileSync(path.join(packageDir, "package.json"), "utf8"),
      );
      return (
        packageJson.dependencies?.[packageName] === localDependency ||
        packageJson.devDependencies?.[packageName] === localDependency
      );
    })
    .sort();
}

function getPublishedServicePackageDirs() {
  return walkPackageJsons(demoRoot)
    .map((packageJsonPath) => path.dirname(packageJsonPath))
    .filter((packageDir) => {
      const packageJson = JSON.parse(
        readFileSync(path.join(packageDir, "package.json"), "utf8"),
      );
      const dependency =
        packageJson.dependencies?.[packageName] ??
        packageJson.devDependencies?.[packageName];
      return dependency && dependency !== localDependency;
    })
    .sort();
}

function computeSha1(filePath) {
  return createHash("sha1").update(readFileSync(filePath)).digest("hex");
}

function computeIntegrity(filePath) {
  return `sha512-${createHash("sha512").update(readFileSync(filePath)).digest("base64")}`;
}

function getServiceTarballPath() {
  const packageJson = JSON.parse(
    readFileSync(path.join(serviceRepo, "package.json"), "utf8"),
  );
  return path.join(serviceRepo, `cadenza.io-service-${packageJson.version}.tgz`);
}

function ensureSourceTarballExists() {
  const tarballPath = getServiceTarballPath();
  if (!existsSync(tarballPath)) {
    throw new Error(
      `Missing source tarball ${tarballPath}. Run sync to build and pack it.`,
    );
  }
  return tarballPath;
}

function packSourceTarball() {
  const packOutput = run("npm", ["pack", "--silent"], serviceRepo);
  const packedName = packOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".tgz"))
    .at(-1);

  if (!packedName) {
    throw new Error(`npm pack did not produce a tarball name:\n${packOutput}`);
  }

  const tarballPath = path.join(serviceRepo, packedName);
  if (!existsSync(tarballPath)) {
    throw new Error(`npm pack reported ${packedName}, but ${tarballPath} does not exist.`);
  }
  return tarballPath;
}

function refreshTargetLockfile(packageDir) {
  run(
    "npm",
    ["install", "--package-lock-only", `${packageName}@${localDependency}`],
    packageDir,
  );
}

function refreshInstalledDependencies(packageDir) {
  if (!existsSync(path.join(packageDir, "node_modules"))) {
    return;
  }

  run("npm", ["ci", "--ignore-scripts"], packageDir, { stdio: "inherit" });
}

function sync() {
  const tarballPath = packSourceTarball();
  const targets = getTargetPackageDirs();

  for (const packageDir of targets) {
    const vendorDir = path.join(packageDir, "vendor");
    mkdirSync(vendorDir, { recursive: true });
    copyFileSync(tarballPath, path.join(vendorDir, "cadenza-service-local.tgz"));
    refreshTargetLockfile(packageDir);
    refreshInstalledDependencies(packageDir);
  }

  verify(tarballPath);
}

function verify(sourceTarballPath = ensureSourceTarballExists()) {
  const sourceSha1 = computeSha1(sourceTarballPath);
  const sourceIntegrity = computeIntegrity(sourceTarballPath);
  const failures = [];
  const targets = getTargetPackageDirs();
  const publishedPackages = getPublishedServicePackageDirs();

  for (const packageDir of targets) {
    const vendorTarball = path.join(packageDir, "vendor", "cadenza-service-local.tgz");
    const lockfilePath = path.join(packageDir, "package-lock.json");

    if (!existsSync(vendorTarball)) {
      failures.push(`${packageDir}: missing vendor/cadenza-service-local.tgz`);
      continue;
    }

    if (!existsSync(lockfilePath)) {
      failures.push(`${packageDir}: missing package-lock.json`);
      continue;
    }

    const vendorSha1 = computeSha1(vendorTarball);
    if (vendorSha1 !== sourceSha1) {
      failures.push(
        `${packageDir}: vendored tarball sha1 ${vendorSha1} does not match source ${sourceSha1}`,
      );
    }

    const lockfile = JSON.parse(readFileSync(lockfilePath, "utf8"));
    const lockPackage = lockfile.packages?.["node_modules/@cadenza.io/service"];
    if (!lockPackage) {
      failures.push(`${packageDir}: package-lock missing node_modules/@cadenza.io/service`);
      continue;
    }

    if (lockPackage.resolved !== localDependency) {
      failures.push(
        `${packageDir}: package-lock resolved ${lockPackage.resolved} instead of ${localDependency}`,
      );
    }

    if (lockPackage.integrity !== sourceIntegrity) {
      failures.push(
        `${packageDir}: package-lock integrity ${lockPackage.integrity} does not match source ${sourceIntegrity}`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(`Local @cadenza.io/service sync failed:\n- ${failures.join("\n- ")}`);
  }

  console.log("Local @cadenza.io/service sync is aligned.");
  console.log(`source_tarball=${sourceTarballPath}`);
  console.log(`sha1=${sourceSha1}`);
  console.log(`integrity=${sourceIntegrity}`);
  console.log(`targets=${targets.length > 0 ? targets.join(",") : "(none)"}`);
  if (publishedPackages.length > 0) {
    console.log(
      `published_service_packages=${publishedPackages.join(",")}`,
    );
  }
}

function rebuild(services) {
  if (services.length === 0) {
    throw new Error("Provide at least one docker compose service name for rebuild.");
  }

  sync();
  execFileSync("docker", ["compose", "build", "--no-cache", ...services], {
    cwd: demoRoot,
    stdio: "inherit",
  });
  execFileSync("docker", ["compose", "up", "-d", "--force-recreate", ...services], {
    cwd: demoRoot,
    stdio: "inherit",
  });
}

function main() {
  const [command = "verify", ...args] = process.argv.slice(2);

  if (!existsSync(serviceRepo) || !statSync(serviceRepo).isDirectory()) {
    throw new Error(`Expected sibling repo at ${serviceRepo}`);
  }

  if (command === "sync") {
    sync();
    return;
  }

  if (command === "verify") {
    verify();
    return;
  }

  if (command === "rebuild") {
    rebuild(args);
    return;
  }

  throw new Error(`Unknown command "${command}". Use sync, verify, or rebuild.`);
}

main();
