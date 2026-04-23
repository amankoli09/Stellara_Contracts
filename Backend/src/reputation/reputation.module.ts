import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database.module';
import { ReputationController } from './reputation.controller';
import { ReputationService } from './reputation.service';

@Module({
  imports: [DatabaseModule],
  controllers: [ReputationController],
  providers: [ReputationService],
  exports: [ReputationService],
})
export class ReputationModule {}
