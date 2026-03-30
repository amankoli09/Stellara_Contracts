import { Injectable, Logger } from '@nestjs/common';

import { ChaosExperimentRuntime } from '../chaos-engineering.types';

@Injectable()
export class LatencyInjector {
  private readonly logger = new Logger(LatencyInjector.name);

  private readonly active = new Map<string, { latencyMs: number; jitterMs: number }>();

  start(runtime: ChaosExperimentRuntime): void {
    this.active.set(runtime.id, {
      latencyMs: runtime.latencyMs ?? 500,
      jitterMs: runtime.latencyJitterMs ?? 0,
    });
    this.logger.warn(
      `Latency injector started: ${runtime.id} (+${runtime.latencyMs ?? 500}ms ±${runtime.latencyJitterMs ?? 0}ms)`,
    );
  }

  stop(runtime: ChaosExperimentRuntime): void {
    this.active.delete(runtime.id);
    this.logger.log(`Latency injector stopped: ${runtime.id}`);
  }

  async injectDelay(experimentId: string): Promise<void> {
    const config = this.active.get(experimentId);
    if (!config) return;

    const jitter =
      config.jitterMs > 0
        ? Math.floor(Math.random() * config.jitterMs * 2) - config.jitterMs
        : 0;
    const delay = Math.max(0, config.latencyMs + jitter);

    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
}
