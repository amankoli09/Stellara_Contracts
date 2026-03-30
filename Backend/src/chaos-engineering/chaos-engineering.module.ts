import { Module } from '@nestjs/common';

import { ChaosEngineeringController } from './chaos-engineering.controller';
import { ChaosEngineeringService } from './chaos-engineering.service';
import { DbFailureInjector } from './injectors/db-failure.injector';
import { ErrorInjector } from './injectors/error.injector';
import { LatencyInjector } from './injectors/latency.injector';
import { ResourceStressInjector } from './injectors/resource-stress.injector';

@Module({
  controllers: [ChaosEngineeringController],
  providers: [
    ChaosEngineeringService,
    LatencyInjector,
    ErrorInjector,
    ResourceStressInjector,
    DbFailureInjector,
  ],
  exports: [ChaosEngineeringService],
})
export class ChaosEngineeringModule {}
