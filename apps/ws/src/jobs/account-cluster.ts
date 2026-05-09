import { isNotNull } from 'drizzle-orm';
import cron, { type ScheduledTask } from 'node-cron';
import { accountClusters, db, users } from '@pullvault/db';

/**
 * Account-cluster daily cron — Part B §10.
 *
 * Groups users sharing signup_ip whose signups landed within a 5-minute
 * window. Each cluster is appended to account_clusters; the B5 fraud tab
 * surfaces the recent ones.
 *
 * Detection only — never auto-blocks. Daily cadence; same cluster can be
 * re-emitted on subsequent runs (de-duplication is a B5 polish concern).
 */

const CLUSTER_WINDOW_MS = 5 * 60_000;

async function runOnce(): Promise<void> {
  const all = await db
    .select({
      id: users.id,
      signupIp: users.signupIp,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(isNotNull(users.signupIp));

  // Bucket by signup_ip.
  const byIp = new Map<string, { id: string; createdAt: Date }[]>();
  for (const u of all) {
    if (!u.signupIp) continue;
    let arr = byIp.get(u.signupIp);
    if (!arr) {
      arr = [];
      byIp.set(u.signupIp, arr);
    }
    arr.push({ id: u.id, createdAt: u.createdAt });
  }

  let written = 0;
  for (const [ip, members] of byIp.entries()) {
    if (members.length < 2) continue;
    members.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    // Sliding-window cluster detection: split where the gap exceeds the window.
    let clusterStart = 0;
    for (let i = 1; i < members.length; i++) {
      const prev = members[i - 1]!;
      const cur = members[i]!;
      if (cur.createdAt.getTime() - prev.createdAt.getTime() > CLUSTER_WINDOW_MS) {
        const cluster = members.slice(clusterStart, i);
        if (cluster.length >= 2) {
          await writeCluster(ip, cluster);
          written++;
        }
        clusterStart = i;
      }
    }
    const final = members.slice(clusterStart);
    if (final.length >= 2) {
      await writeCluster(ip, final);
      written++;
    }
  }
  console.log(`[account-cluster] wrote ${written} cluster(s)`);
}

async function writeCluster(
  ip: string,
  cluster: { id: string; createdAt: Date }[],
): Promise<void> {
  const userIds = cluster.map((c) => c.id);
  const firstSignup = cluster[0]!.createdAt.toISOString();
  const lastSignup = cluster[cluster.length - 1]!.createdAt.toISOString();
  await db.insert(accountClusters).values({
    reason: 'shared signup_ip + 5min signup window',
    userIds,
    signalData: {
      ip,
      signupCount: userIds.length,
      firstSignup,
      lastSignup,
      windowMs: CLUSTER_WINDOW_MS,
    },
  });
}

export function scheduleAccountCluster(): ScheduledTask {
  // Daily at 03:00 UTC (off-peak; doesn't compete with active drops).
  return cron.schedule('0 3 * * *', async () => {
    try {
      await runOnce();
    } catch (err) {
      console.error('[account-cluster] tick failed', err);
    }
  });
}

export async function runAccountClusterNow(): Promise<void> {
  await runOnce();
}
