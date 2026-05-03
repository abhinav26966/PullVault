import 'server-only';

/**
 * Stub for the Redis Pub/Sub publish call. Phase 6 swaps this for a real
 * ioredis publisher. The stub exists so Phase 5's transaction code already
 * uses the eventual `publish(channel, payload)` API without conditional
 * branching — Phase 6 just replaces the implementation.
 *
 * IMPORTANT: never call publish() before the transaction commits. If the
 * commit rolls back, you've broadcast a phantom event. ARCHITECTURE §6.1.
 */
export async function publish(channel: string, payload: unknown): Promise<void> {
  console.info(`[publish stub] ${channel}`, payload);
}
