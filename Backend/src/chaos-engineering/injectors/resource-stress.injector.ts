import { Injectable, Logger } from '@nestjs/common';

import { ChaosExperimentRuntime, StressTarget } from '../chaos-engineering.types';

const MAX_CPU_WORKERS = 4;
const MAX_MEMORY_CHUNK_MB = 100;
const MAX_MEMORY_CHUNKS = 20;
const CPU_SPIN_DURATION_MS = 10;
const CPU_SPIN_INTERVAL_MS = 100;

@Injectable()
export class ResourceStressInjector {
  private readonly logger = new Logger(ResourceStressInjector.name);

  private readonly active = new Map<
    string,
    { cpuIntervals: ReturnType<typeof setInterval>[]; memoryChunks: Buffer[] }
  >();

  start(runtime: ChaosExperimentRuntime): void {
    const cpuIntervals: ReturnType<typeof setInterval>[] = [];
    const memoryChunks: Buffer[] = [];
    const target = runtime.stressTarget ?? StressTarget.BOTH;

    if (target === StressTarget.CPU || target === StressTarget.BOTH) {
      const workers = Math.min(runtime.cpuWorkers ?? 1, MAX_CPU_WORKERS);
      for (let i = 0; i < workers; i++) {
        const interval = setInterval(() => {
          const end = Date.now() + CPU_SPIN_DURATION_MS;
          // Intentional busy-wait to simulate CPU pressure
          while (Date.now() < end) {
            /* spin */
          }
        }, CPU_SPIN_INTERVAL_MS);
        cpuIntervals.push(interval);
      }
      this.logger.warn(`Resource stress: started ${workers} CPU worker(s) for experiment ${runtime.id}`);
    }

    if (target === StressTarget.MEMORY || target === StressTarget.BOTH) {
      const chunkMb = Math.min(runtime.memoryChunkMb ?? 10, MAX_MEMORY_CHUNK_MB);
      const chunks = Math.min(runtime.memoryChunks ?? 5, MAX_MEMORY_CHUNKS);
      for (let i = 0; i < chunks; i++) {
        memoryChunks.push(Buffer.alloc(chunkMb * 1024 * 1024));
      }
      this.logger.warn(
        `Resource stress: allocated ${chunks * chunkMb}MB across ${chunks} chunk(s) for experiment ${runtime.id}`,
      );
    }

    this.active.set(runtime.id, { cpuIntervals, memoryChunks });
    this.logger.warn(`Resource stress injector started: ${runtime.id} target=${target}`);
  }

  stop(runtime: ChaosExperimentRuntime): void {
    const entry = this.active.get(runtime.id);
    if (!entry) return;

    for (const interval of entry.cpuIntervals) {
      clearInterval(interval);
    }

    // Drop buffer references so GC can reclaim the memory
    entry.memoryChunks.length = 0;

    this.active.delete(runtime.id);
    this.logger.log(`Resource stress injector stopped and cleaned up: ${runtime.id}`);
  }
}
