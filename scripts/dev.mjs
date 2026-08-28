import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
function prepareDocker() {
  const services = runningServices();
  if (services === null) {
    log("docker unreachable — skipping db (the api will report db:false)");
    // Unreachable is ambiguous: docker may be off, or it may be *starting*,
    // which is the one case that bites. A daemon mid-boot cannot be asked to
    // stop anything yet, but it is about to autostart every `unless-stopped`
    // container — including `api` on :${API_PORT}. That lands after the port
    // check below has already passed, so warn rather than imply all-clear.
    log(`if docker is still starting, its api container may take :${API_PORT} — \`pnpm stop\` then retry`);
    return;
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
  spawnSync("docker", [...COMPOSE_DEV, "up", "-d", "db"], { cwd: REPO_ROOT, stdio: "ignore" });
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

function status() {
  const procs = listNodeProcesses();
  const mine = ownChain(procs);
  const ours = procs.filter((p) => !mine.has(p.pid) && isOurs(p.cmd));

  console.log("ports");
  /** @type {[string, number][]} */
  const watched = [
    ["api", API_PORT],
    ["web", WEB_PORT],
    ["db", 5432],
  ];
  for (const [label, port] of watched) {
    const holder = portHolder(port);
    console.log(`  :${port} ${label.padEnd(4)} ${holder === null ? "free" : `held by pid ${holder}`}`);
  }

  const services = runningServices();
  console.log("\ndocker");
  if (services === null) {
    console.log("  unreachable");
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
  status();
} else if (mode === "stop") {
  const killed = sweepProcesses();
  const services = runningServices();
  const stopped = services === null ? [] : stopConflicting(services);
  if (stopped.length > 0) log(`stopped container(s) ${stopped.join(", ")}`);
  log(`cleared ${killed} dev process(es). db left up; \`pnpm docker:down\` takes down everything.`);
} else if (mode === "up" || mode === "api" || mode === "web") {
  const killed = sweepProcesses();
  if (killed > 0) log(`swept ${killed} leftover process(es)`);
  prepareDocker();

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
