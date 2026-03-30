import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import {
  ChaosExperimentConfig,
  ChaosExperimentRuntime,
  ExperimentBreakdownEntry,
  ExperimentStatus,
  ExperimentType,
  InjectionType,
  ResilienceReport,
  ResilienceRecommendation,
  ResilienceScore,
} from './chaos-engineering.types';
import { DbFailureInjector } from './injectors/db-failure.injector';
import { ErrorInjector } from './injectors/error.injector';
import { LatencyInjector } from './injectors/latency.injector';
import { ResourceStressInjector } from './injectors/resource-stress.injector';

const TERMINAL_STATUSES = new Set([
  ExperimentStatus.COMPLETED,
  ExperimentStatus.ABORTED,
  ExperimentStatus.FAILED,
]);

@Injectable()
export class ChaosEngineeringService implements OnModuleDestroy {
  private readonly logger = new Logger(ChaosEngineeringService.name);

  private readonly experiments = new Map<string, ChaosExperimentRuntime>();
  private globalKillActive = false;
  private chaosMonkeyEnabled = false;
  private chaosMonkeyTargets: string[] = [];

  constructor(
    private readonly configService: ConfigService,
    private readonly latencyInjector: LatencyInjector,
    private readonly errorInjector: ErrorInjector,
    private readonly resourceStressInjector: ResourceStressInjector,
    private readonly dbFailureInjector: DbFailureInjector,
  ) {}

  onModuleDestroy(): void {
    this.activateGlobalKillSwitch();
  }

  // ─── Safety Gates ────────────────────────────────────────────────────────────

  private isChaosEnabled(): boolean {
    return this.configService.get<string>('CHAOS_ENABLED') === 'true';
  }

  private isProductionSafe(config: ChaosExperimentConfig): boolean {
    const nodeEnv = this.configService.get<string>('NODE_ENV', 'development');
    if (nodeEnv === 'production' && !config.allowInProduction) {
      return false;
    }
    return true;
  }

  // ─── Experiment Lifecycle ─────────────────────────────────────────────────────

  startExperiment(config: ChaosExperimentConfig): ChaosExperimentRuntime {
    if (!this.isChaosEnabled()) {
      throw new ForbiddenException(
        'Chaos engineering is disabled. Set CHAOS_ENABLED=true to enable.',
      );
    }

    if (!this.isProductionSafe(config)) {
      throw new ForbiddenException(
        'Experiment not allowed in production. Set allowInProduction: true to override.',
      );
    }

    if (config.requestPercentage < 0 || config.requestPercentage > 100) {
      throw new ForbiddenException('requestPercentage must be between 0 and 100.');
    }

    if (config.maxDurationMs <= 0) {
      throw new ForbiddenException('maxDurationMs must be greater than 0.');
    }

    const existing = this.experiments.get(config.id);
    if (existing && existing.status === ExperimentStatus.RUNNING) {
      throw new ForbiddenException(`Experiment '${config.id}' is already running.`);
    }

    // Track all target services seen for chaos monkey fallback
    for (const svc of config.targetServices) {
      if (!this.chaosMonkeyTargets.includes(svc)) {
        this.chaosMonkeyTargets.push(svc);
      }
    }

    const runtime: ChaosExperimentRuntime = {
      ...config,
      status: ExperimentStatus.PENDING,
      startedAt: null,
      completedAt: null,
      abortedAt: null,
      abortReason: null,
      injectionCount: 0,
      passCount: 0,
      errorCount: 0,
      autoAbortTimerId: null,
    };

    this.experiments.set(config.id, runtime);

    if (config.scheduleAt && config.scheduleAt > new Date()) {
      const delay = config.scheduleAt.getTime() - Date.now();
      setTimeout(() => this._activateExperiment(runtime), delay);
      this.logger.log(`Experiment '${config.id}' scheduled in ${delay}ms`);
    } else {
      this._activateExperiment(runtime);
    }

    return this.snapshotRuntime(runtime);
  }

  private _activateExperiment(runtime: ChaosExperimentRuntime): void {
    runtime.status = ExperimentStatus.RUNNING;
    runtime.startedAt = Date.now();

    this.callInjectorStart(runtime);

    runtime.autoAbortTimerId = setTimeout(() => {
      this.completeExperiment(runtime.id);
    }, runtime.maxDurationMs);

    this.logger.warn(
      `Experiment '${runtime.id}' (${runtime.type}) activated — blast radius: ${runtime.requestPercentage}% of [${runtime.targetServices.join(', ')}]`,
    );
  }

  abortExperiment(id: string, reason = 'manual abort'): ChaosExperimentRuntime {
    const runtime = this.experiments.get(id);
    if (!runtime) {
      throw new NotFoundException(`Experiment '${id}' not found.`);
    }

    if (TERMINAL_STATUSES.has(runtime.status)) {
      return this.snapshotRuntime(runtime);
    }

    this.clearAutoAbort(runtime);
    this.callInjectorStop(runtime);

    runtime.status = ExperimentStatus.ABORTED;
    runtime.abortedAt = Date.now();
    runtime.abortReason = reason;

    this.logger.warn(`Experiment '${id}' aborted — reason: ${reason}`);
    return this.snapshotRuntime(runtime);
  }

  private completeExperiment(id: string): void {
    const runtime = this.experiments.get(id);
    if (!runtime || TERMINAL_STATUSES.has(runtime.status)) return;

    this.clearAutoAbort(runtime);
    this.callInjectorStop(runtime);

    runtime.status = ExperimentStatus.COMPLETED;
    runtime.completedAt = Date.now();

    this.logger.log(`Experiment '${id}' completed naturally after ${runtime.maxDurationMs}ms`);
  }

  activateGlobalKillSwitch(): void {
    this.globalKillActive = true;
    this.logger.warn('Global chaos kill switch ACTIVATED — aborting all running experiments');

    for (const runtime of this.experiments.values()) {
      if (runtime.status === ExperimentStatus.RUNNING) {
        this.abortExperiment(runtime.id, 'global kill switch activated');
      }
    }
  }

  deactivateGlobalKillSwitch(): void {
    this.globalKillActive = false;
    this.logger.log('Global chaos kill switch deactivated');
  }

  isGlobalKillActive(): boolean {
    return this.globalKillActive;
  }

  // ─── Probe Method ─────────────────────────────────────────────────────────────

  isInjectionActive(targetService: string, type: InjectionType): boolean {
    if (!this.isChaosEnabled() || this.globalKillActive) return false;

    for (const runtime of this.experiments.values()) {
      if (runtime.status !== ExperimentStatus.RUNNING) continue;
      if (!runtime.targetServices.includes(targetService)) continue;
      if (!this.experimentTypeMatchesInjectionType(runtime.type, type)) continue;

      if (Math.random() < runtime.requestPercentage / 100) {
        runtime.injectionCount += 1;
        return true;
      } else {
        runtime.passCount += 1;
      }
    }

    return false;
  }

  private experimentTypeMatchesInjectionType(expType: ExperimentType, injType: InjectionType): boolean {
    const mapping: Record<InjectionType, ExperimentType[]> = {
      LATENCY: [ExperimentType.LATENCY, ExperimentType.CHAOS_MONKEY],
      ERROR: [ExperimentType.ERROR, ExperimentType.CHAOS_MONKEY],
      DB_FAILURE: [ExperimentType.DB_FAILURE],
    };
    return mapping[injType].includes(expType);
  }

  // ─── Chaos Monkey ─────────────────────────────────────────────────────────────

  @Cron(CronExpression.EVERY_MINUTE)
  runChaosMonkey(): void {
    if (!this.chaosMonkeyEnabled || !this.isChaosEnabled() || this.globalKillActive) return;

    const alreadyRunning = Array.from(this.experiments.values()).some(
      (r) => r.type === ExperimentType.CHAOS_MONKEY && r.status === ExperimentStatus.RUNNING,
    );
    if (alreadyRunning) {
      this.logger.log('Chaos monkey skipped — a monkey experiment is already running');
      return;
    }

    const targets =
      this.chaosMonkeyTargets.length > 0
        ? this.chaosMonkeyTargets
        : this.collectAllSeenTargets();

    if (targets.length === 0) {
      this.logger.log('Chaos monkey skipped — no target services registered');
      return;
    }

    const target = targets[Math.floor(Math.random() * targets.length)];
    const type = Math.random() < 0.7 ? ExperimentType.LATENCY : ExperimentType.ERROR;

    this.logger.warn(`Chaos monkey targeting '${target}' with ${type} experiment`);

    try {
      this.startExperiment({
        id: `chaos-monkey-${Date.now()}`,
        name: `Chaos Monkey — ${type} on ${target}`,
        type: ExperimentType.CHAOS_MONKEY,
        targetServices: [target],
        requestPercentage: 10,
        maxDurationMs: 30_000,
        allowInProduction: false,
        latencyMs: type === ExperimentType.LATENCY ? 300 : undefined,
        errorRate: type === ExperimentType.ERROR ? 0.5 : undefined,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Chaos monkey failed to start experiment: ${message}`);
    }
  }

  setChaosMonkeyEnabled(enabled: boolean, targets?: string[]): void {
    this.chaosMonkeyEnabled = enabled;
    if (targets) {
      this.chaosMonkeyTargets = targets;
    }
    this.logger.log(
      `Chaos monkey ${enabled ? 'enabled' : 'disabled'}${targets ? ` with targets: [${targets.join(', ')}]` : ''}`,
    );
  }

  getChaosMonkeyStatus(): { enabled: boolean; targets: string[] } {
    return {
      enabled: this.chaosMonkeyEnabled,
      targets: [...this.chaosMonkeyTargets],
    };
  }

  private collectAllSeenTargets(): string[] {
    const seen = new Set<string>();
    for (const runtime of this.experiments.values()) {
      for (const svc of runtime.targetServices) {
        seen.add(svc);
      }
    }
    return Array.from(seen);
  }

  // ─── Query Methods ────────────────────────────────────────────────────────────

  listExperiments(statusFilter?: ExperimentStatus): ChaosExperimentRuntime[] {
    const all = Array.from(this.experiments.values()).map((r) => this.snapshotRuntime(r));
    if (statusFilter) {
      return all.filter((r) => r.status === statusFilter);
    }
    return all;
  }

  getExperiment(id: string): ChaosExperimentRuntime {
    const runtime = this.experiments.get(id);
    if (!runtime) {
      throw new NotFoundException(`Experiment '${id}' not found.`);
    }
    return this.snapshotRuntime(runtime);
  }

  activatePendingExperiment(id: string): ChaosExperimentRuntime {
    const runtime = this.experiments.get(id);
    if (!runtime) {
      throw new NotFoundException(`Experiment '${id}' not found.`);
    }
    if (runtime.status !== ExperimentStatus.PENDING) {
      throw new ForbiddenException(
        `Experiment '${id}' is in status '${runtime.status}' and cannot be activated.`,
      );
    }
    this._activateExperiment(runtime);
    return this.snapshotRuntime(runtime);
  }

  // ─── Resilience Report ────────────────────────────────────────────────────────

  getResilienceReport(): ResilienceReport {
    const all = Array.from(this.experiments.values());
    const total = all.length;
    const completed = all.filter((r) => r.status === ExperimentStatus.COMPLETED);
    const aborted = all.filter((r) => r.status === ExperimentStatus.ABORTED);
    const failed = all.filter((r) => r.status === ExperimentStatus.FAILED);

    const usedTypes = new Set(all.map((r) => r.type));
    const distinctTypeCount = usedTypes.size;

    const hasErrorType = usedTypes.has(ExperimentType.ERROR);
    const hasDbFailureType = usedTypes.has(ExperimentType.DB_FAILURE);
    const chaosMonkeyEverRun = usedTypes.has(ExperimentType.CHAOS_MONKEY);

    // Dimension: circuitBreakerCoverage (25)
    let circuitBreakerCoverage = 0;
    if (hasErrorType && hasDbFailureType) {
      circuitBreakerCoverage = 100;
    } else if (hasErrorType || hasDbFailureType) {
      circuitBreakerCoverage = 50;
    }

    // Dimension: experimentDiversity (20)
    const experimentDiversity = Math.round((distinctTypeCount / 5) * 100);

    // Dimension: successfulExperiments (25)
    const successfulExperiments = total > 0 ? Math.round((completed.length / total) * 100) : 0;

    // Dimension: productionReadiness (15)
    let productionReadiness = 100;
    const hasProductionExperiment = all.some((r) => r.allowInProduction);
    if (!hasProductionExperiment) productionReadiness -= 50;
    const hasOversizedExperiment = all.some((r) => r.maxDurationMs > 300_000);
    if (hasOversizedExperiment) productionReadiness -= 20;
    productionReadiness = Math.max(0, productionReadiness);

    // Dimension: blastRadiusControl (15)
    const avgPercentage =
      total > 0 ? all.reduce((sum, r) => sum + r.requestPercentage, 0) / total : 100;
    const blastRadiusControl = Math.max(0, Math.round(100 - avgPercentage));

    const dimensions = {
      circuitBreakerCoverage,
      experimentDiversity,
      successfulExperiments,
      productionReadiness,
      blastRadiusControl,
    };

    const overall = Math.round(
      (circuitBreakerCoverage * 25 +
        experimentDiversity * 20 +
        successfulExperiments * 25 +
        productionReadiness * 15 +
        blastRadiusControl * 15) /
        100,
    );

    const score: ResilienceScore = { overall, dimensions };

    const recommendations = this.buildRecommendations({
      dimensions,
      total,
      chaosMonkeyEverRun,
    });

    // Experiment breakdown by type
    const breakdownMap = new Map<ExperimentType, ChaosExperimentRuntime[]>();
    for (const runtime of all) {
      const bucket = breakdownMap.get(runtime.type) ?? [];
      bucket.push(runtime);
      breakdownMap.set(runtime.type, bucket);
    }
    const experimentBreakdown: ExperimentBreakdownEntry[] = Array.from(breakdownMap.entries()).map(
      ([type, runtimes]) => ({
        type,
        count: runtimes.length,
        avgInjections:
          runtimes.length > 0
            ? Math.round(runtimes.reduce((s, r) => s + r.injectionCount, 0) / runtimes.length)
            : 0,
      }),
    );

    return {
      generatedAt: new Date().toISOString(),
      score,
      summary: {
        totalExperiments: total,
        completedWithoutAbort: completed.length,
        abortedExperiments: aborted.length,
        failedExperiments: failed.length,
        chaosMonkeyEnabled: this.chaosMonkeyEnabled,
        globalKillSwitchActive: this.globalKillActive,
      },
      experimentBreakdown,
      recommendations,
    };
  }

  private buildRecommendations(ctx: {
    dimensions: ResilienceScore['dimensions'];
    total: number;
    chaosMonkeyEverRun: boolean;
  }): ResilienceRecommendation[] {
    const recs: ResilienceRecommendation[] = [];

    if (ctx.dimensions.circuitBreakerCoverage < 60) {
      recs.push({
        priority: 'HIGH',
        area: 'Circuit Breaker Coverage',
        finding: 'ERROR and DB_FAILURE experiment types have not both been exercised.',
        action:
          'Run ERROR and DB_FAILURE experiments against dependency services to validate circuit breaker responses.',
      });
    }

    if (ctx.dimensions.experimentDiversity < 60) {
      recs.push({
        priority: 'HIGH',
        area: 'Experiment Diversity',
        finding: `Only ${Math.round((ctx.dimensions.experimentDiversity / 100) * 5)} of 5 experiment types have been run.`,
        action:
          'Run all five experiment types (LATENCY, ERROR, DB_FAILURE, RESOURCE_STRESS, CHAOS_MONKEY) to validate full resilience posture.',
      });
    }

    if (ctx.total > 0 && ctx.dimensions.successfulExperiments < 50) {
      recs.push({
        priority: 'HIGH',
        area: 'Experiment Success Rate',
        finding: 'More than half of experiments were aborted before completing naturally.',
        action:
          'Review maxDurationMs settings and reduce requestPercentage to allow experiments to complete without triggering safety aborts.',
      });
    }

    if (ctx.total > 0 && ctx.dimensions.blastRadiusControl < 50) {
      recs.push({
        priority: 'MEDIUM',
        area: 'Blast Radius Control',
        finding: 'Average requestPercentage across experiments exceeds 50%.',
        action:
          'Reduce requestPercentage to ≤25% for safer experiments. Wide blast radius risks cascading failures during testing.',
      });
    }

    if (ctx.total > 0 && ctx.dimensions.productionReadiness < 80) {
      recs.push({
        priority: 'MEDIUM',
        area: 'Production Readiness',
        finding: 'No experiment is marked allowInProduction, or experiments use oversized maxDurationMs.',
        action:
          'Mark at least one experiment allowInProduction: true to validate production behaviour. Keep maxDurationMs ≤ 300,000ms.',
      });
    }

    if (!ctx.chaosMonkeyEverRun) {
      recs.push({
        priority: 'LOW',
        area: 'Continuous Chaos',
        finding: 'Chaos Monkey has never run an experiment.',
        action:
          'Enable Chaos Monkey via POST /chaos-engineering/chaos-monkey to continuously probe random services.',
      });
    }

    return recs;
  }

  // ─── Injector Dispatch ────────────────────────────────────────────────────────

  private callInjectorStart(runtime: ChaosExperimentRuntime): void {
    switch (runtime.type) {
      case ExperimentType.LATENCY:
      case ExperimentType.CHAOS_MONKEY:
        if (runtime.latencyMs !== undefined) {
          this.latencyInjector.start(runtime);
        } else if (runtime.type === ExperimentType.CHAOS_MONKEY && runtime.errorRate !== undefined) {
          this.errorInjector.start(runtime);
        }
        break;
      case ExperimentType.ERROR:
        this.errorInjector.start(runtime);
        break;
      case ExperimentType.DB_FAILURE:
        this.dbFailureInjector.start(runtime);
        break;
      case ExperimentType.RESOURCE_STRESS:
        this.resourceStressInjector.start(runtime);
        break;
    }
  }

  private callInjectorStop(runtime: ChaosExperimentRuntime): void {
    switch (runtime.type) {
      case ExperimentType.LATENCY:
      case ExperimentType.CHAOS_MONKEY:
        this.latencyInjector.stop(runtime);
        this.errorInjector.stop(runtime);
        break;
      case ExperimentType.ERROR:
        this.errorInjector.stop(runtime);
        break;
      case ExperimentType.DB_FAILURE:
        this.dbFailureInjector.stop(runtime);
        break;
      case ExperimentType.RESOURCE_STRESS:
        this.resourceStressInjector.stop(runtime);
        break;
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  private clearAutoAbort(runtime: ChaosExperimentRuntime): void {
    if (runtime.autoAbortTimerId !== null) {
      clearTimeout(runtime.autoAbortTimerId);
      runtime.autoAbortTimerId = null;
    }
  }

  private snapshotRuntime(runtime: ChaosExperimentRuntime): ChaosExperimentRuntime {
    return {
      ...runtime,
      targetServices: [...runtime.targetServices],
      autoAbortTimerId: null, // do not expose internal timer handle
    };
  }
}
