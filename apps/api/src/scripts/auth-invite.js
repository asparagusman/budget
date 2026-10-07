import { fileURLToPath } from "node:url";
import { mustAt } from "@budget/engine";
import { createDb, invites } from "@budget/schema";
import { config as loadDotenv } from "dotenv";
import { loadEnv } from "../env.js";
import { writeAuditLog } from "../lib/audit.js";
import { generateInviteCode, hashInviteCode } from "../lib/invite.js";

// Recovery path for losing every passkey: the operator has shell access to
// the box, so recovery is this CLI command rather than recovery codes to
// lose. See phases/03-auth.md "Recovery" and infra/README.md "Recovering
// when every passkey is gone".
//
// The production image has no pnpm and no src/ — tsup bundles this file as
// its own entry, so on the box it is:
//
//   docker compose -f infra/docker-compose.yml exec api node dist/scripts/auth-invite.js --user "Lachlan" --purpose new_device
//
// and in local dev, `pnpm auth:invite --user … --purpose …`.

loadDotenv({
  path: fileURLToPath(new URL("../../../../.env", import.meta.url)),
  quiet: true,
});

const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ user?: string, purpose?: string }} */
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--user") args.user = argv[i + 1];
    else if (argv[i] === "--purpose") args.purpose = argv[i + 1];
  }
  return args;
}

async function main() {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  const { user: userName, purpose } = parseArgs(process.argv.slice(2));

  if (purpose !== "new_user" && purpose !== "new_device") {
    console.error("Usage: auth-invite --user <displayName> --purpose <new_user|new_device>");
    process.exitCode = 1;
    return;
  }

  /** @type {string | null} */
  let targetUserId = null;
  if (purpose === "new_device") {
    if (!userName) {
      console.error("--user is required for --purpose new_device");
      process.exitCode = 1;
      return;
    }
    const target = await db.query.users.findFirst({
      where: (u, { eq }) => eq(u.displayName, userName),
    });
    if (!target) {
      console.error(`No user named "${userName}" found.`);
      process.exitCode = 1;
      return;
    }
    targetUserId = target.id;
  }

  const code = generateInviteCode();
  const created = await db
    .insert(invites)
    .values({
      codeHash: hashInviteCode(code),
      purpose,
      targetUserId,
      createdBy: null,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    })
    .returning();
  const invite = mustAt(created, 0, "created invite");

  await writeAuditLog(db, {
    actorId: null,
    action: "invite.create",
    entityType: "invite",
    entityId: invite.id,
    metadata: { purpose, source: "cli" },
  });

  console.log(`Invite created (${purpose}), expires ${invite.expiresAt.toISOString()}.`);
  console.log(`${env.PUBLIC_ORIGIN}/invite/${code}`);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
