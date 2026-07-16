import { and, count, eq, isNull } from "drizzle-orm";
import type { db } from "./db";
import { alerts, channels, searches, users } from "./schema";
import { SINGLE_USER_EMAIL, authMode } from "./authmode";
import { log } from "./log";

const clog = log.child({ component: "claim" });

// Every row predating multi-user has user_id NULL, and the poller skips null-owner
// searches, so without this an upgraded deployment would silently stop polling. Run at
// boot, after migrations.
//
// It is also what makes single mode work at all: the implicit local@localhost user is a
// real users row, so the poller and every route resolve an owner the same way in all
// three auth modes. There is no "no user" branch anywhere.
export async function claimLegacyRows(database: ReturnType<typeof db>): Promise<void> {
  const mode = authMode();
  const email = mode === "single" ? SINGLE_USER_EMAIL : process.env.LEGACY_OWNER_EMAIL?.trim().toLowerCase();
  if (!email) {
    // Having no LEGACY_OWNER_EMAIL is the steady state, not a problem: it is set for one boot
    // during an upgrade and removed after. Warn only when rows are genuinely stranded -
    // unconditionally would cry wolf on every boot of every multi-user deployment, telling an
    // owner whose searches are polling perfectly well that they aren't.
    const [stranded] = await database.select({ n: count() }).from(searches).where(isNull(searches.userId));
    if (stranded?.n) {
      clog.warn({ searches: stranded.n }, "unowned searches and no LEGACY_OWNER_EMAIL - they will not poll");
    }
    return;
  }

  // sub stays null: auth.ts stamps the real one on first login (single mode has no IdP,
  // so it stays null forever).
  await database.insert(users).values({ email }).onConflictDoNothing({ target: users.email });
  const [owner] = await database.select({ id: users.id }).from(users).where(eq(users.email, email));

  const claimed = {
    searches: (await database.update(searches).set({ userId: owner.id }).where(isNull(searches.userId))).count,
    channels: (await database.update(channels).set({ userId: owner.id }).where(isNull(channels.userId))).count,
    alerts: (await database.update(alerts).set({ userId: owner.id }).where(isNull(alerts.userId))).count,
  };

  const adopted = Boolean(claimed.searches || claimed.channels || claimed.alerts);
  // Quiet on a normal boot: after the first claim there is nothing left to adopt.
  if (adopted) clog.info({ ...claimed, email }, "claimed legacy rows");

  // A deployment upgrading from single mode may have no channels rows at all, with every
  // notification coming from DISCORD_WEBHOOK_URL. Multi-user reload ignores that var (one
  // global webhook would fan every user's alerts into one channel), so without this import
  // the owner's alerts would keep being found and silently never delivered. Single mode is
  // excluded deliberately: reload appends the env var in-memory there, so a row here would
  // make it two channels and post every alert twice.
  //
  // Gated on `adopted` so it can only fire on the upgrade boot itself. The URL match below
  // is not enough on its own: once the owner deletes that channel in the UI nothing matches,
  // and every later restart would resurrect it and resume posting to a channel they removed.
  const webhook = process.env.DISCORD_WEBHOOK_URL?.trim();
  if (adopted && mode !== "single" && webhook) {
    const [existing] = await database
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.userId, owner.id), eq(channels.webhookUrl, webhook)));
    if (!existing) {
      await database.insert(channels).values({ userId: owner.id, webhookUrl: webhook });
      clog.info({ email }, "imported DISCORD_WEBHOOK_URL as a channel - the env var can now be removed");
    }
  }
}
