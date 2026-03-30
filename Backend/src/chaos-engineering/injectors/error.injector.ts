import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

import { ChaosExperimentRuntime } from '../chaos-engineering.types';

@Injectable()
export class ErrorInjector {
  private readonly logger = new Logger(ErrorInjector.name);

  private readonly active = new Map<
    string,
    { rate: number; message: string; statusCode: number }
  >();

  start(runtime: ChaosExperimentRuntime): void {
    this.active.set(runtime.id, {
      rate: runtime.errorRate ?? 1.0,
      message: runtime.errorMessage ?? 'Chaos engineering error injection',
      statusCode: runtime.errorStatusCode ?? 503,
    });
    this.logger.warn(`Error injector started: ${runtime.id} rate=${runtime.errorRate ?? 1.0}`);
  }

  stop(runtime: ChaosExperimentRuntime): void {
    this.active.delete(runtime.id);
    this.logger.log(`Error injector stopped: ${runtime.id}`);
  }

  shouldInjectError(experimentId: string): boolean {
    const config = this.active.get(experimentId);
    if (!config) return false;
    return Math.random() < config.rate;
  }

  createError(experimentId: string): ServiceUnavailableException {
    const config = this.active.get(experimentId);
    const message = config?.message ?? 'Chaos engineering error injection';
    return new ServiceUnavailableException(message);
  }
}
