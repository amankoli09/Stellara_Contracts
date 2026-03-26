import { Module } from '@nestjs/common';
import { AdvancedCacheService } from './advanced-cache.service';

@Module({
  providers: [AdvancedCacheService],
  exports: [AdvancedCacheService],
})
export class AdvancedCacheModule {}

