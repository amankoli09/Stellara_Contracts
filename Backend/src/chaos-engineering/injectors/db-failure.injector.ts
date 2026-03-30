import { Injectable, Logger } from '@nestjs/common';

import { ChaosExperimentRuntime } from '../chaos-engineering.types';

@Injectable()
export class DbFailureInjector {
  private readonly logger = new Logger(DbFailureInjector.name);

  private readonly active = new Map<string, { failureRate: number }>();

  start(runtime: ChaosExperimentRuntime): void {
    this.active.set(runtime.id, {
      failureRate: runtime.dbFailureRate ?? 1.0,
    });
    this.logger.warn(
      `DB failure injector started: ${runtime.id} rate=${runtime.dbFailureRate ?? 1.0}`,
    );
  }

  stop(runtime: ChaosExperimentRuntime): void {
    this.active.delete(runtime.id);
    this.logger.log(`DB failure injector stopped: ${runtime.id}`);
  }

  shouldFail(experimentId: string): boolean {
    const config = this.active.get(experimentId);
    if (!config) return false;
    return Math.random() < config.failureRate;
  }

  createDbError(): Error {
    // Fabricates an error resembling PrismaClientKnownRequestError P1001
    // (connection error) so existing error-handling code treats it as a real DB outage.
    const err = new Error('Chaos: simulated database connection failure') as Error & {
      code: string;
      clientVersion: string;
    };
    err.code = 'P1001';
    err.clientVersion = 'chaos';
    return err;
  }
}
