export class ConveyorService {
  private readonly ownerId = randomUUID();
  private readonly store: ConveyorStore;
  private readonly runner: ConveyorRunner;
  private readonly pollMs: number;
  private readonly leaseMs: number;

  constructor(
    store: ConveyorStore,
    runner: ConveyorRunner,
    pollMs = 1_000,
    leaseMs = 15_000,
  ) {
    this.store = store;
    this.runner = runner;
    this.pollMs = pollMs;
    this.leaseMs = leaseMs;
  }

  async run(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.acquireDispatcher();
    try {
      const recovered = this.store.recoverInterruptedReceipts();
      log("service_started", { ownerId: this.ownerId, recovered });
      await this.listen(signal);
    } finally {
      this.store.releaseLease(this.ownerId);
      log("service_stopped", { ownerId: this.ownerId });
    }
  }

  async runOnce(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    this.acquireDispatcher();
    try {
      this.store.recoverInterruptedReceipts();
      return await this.executeOnce(signal);
    } finally {
      this.store.releaseLease(this.ownerId);
    }
  }

  private acquireDispatcher(): void {
    if (!this.store.acquireLease(this.ownerId, this.leaseMs)) {
      throw new Error("Another axi-factorio dispatcher owns the active lease.");
    }
  }

  private async listen(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      this.requireLease();
      if (await this.executeOnce(signal, true)) continue;
      await delay(this.pollMs, signal);
    }
  }

  private async executeOnce(signal: AbortSignal, continueOnFailure = false): Promise<boolean> {
    signal.throwIfAborted();
    const controller = linkedController(signal);
    const heartbeat = setInterval(() => this.heartbeat(controller), this.heartbeatMs());
    try {
      return await this.runner.runOnce(controller.signal, this.ownerId);
    } catch (error) {
      if (!continueOnFailure || !(error instanceof ReceiptRunError)) throw error;
      log("service_receipt_failure_handled", {
        ownerId: this.ownerId, receiptId: error.receiptId, error: error.message,
      });
      return true;
    } finally {
      clearInterval(heartbeat);
      controller.dispose();
      this.requireLease();
    }
  }

  private heartbeat(controller: LinkedController): void {
    try {
      if (this.store.renewLease(this.ownerId, this.leaseMs)) return;
    } catch (error) {
      log("service_heartbeat_failed", { ownerId: this.ownerId, error: errorMessage(error) });
    }
    controller.abort();
  }

  private heartbeatMs(): number {
    return Math.max(1, Math.floor(this.leaseMs / 3));
  }

  private requireLease(): void {
    if (!this.store.renewLease(this.ownerId, this.leaseMs)) {
      throw new Error("The axi-factorio dispatcher lease was lost.");
    }
  }
}

function linkedController(signal: AbortSignal): LinkedController {
  const controller = new AbortController() as LinkedController;
  const stop = () => controller.abort(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  controller.dispose = () => signal.removeEventListener("abort", stop);
  if (signal.aborted) controller.abort(signal.reason);
  return controller;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type LinkedController = AbortController & { dispose: () => void };

import type { ConveyorStore } from "./Store.ts";
import type { ConveyorRunner } from "./Runner.ts";
import { ReceiptRunError } from "./Runner.ts";
import { log } from "./Logger.ts";
import { randomUUID } from "node:crypto";
