import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { v4 as uuidv4 } from 'uuid';

import { ChaosEngineeringService } from './chaos-engineering.service';
import {
  ExperimentStatus,
  ExperimentType,
  StressTarget,
} from './chaos-engineering.types';

class CreateExperimentDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsEnum(ExperimentType)
  type: ExperimentType;

  @IsArray()
  @IsString({ each: true })
  targetServices: string[];

  @IsNumber()
  @Min(0)
  @Max(100)
  requestPercentage: number;

  @IsNumber()
  @Min(1000)
  maxDurationMs: number;

  @IsBoolean()
  allowInProduction: boolean;

  @IsOptional()
  @IsDateString()
  scheduleAt?: string;

  @IsOptional()
  @IsString()
  runbook?: string;

  // LATENCY params
  @IsOptional()
  @IsNumber()
  @Min(0)
  latencyMs?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  latencyJitterMs?: number;

  // ERROR params
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  errorRate?: number;

  @IsOptional()
  @IsString()
  errorMessage?: string;

  @IsOptional()
  @IsNumber()
  errorStatusCode?: number;

  // RESOURCE_STRESS params
  @IsOptional()
  @IsEnum(StressTarget)
  stressTarget?: StressTarget;

  @IsOptional()
  @IsNumber()
  @Min(1)
  cpuWorkers?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  memoryChunkMb?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  memoryChunks?: number;

  // DB_FAILURE params
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  dbFailureRate?: number;
}

class AbortExperimentDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

class ChaosMonkeyToggleDto {
  @IsBoolean()
  enabled: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  targets?: string[];
}

@Controller('chaos-engineering')
export class ChaosEngineeringController {
  constructor(private readonly chaosService: ChaosEngineeringService) {}

  @Get('experiments')
  listExperiments(@Query('status') status?: ExperimentStatus) {
    return this.chaosService.listExperiments(status);
  }

  @Post('experiments')
  createExperiment(@Body() dto: CreateExperimentDto) {
    return this.chaosService.startExperiment({
      ...dto,
      id: dto.id ?? uuidv4(),
      scheduleAt: dto.scheduleAt ? new Date(dto.scheduleAt) : undefined,
    });
  }

  @Get('experiments/:id')
  getExperiment(@Param('id') id: string) {
    return this.chaosService.getExperiment(id);
  }

  @Post('experiments/:id/run')
  runExperiment(@Param('id') id: string) {
    return this.chaosService.activatePendingExperiment(id);
  }

  @Post('experiments/:id/abort')
  abortExperiment(@Param('id') id: string, @Body() dto: AbortExperimentDto) {
    return this.chaosService.abortExperiment(id, dto.reason);
  }

  @Post('kill-switch/activate')
  activateKillSwitch() {
    this.chaosService.activateGlobalKillSwitch();
    return { active: true, activatedAt: new Date().toISOString() };
  }

  @Post('kill-switch/deactivate')
  deactivateKillSwitch() {
    this.chaosService.deactivateGlobalKillSwitch();
    return { active: false, deactivatedAt: new Date().toISOString() };
  }

  @Get('kill-switch')
  getKillSwitchStatus() {
    return { active: this.chaosService.isGlobalKillActive() };
  }

  @Get('resilience-report')
  getResilienceReport() {
    return this.chaosService.getResilienceReport();
  }

  @Post('chaos-monkey')
  toggleChaosMonkey(@Body() dto: ChaosMonkeyToggleDto) {
    this.chaosService.setChaosMonkeyEnabled(dto.enabled, dto.targets);
    return this.chaosService.getChaosMonkeyStatus();
  }

  @Get('chaos-monkey')
  getChaosMonkeyStatus() {
    return this.chaosService.getChaosMonkeyStatus();
  }
}
