export enum ExperimentType {
  LATENCY = 'LATENCY',
  ERROR = 'ERROR',
  DB_FAILURE = 'DB_FAILURE',
  RESOURCE_STRESS = 'RESOURCE_STRESS',
  CHAOS_MONKEY = 'CHAOS_MONKEY',
}

export enum ExperimentStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  ABORTED = 'ABORTED',
  FAILED = 'FAILED',
}

export enum StressTarget {
  CPU = 'CPU',
  MEMORY = 'MEMORY',
  BOTH = 'BOTH',
}

export type InjectionType = 'LATENCY' | 'ERROR' | 'DB_FAILURE';

export interface ChaosExperimentConfig {
  id: string;
  name: string;
  description?: string;
  type: ExperimentType;
  targetServices: string[];
  requestPercentage: number;
  maxDurationMs: number;
  allowInProduction: boolean;
  scheduleAt?: Date;
  runbook?: string;
  // LATENCY params
  latencyMs?: number;
  latencyJitterMs?: number;
  // ERROR params
  errorRate?: number;
  errorMessage?: string;
  errorStatusCode?: number;
  // RESOURCE_STRESS params
  stressTarget?: StressTarget;
  cpuWorkers?: number;
  memoryChunkMb?: number;
  memoryChunks?: number;
  // DB_FAILURE params
  dbFailureRate?: number;
}

export interface ChaosExperimentRuntime extends ChaosExperimentConfig {
  status: ExperimentStatus;
  startedAt: number | null;
  completedAt: number | null;
  abortedAt: number | null;
  abortReason: string | null;
  injectionCount: number;
  passCount: number;
  errorCount: number;
  autoAbortTimerId: ReturnType<typeof setTimeout> | null;
}

export interface ResilienceScoreDimensions {
  circuitBreakerCoverage: number;
  experimentDiversity: number;
  successfulExperiments: number;
  productionReadiness: number;
  blastRadiusControl: number;
}

export interface ResilienceScore {
  overall: number;
  dimensions: ResilienceScoreDimensions;
}

export interface ResilienceRecommendation {
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  area: string;
  finding: string;
  action: string;
}

export interface ResilienceReportSummary {
  totalExperiments: number;
  completedWithoutAbort: number;
  abortedExperiments: number;
  failedExperiments: number;
  chaosMonkeyEnabled: boolean;
  globalKillSwitchActive: boolean;
}

export interface ExperimentBreakdownEntry {
  type: ExperimentType;
  count: number;
  avgInjections: number;
}

export interface ResilienceReport {
  generatedAt: string;
  score: ResilienceScore;
  summary: ResilienceReportSummary;
  experimentBreakdown: ExperimentBreakdownEntry[];
  recommendations: ResilienceRecommendation[];
}
