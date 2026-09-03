import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

// Makes local dev idempotent, instead of the same breakage being
// rediscovered every phase.
//
// Stopping a dev session on Windows does not reliably kill its descendants:
// `concurrently`, both `pnpm -F` wrappers, vite and `node --watch` all leak.
// `node --watch` is the damaging one — it does not exit when the watched
// script throws, it prints the error and waits for a file change. So a
// crashed api dev server stays resident and re-races for the API port on the
// next save, while a leaked vite still owns 5173 and pushes the real one to
// 5174 — off the single origin PUBLIC_ORIGIN and the CORS allowlist accept.
// The browser symptom is a CORS/NetworkError wall that points nowhere near
// any of this. A stale `api` container does the same thing to :3001.
//
// So every entry point sweeps this repo's own leftovers first, then leaves
// docker holding nothing but the db. `pnpm dev` can be run straight over a
// broken session with no manual cleanup.

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const IS_WINDOWS = process.platform === "win32";

// Pinned in apps/web/vite.config.js (with strictPort, so it fails loudly
// rather than drifting off the origin CORS accepts).
const WEB_PORT = 5173;
// The same PORT the compose file and apps/api/src/env.js read — taken from
// .env rather than kept as a second hardcoded copy that can drift.
const API_PORT = readApiPort();
// Published only by infra/docker-compose.dev.yml, and only for host-side
// tooling. The api reaches the db over this port in dev; in compose it uses
// the `db` hostname instead.
const DB_PORT = 5432;

// Docker Desktop from cold is slow — well past a minute on a laptop that has
// just booted. Postgres, once the engine is up, is quick.
const ENGINE_TIMEOUT_MS = 120_000;
const DB_TIMEOUT_MS = 45_000;

const COMPOSE = ["compose", "--env-file", ".env", "-f", "infra/docker-compose.yml"];
const COMPOSE_DEV = [...COMPOSE, "-f", "infra/docker-compose.dev.yml"];

// Command-line fragments that mark a process as this repo's dev server.
// `node --watch src/index.js` on its own is too generic to kill safely, which
// is why apps/api's dev script tags itself with a marker arg — everything
// after the entry script is script argv, so node ignores it.
const OURS = [REPO_ROOT.replace(/\\/g, "/").toLowerCase(), "@budget/", "--budget-dev"];

const API_CMD = "pnpm -F @budget/api dev";
const WEB_CMD = "pnpm -F @budget/web dev";

function readApiPort() {
  try {
    const raw = readFileSync(new URL("../.env", import.meta.url), "utf8");
    const match = raw.match(/^\s*PORT\s*=\s*(\d+)/m);
    if (match?.[1]) return Number(match[1]);
  } catch {
    // No .env yet — fall through to the default apps/api/src/env.js uses.
  }
  return 3001;
}

/** @returns {{ pid: number, ppid: number, cmd: string }[]} */
function listNodeProcesses() {
  if (IS_WINDOWS) {
    // CIM is the only listing carrying both the command line and the parent
    // pid; tasklist carries neither.
    const query =
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      "Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
    const res = spawnSync("powershell.exe", ["-NoProfile", "-Command", query], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const raw = (res.stdout ?? "").trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows.map((r) => ({
        pid: Number(r.ProcessId),
        ppid: Number(r.ParentProcessId),
        cmd: String(r.CommandLine ?? ""),
      }));
    } catch {
      return [];
    }
  }
  const res = spawnSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" });
  return (res.stdout ?? "")
    .split("\n")
    .flatMap((line) => {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      return m?.[1] && m[2] ? [{ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] ?? "" }] : [];
    })
    .filter((p) => p.cmd.includes("node"));
}

/** @param {string} cmd */
function isOurs(cmd) {
  const normalised = cmd.replace(/\\/g, "/").toLowerCase();
  return OURS.some((marker) => normalised.includes(marker));
}

// pnpm may well invoke this script by absolute path, which matches OURS — so
// our own chain has to be excluded before anything gets killed.
/** @param {{ pid: number, ppid: number, cmd: string }[]} procs */
function ownChain(procs) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const chain = new Set([process.pid]);
  let current = byPid.get(process.pid);
  while (current && !chain.has(current.ppid)) {
    chain.add(current.ppid);
    current = byPid.get(current.ppid);
  }
  return chain;
}

function findLeftovers() {
  const procs = listNodeProcesses();
  const mine = ownChain(procs);
  return procs.filter((p) => !mine.has(p.pid) && isOurs(p.cmd));
}

/**
 * @param {number} port
 * @returns {number | null}
 */
function portHolder(port) {
  if (IS_WINDOWS) {
    const out = spawnSync("netstat", ["-ano"], { encoding: "utf8" }).stdout ?? "";
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
      if (m?.[1] && m[2] && Number(m[1]) === port) return Number(m[2]);
    }
    return null;
  }
  const out =
    spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout ?? "";
  const pid = Number((out.trim().split(/\r?\n/)[0] ?? "").trim());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/**
 * Name of any process, node or not — used only to explain a blocked port.
 * @param {number} pid
 * @returns {string}
 */
function processName(pid) {
  if (IS_WINDOWS) {
    const res = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ` +
          "ForEach-Object { if ($_.CommandLine) { $_.CommandLine } else { $_.Name } }",
      ],
      { encoding: "utf8" },
    );
    return short((res.stdout ?? "").trim());
  }
  const res = spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" });
  return short((res.stdout ?? "").trim());
}

/** @param {number} pid */
function killTree(pid) {
  if (IS_WINDOWS) {
    // /T because the leak is a tree — killing only the head reparents the
    // rest and leaves the port held.
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** @param {number} ms */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @param {number} port
 * @returns {number | null} pid still holding it, if any
 */
function waitForFree(port) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    if (portHolder(port) === null) return null;
    sleepSync(200);
  }
  return portHolder(port);
}

/** @param {string} cmd */
function short(cmd) {
  const flat = cmd.replace(/\s+/g, " ").trim();
  return flat.length > 88 ? `${flat.slice(0, 88)}…` : flat;
}

/** @param {string} message */
function log(message) {
  console.log(`dev: ${message}`);
}

function sweepProcesses() {
  const leftovers = findLeftovers();
  for (const p of leftovers) {
    log(`killing leftover pid ${p.pid} — ${short(p.cmd)}`);
    killTree(p.pid);
  }
  return leftovers.length;
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Can we talk to the docker daemon at all? */
function engineReachable() {
  const res = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    stdio: "ignore",
  });
  return res.status === 0;
}

// Docker Desktop is not on PATH and is not where its own docs say it is:
// on this machine the installer put it under LOCALAPPDATA, not Program
// Files. Check both rather than assuming either.
/** @returns {string | null} */
function dockerDesktopExe() {
  /** @type {string[]} */
  const candidates = [];
  if (IS_WINDOWS) {
    const local = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles;
    if (local) candidates.push(`${local}\\Programs\\DockerDesktop\\Docker Desktop.exe`);
    if (programFiles) candidates.push(`${programFiles}\\Docker\\Docker\\Docker Desktop.exe`);
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Docker.app");
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Starts Docker Desktop and waits for the daemon to answer. The engine takes
 * upwards of half a minute from cold, which is why this waits rather than
 * starting it and hoping.
 * @returns {Promise<boolean>}
 */
async function startEngine() {
  const exe = dockerDesktopExe();

  // `docker desktop start` is the supported way in and works on every
  // platform, but it is a CLI plugin — an older Docker Desktop, or a plain
  // docker CLI, does not have it. Launching the app directly is the fallback,
  // and on this machine the installer put it under LOCALAPPDATA rather than
  // Program Files, which is why dockerDesktopExe() checks both.
  log("docker is not running — starting Docker Desktop");
  const viaCli = spawnSync("docker", ["desktop", "start"], {
    stdio: "ignore",
    timeout: ENGINE_TIMEOUT_MS,
  });
  if (viaCli.status !== 0) {
    if (!exe) return false;
    if (process.platform === "darwin") {
      spawnSync("open", ["-a", exe], { stdio: "ignore" });
    } else {
      // Detached: Docker Desktop outlives this script, and a child handle
      // would otherwise keep `pnpm dev` from ever exiting cleanly.
      spawn(exe, { detached: true, stdio: "ignore" }).unref();
    }
  }

  for (let waited = 0; waited < ENGINE_TIMEOUT_MS; waited += 2000) {
    if (engineReachable()) {
      log("docker engine ready");
      return true;
    }
    await sleep(2000);
  }
  return false;
}

/**
 * A TCP connect to the *published* port, which is the thing host-side code
 * actually depends on. Compose's own healthcheck runs `pg_isready` inside
 * the container, so it passes even when the port publish is missing — which
 * is exactly the failure `docker compose up` without the dev overlay
 * produces. Checking from out here is the only check that proves the path
 * the api will use.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function tcpReachable(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const settle = (/** @type {boolean} */ ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

/** @returns {Promise<boolean>} */
async function waitForDb() {
  for (let waited = 0; waited < DB_TIMEOUT_MS; waited += 500) {
    if (await tcpReachable(DB_PORT)) return true;
    await sleep(500);
  }
  return false;
}

/** @returns {string[] | null} running service names, or null if docker is unreachable */
function runningServices() {
  const res = spawnSync("docker", [...COMPOSE, "ps", "--services", "--status", "running"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (res.status !== 0) return null;
  return (res.stdout ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// `stop` unconditionally, not only for the services `ps` reports running.
// It is a no-op for a service that is already down, and it is what makes the
// fix stick: `restart: unless-stopped` means Docker Desktop revives whatever
// it finds left running the next time it starts, so a container that merely
// is not running *right now* is not safe — it is armed. Only an explicit
// `stop` clears that flag, and it survives the daemon restart.
//
// That distinction is the whole bug. Docker Desktop's autostart races
// `pnpm dev`: it brings `api` up seconds after login, which can land *after*
// verifyPorts has already found the API port free. Node binds first and
// reports "API listening", then the container's port publish lands on the
// same host port — Docker's forwarder does not refuse an already-bound host
// port the way libuv does, so both own it, requests land on whichever
// accepts, and the next `node --watch` restart dies with EADDRINUSE.
/** @param {string[]} services */
function stopConflicting(services) {
  const res = spawnSync("docker", [...COMPOSE, "stop", "api", "web"], {
    cwd: REPO_ROOT,
    stdio: "ignore",
  });
  if (res.status !== 0) return [];
  // Report only what was actually up, so a clean start stays quiet.
  return ["api", "web"].filter((s) => services.includes(s));
}

// Only the db belongs in docker during local dev — see the comment in
// infra/docker-compose.dev.yml. A running `api` container holds the API port,
// and an `api` image is only ever as fresh as its last --build, so leaving it
// up means editing code that nothing is serving.
/**
 * Brings the db up and proves it is actually reachable, or explains why not.
 *
 * This used to log "docker unreachable — skipping db" and carry on starting
 * the api and web anyway. That is the bug behind every "I start the app and
 * get a wall of CORS errors" report: with the daemon off, `pnpm dev` came up
 * looking healthy, every request 500'd or failed to connect, and the single
 * grey line saying why had already scrolled past under vite's banner. A dev
 * stack with no database is not a degraded dev stack, it is a broken one, so
 * this now starts the engine itself and refuses to continue without it.
 *
 * @returns {Promise<{ ok: true } | { ok: false, reason: string, hint: string }>}
 */
async function prepareDocker() {
  if (!engineReachable() && !(await startEngine())) {
    return dockerDesktopExe()
      ? {
          ok: false,
          reason: `Docker Desktop did not come up within ${ENGINE_TIMEOUT_MS / 1000}s.`,
          hint: "Start it by hand, wait for the whale icon to settle, then retry.",
        }
      : {
          ok: false,
          reason: "Docker is not running and Docker Desktop was not found.",
          hint: "Install Docker Desktop, or start your docker daemon, then retry.",
        };
  }

  const services = runningServices();
  if (services === null) {
    return {
      ok: false,
      reason: "The docker daemon answered, but `docker compose ps` failed.",
      hint: "Run `pnpm docker:db config` to see what compose is unhappy about.",
    };
  }

  const stopped = stopConflicting(services);
  if (stopped.length > 0) {
    log(`stopped container(s) ${stopped.join(", ")} — stale builds, and they hold :${API_PORT}`);
  }

  // Unconditionally, even when db already appears to be running: a `docker
  // compose up` that used the base file alone leaves db up but with 5432
  // unpublished, and host-side tooling (this dev server, pnpm db:migrate)
  // reaches it over localhost. Compose is declarative, so this is a no-op
  // when the container already matches — and a recreate when it doesn't.
  if (!services.includes("db")) log("starting db");
  // --wait blocks on the healthcheck in infra/docker-compose.yml, so this
  // returns when Postgres is accepting connections rather than when the
  // container has merely been created. Without it the api wins the race on a
  // cold volume and its first queries fail.
  const up = spawnSync(
    "docker",
    [...COMPOSE_DEV, "up", "-d", "--wait", "--wait-timeout", String(DB_TIMEOUT_MS / 1000), "db"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  if (up.status !== 0) {
    return {
      ok: false,
      reason: `The db container did not become healthy (${short(up.stderr ?? "")}).`,
      hint: "`pnpm docker:db logs db` has the reason.",
    };
  }

  if (!(await waitForDb())) {
    return {
      ok: false,
      reason: `Postgres is not answering on localhost:${DB_PORT}.`,
      hint: "The container is healthy, so this is the port publish — `pnpm docker:db up -d db` re-applies it.",
    };
  }

  log(`db ready on :${DB_PORT}`);

  // The deployed stack already refuses to run code against a schema older
  // than itself: compose's one-shot `migrate` service applies migrations and
  // `api` waits for it to exit 0 (see infra/docker-compose.yml). Local dev
  // had no equivalent, so pulling a branch that adds a column produced an api
  // that started cleanly and then 500'd every request with a Postgres
  // "column ... does not exist" buried in a Drizzle stack trace. Same failure
  // class as a missing database, so it gets the same treatment here rather
  // than relying on remembering to run `pnpm db:migrate`.
  const migrated = runMigrations();
  if (migrated !== null) {
    return {
      ok: false,
      reason: `Migrations failed to apply: ${migrated}`,
      hint: "Run `pnpm db:migrate` to see the whole error.",
    };
  }

  return { ok: true };
}

/**
 * drizzle-kit only applies what is pending, so this is a fast no-op on an
 * up-to-date database and needs no separate "is anything pending" probe.
 * @returns {string | null} an error summary, or null on success
 */
function runMigrations() {
  const res = spawnSync("pnpm db:migrate", {
    cwd: REPO_ROOT,
    shell: true,
    encoding: "utf8",
  });
  if (res.status === 0) {
    log("migrations up to date");
    return null;
  }
  return short(`${res.stdout ?? ""} ${res.stderr ?? ""}`);
}

/** @param {number[]} ports */
function verifyPorts(ports) {
  /** @type {{ port: number, pid: number }[]} */
  const blocked = [];
  for (const port of ports) {
    const holder = waitForFree(port);
    if (holder !== null) blocked.push({ port, pid: holder });
  }
  return blocked;
}

/** @param {string} command */
function run(command) {
  const child = spawn(command, { shell: true, stdio: "inherit", cwd: REPO_ROOT });
  child.on("exit", (code) => process.exit(code ?? 0));
}

async function status() {
  const procs = listNodeProcesses();
  const mine = ownChain(procs);
  const ours = procs.filter((p) => !mine.has(p.pid) && isOurs(p.cmd));

  console.log("ports");
  /** @type {[string, number][]} */
  const watched = [
    ["api", API_PORT],
    ["web", WEB_PORT],
    ["db", DB_PORT],
  ];
  for (const [label, port] of watched) {
    const holder = portHolder(port);
    console.log(`  :${port} ${label.padEnd(4)} ${holder === null ? "free" : `held by pid ${holder}`}`);
  }

  // A held port only proves something is bound to it. The db is the one that
  // has repeatedly been bound-but-useless, so probe it for real.
  const dbUp = await tcpReachable(DB_PORT);
  console.log(`\ndatabase\n  localhost:${DB_PORT} ${dbUp ? "accepting connections" : "NOT reachable"}`);

  const services = runningServices();
  console.log("\ndocker");
  if (services === null) {
    console.log("  unreachable — Docker Desktop is not running");
  } else if (services.length === 0) {
    console.log("  nothing running");
  } else {
    for (const s of services) {
      console.log(`  ${s} running${s === "db" ? "" : "   <- conflicts with pnpm dev"}`);
    }
  }

  console.log("\nthis repo's dev processes");
  if (ours.length === 0) {
    console.log("  none");
  } else {
    for (const p of ours) console.log(`  pid ${p.pid} — ${short(p.cmd)}`);
    console.log("\n  `pnpm stop` clears these; `pnpm dev` clears them and starts fresh.");
  }
}

const mode = process.argv[2] ?? "up";

if (mode === "status") {
  await status();
} else if (mode === "stop") {
  const killed = sweepProcesses();
  const services = runningServices();
  const stopped = services === null ? [] : stopConflicting(services);
  if (stopped.length > 0) log(`stopped container(s) ${stopped.join(", ")}`);
  log(`cleared ${killed} dev process(es). db left up; \`pnpm docker:down\` takes down everything.`);
} else if (mode === "up" || mode === "api" || mode === "web") {
  const killed = sweepProcesses();
  if (killed > 0) log(`swept ${killed} leftover process(es)`);

  // `web` alone genuinely doesn't need a database, and --no-db is the escape
  // hatch for deliberately working on the frontend against a dead api. Every
  // other path treats the db as a hard precondition.
  const skipDb = mode === "web" || process.argv.includes("--no-db");
  if (skipDb) {
    log("skipping the db check");
    // Still clear the containers that publish :${API_PORT} — skipping the
    // database is not a reason to walk into a port conflict. Silent when the
    // daemon is off, which is the likely reason we are on this path at all.
    const services = runningServices();
    if (services !== null) {
      const stopped = stopConflicting(services);
      if (stopped.length > 0) log(`stopped container(s) ${stopped.join(", ")}`);
    }
  } else {
    const db = await prepareDocker();
    if (!db.ok) {
      console.error(`\ndev: cannot start — ${db.reason}`);
      console.error(`dev: ${db.hint}`);
      // Exit rather than start. A dev stack without a database looks like it
      // works right up until the browser, where the symptom (CORS errors,
      // NetworkError, a blank page) names nothing that leads back to here.
      console.error("dev: `pnpm dev --no-db` starts anyway if that is what you want.\n");
      process.exit(1);
    }
  }

  const ports = mode === "api" ? [API_PORT] : mode === "web" ? [WEB_PORT] : [API_PORT, WEB_PORT];
  const blocked = verifyPorts(ports);
  if (blocked.length > 0) {
    const procs = listNodeProcesses();
    let anyDocker = false;
    for (const { port, pid } of blocked) {
      // listNodeProcesses only covers node.exe, so fall back to a name lookup
      // — the usual non-node holder is docker, and a bare pid with no name
      // gives the reader nowhere to go.
      const proc = procs.find((p) => p.pid === pid);
      const label = proc ? short(proc.cmd) : processName(pid);
      if (label && /docker|vpnkit|com\.docker/i.test(label)) anyDocker = true;
      console.error(`dev: :${port} is held by pid ${pid}${label ? ` — ${label}` : ""}`);
    }
    if (anyDocker) {
      // Not a leaked process, so the sweep cannot help: the port belongs to a
      // container's publish, and only stopping the container releases it.
      console.error("dev: that is docker publishing a container port, not a leaked process.");
      console.error("dev: `pnpm stop` stops those containers (and leaves db up), then retry.");
    } else {
      console.error("dev: not one of ours, so nothing was touched. Free the port and retry.");
    }
    process.exit(1);
  }

  if (mode === "api") {
    run(API_CMD);
  } else if (mode === "web") {
    run(WEB_CMD);
  } else {
    // --kill-others-on-fail: if the api dies the web must die with it. A
    // half-up dev session is what makes this look like a CORS bug.
    run(`pnpm exec concurrently -n api,web -c blue,green --kill-others-on-fail "${API_CMD}" "${WEB_CMD}"`);
  }
} else {
  console.error(`Unknown mode "${mode}". Expected: up | api | web | stop | status`);
  process.exit(1);
}
