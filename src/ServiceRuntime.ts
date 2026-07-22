export async function runCoupledService(
  controller: AbortController,
  dispatcher: Promise<void>,
  viewer: Promise<void>,
  shutdownGraceMs = 1_000,
): Promise<void> {
  try {
    await Promise.all([dispatcher, viewer]);
  } catch (error) {
    controller.abort(error);
    const clean = await settleWithin(Promise.allSettled([dispatcher, viewer]), shutdownGraceMs);
    if (!clean) log("service_coupled_shutdown_timeout", { shutdownGraceMs });
    throw error;
  }
}

async function settleWithin(running: Promise<unknown>, milliseconds: number): Promise<boolean> {
  return Promise.race([
    running.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), milliseconds)),
  ]);
}

import { log } from "./Logger.ts";
