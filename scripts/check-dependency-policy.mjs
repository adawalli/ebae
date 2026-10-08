import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

await (async () => {
  for (const path of process.argv.slice(2).length ? process.argv.slice(2) : ["package.json"]) {
    const { scripts } = JSON.parse(await readFile(path, "utf8"));
    const script = scripts["check:bun"];
    const installDirectory = await mkdtemp(join(tmpdir(), "unsupported-installer-"));
    try {
      await writeFile(
        join(installDirectory, "package.json"),
        JSON.stringify({
          scripts: {
            "check:bun": script.replace("Bun.version", JSON.stringify("1.2.14")),
            "install:deps": scripts["install:deps"],
            preinstall: "touch installer-started",
          },
        }),
      );
      await assert.rejects(exec("bun", ["run", "install:deps"], { cwd: installDirectory }), /dependency cooldown/);
      for (const filename of ["installer-started", "bun.lock"]) {
        await assert.rejects(readFile(join(installDirectory, filename)), { code: "ENOENT" });
      }
    } finally {
      await rm(installDirectory, { recursive: true, force: true });
    }
    // Run the actual hook with a controlled runtime version, without changing this process.
    for (const version of ["1.2.14", "1.3.0", "1.4.2"]) {
      const command = script.replace("Bun.version", JSON.stringify(version));
      if (version === "1.2.14") {
        await assert.rejects(exec("sh", ["-c", command]), /dependency cooldown/);
      } else {
        await exec("sh", ["-c", command]);
      }
    }
  }
})();

await (async () => {
  const directory = await mkdtemp(join(tmpdir(), "dependency-age-"));
  const direct = "age-check-direct";
  const transitive = "age-check-transitive";
  const old = new Date(Date.now() - 4 * 86400_000).toISOString();
  const fresh = new Date(Date.now() - 2 * 86400_000).toISOString();
  let registry = "";
  const server = createServer((request, response) => {
    const name = request.url?.slice(1);
    if (name !== direct && name !== transitive) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        name,
        "dist-tags": { latest: "1.0.1" },
        time: { "1.0.0": old, "1.0.1": fresh },
        versions: Object.fromEntries(
          ["1.0.0", "1.0.1"].map((version) => [
            version,
            {
              name,
              version,
              dependencies: name === direct ? { [transitive]: "^1.0.0" } : {},
              dist: {
                tarball: `${registry}/${name}-${version}.tgz`,
                shasum: "a".repeat(40),
              },
            },
          ]),
        ),
      }),
    );
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    registry = `http://127.0.0.1:${address.port}`;
    await writeFile(join(directory, "package.json"), JSON.stringify({ dependencies: { [direct]: "^1.0.0" } }));
    await copyFile("bunfig.toml", join(directory, "bunfig.toml"));
    await exec(
      "bun",
      [
        "install",
        "--lockfile-only",
        "--ignore-scripts",
        "--registry",
        registry,
        "--cache-dir",
        join(directory, "cache"),
      ],
      { cwd: directory, timeout: 20_000 },
    );
    const lockfile = await readFile(join(directory, "bun.lock"), "utf8");
    for (const name of [direct, transitive]) {
      assert.ok(lockfile.includes(`${name}@1.0.0`));
      assert.ok(!lockfile.includes(`${name}@1.0.1`));
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
})();

console.log("Dependency policy checks passed");
