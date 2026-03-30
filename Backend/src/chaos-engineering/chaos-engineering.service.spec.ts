import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { ChaosEngineeringService } from './chaos-engineering.service';
import {
  ChaosExperimentConfig,
  ExperimentStatus,
  ExperimentType,
  StressTarget,
} from './chaos-engineering.types';
import { LatencyInjector } from './injectors/latency.injector';
import { ErrorInjector } from './injectors/error.injector';
import { ResourceStressInjector } from './injectors/resource-stress.injector';
import { DbFailureInjector } from './injectors/db-failure.injector';

function makeConfig(overrides: Partial<ChaosExperimentConfig> = {}): ChaosExperimentConfig {
  return {
    id: 'test-exp-1',
    name: 'Test experiment',
    type: ExperimentType.LATENCY,
    targetServices: ['payment'],
    requestPercentage: 50,
    maxDurationMs: 60_000,
    allowInProduction: false,
    latencyMs: 200,
    ...overrides,
  };
}

describe('ChaosEngineeringService', () => {
  let service: ChaosEngineeringService;
  let configGet: jest.Mock;
  let latencyStart: jest.Mock;
  let latencyStop: jest.Mock;
  let errorStart: jest.Mock;
  let errorStop: jest.Mock;
  let resourceStart: jest.Mock;
  let resourceStop: jest.Mock;
  let dbStart: jest.Mock;
  let dbStop: jest.Mock;

  beforeEach(async () => {
    jest.useFakeTimers();

    configGet = jest.fn((key: string, defaultValue?: string) => {
      if (key === 'CHAOS_ENABLED') return 'true';
      if (key === 'NODE_ENV') return 'development';
      return defaultValue ?? undefined;
    });

    latencyStart = jest.fn();
    latencyStop = jest.fn();
    errorStart = jest.fn();
    errorStop = jest.fn();
    resourceStart = jest.fn();
    resourceStop = jest.fn();
    dbStart = jest.fn();
    dbStop = jest.fn();

    const module = await Test.createTestingModule({
      providers: [
        ChaosEngineeringService,
        { provide: ConfigService, useValue: { get: configGet } },
        { provide: LatencyInjector, useValue: { start: latencyStart, stop: latencyStop, injectDelay: jest.fn() } },
        { provide: ErrorInjector, useValue: { start: errorStart, stop: errorStop, shouldInjectError: jest.fn(), createError: jest.fn() } },
        { provide: ResourceStressInjector, useValue: { start: resourceStart, stop: resourceStop } },
        { provide: DbFailureInjector, useValue: { start: dbStart, stop: dbStop, shouldFail: jest.fn(), createDbError: jest.fn() } },
      ],
    }).compile();

    service = module.get(ChaosEngineeringService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ─── Safety Gates ─────────────────────────────────────────────────────────────

  describe('safety gates', () => {
    it('throws ForbiddenException when CHAOS_ENABLED is not true', () => {
      configGet.mockImplementation((key: string) => {
        if (key === 'CHAOS_ENABLED') return 'false';
        return 'development';
      });
      expect(() => service.startExperiment(makeConfig())).toThrow(ForbiddenException);
    });

    it('throws ForbiddenException in production without allowInProduction', () => {
      configGet.mockImplementation((key: string) => {
        if (key === 'CHAOS_ENABLED') return 'true';
        if (key === 'NODE_ENV') return 'production';
        return undefined;
      });
      expect(() => service.startExperiment(makeConfig({ allowInProduction: false }))).toThrow(
        ForbiddenException,
      );
    });

    it('allows experiment in production when allowInProduction is true', () => {
      configGet.mockImplementation((key: string) => {
        if (key === 'CHAOS_ENABLED') return 'true';
        if (key === 'NODE_ENV') return 'production';
        return undefined;
      });
      const runtime = service.startExperiment(makeConfig({ allowInProduction: true }));
      expect(runtime.status).toBe(ExperimentStatus.RUNNING);
    });

    it('throws ForbiddenException when requestPercentage is out of range', () => {
      expect(() => service.startExperiment(makeConfig({ requestPercentage: 150 }))).toThrow(
        ForbiddenException,
      );
    });

    it('throws ForbiddenException when maxDurationMs is zero or negative', () => {
      expect(() => service.startExperiment(makeConfig({ maxDurationMs: 0 }))).toThrow(
        ForbiddenException,
      );
    });
  });

  // ─── Experiment Lifecycle ─────────────────────────────────────────────────────

  describe('experiment lifecycle', () => {
    it('starts experiment in RUNNING status with startedAt timestamp', () => {
      const now = Date.now();
      const runtime = service.startExperiment(makeConfig());
      expect(runtime.status).toBe(ExperimentStatus.RUNNING);
      expect(runtime.startedAt).toBeGreaterThanOrEqual(now);
    });

    it('calls latencyInjector.start() for LATENCY experiment', () => {
      service.startExperiment(makeConfig({ type: ExperimentType.LATENCY, latencyMs: 300 }));
      expect(latencyStart).toHaveBeenCalledTimes(1);
    });

    it('calls errorInjector.start() for ERROR experiment', () => {
      service.startExperiment(makeConfig({ type: ExperimentType.ERROR, errorRate: 0.5 }));
      expect(errorStart).toHaveBeenCalledTimes(1);
    });

    it('calls resourceStressInjector.start() for RESOURCE_STRESS experiment', () => {
      service.startExperiment(
        makeConfig({ type: ExperimentType.RESOURCE_STRESS, stressTarget: StressTarget.CPU }),
      );
      expect(resourceStart).toHaveBeenCalledTimes(1);
    });

    it('calls dbFailureInjector.start() for DB_FAILURE experiment', () => {
      service.startExperiment(makeConfig({ type: ExperimentType.DB_FAILURE, dbFailureRate: 1.0 }));
      expect(dbStart).toHaveBeenCalledTimes(1);
    });

    it('aborts experiment and sets status to ABORTED', () => {
      service.startExperiment(makeConfig({ id: 'exp-abort' }));
      const result = service.abortExperiment('exp-abort', 'test reason');
      expect(result.status).toBe(ExperimentStatus.ABORTED);
      expect(result.abortReason).toBe('test reason');
    });

    it('calls injector stop() on abort', () => {
      service.startExperiment(makeConfig({ id: 'exp-stop', type: ExperimentType.ERROR, errorRate: 1 }));
      service.abortExperiment('exp-stop');
      expect(errorStop).toHaveBeenCalledTimes(1);
    });

    it('auto-aborts after maxDurationMs via setTimeout', () => {
      service.startExperiment(makeConfig({ id: 'exp-auto', maxDurationMs: 5_000 }));
      jest.advanceTimersByTime(5_001);
      const snapshot = service.getExperiment('exp-auto');
      expect(snapshot.status).toBe(ExperimentStatus.COMPLETED);
    });

    it('returns snapshot without re-calling stop() if experiment is already terminal', () => {
      service.startExperiment(makeConfig({ id: 'exp-done', type: ExperimentType.ERROR, errorRate: 1 }));
      service.abortExperiment('exp-done');
      errorStop.mockClear();
      const result = service.abortExperiment('exp-done', 'second abort');
      expect(errorStop).not.toHaveBeenCalled();
      expect(result.status).toBe(ExperimentStatus.ABORTED);
    });

    it('throws NotFoundException when aborting unknown experiment', () => {
      expect(() => service.abortExperiment('nonexistent')).toThrow(NotFoundException);
    });

    it('schedules PENDING experiment when scheduleAt is in the future', () => {
      const future = new Date(Date.now() + 10_000);
      const runtime = service.startExperiment(makeConfig({ id: 'exp-sched', scheduleAt: future }));
      expect(runtime.status).toBe(ExperimentStatus.PENDING);
      jest.advanceTimersByTime(10_001);
      const activated = service.getExperiment('exp-sched');
      expect(activated.status).toBe(ExperimentStatus.RUNNING);
    });
  });

  // ─── Blast Radius ─────────────────────────────────────────────────────────────

  describe('blast radius', () => {
    it('isInjectionActive returns false when chaos is disabled', () => {
      configGet.mockImplementation((key: string) => {
        if (key === 'CHAOS_ENABLED') return 'false';
        return 'development';
      });
      expect(service.isInjectionActive('payment', 'LATENCY')).toBe(false);
    });

    it('isInjectionActive returns false when global kill is active', () => {
      service.startExperiment(makeConfig({ id: 'exp-kill', requestPercentage: 100 }));
      service.activateGlobalKillSwitch();
      const spy = jest.spyOn(Math, 'random').mockReturnValue(0.01);
      expect(service.isInjectionActive('payment', 'LATENCY')).toBe(false);
      spy.mockRestore();
    });

    it('isInjectionActive returns false for non-matching service', () => {
      service.startExperiment(makeConfig({ id: 'exp-target', targetServices: ['payment'], requestPercentage: 100 }));
      jest.spyOn(Math, 'random').mockReturnValue(0.01);
      expect(service.isInjectionActive('auth', 'LATENCY')).toBe(false);
      jest.restoreAllMocks();
    });

    it('isInjectionActive returns true when random < requestPercentage/100', () => {
      service.startExperiment(makeConfig({ id: 'exp-prob', requestPercentage: 20 }));
      jest.spyOn(Math, 'random').mockReturnValue(0.1); // 0.1 < 0.2 → inject
      expect(service.isInjectionActive('payment', 'LATENCY')).toBe(true);
      jest.restoreAllMocks();
    });

    it('isInjectionActive returns false when random >= requestPercentage/100', () => {
      service.startExperiment(makeConfig({ id: 'exp-skip', requestPercentage: 20 }));
      jest.spyOn(Math, 'random').mockReturnValue(0.5); // 0.5 >= 0.2 → skip
      expect(service.isInjectionActive('payment', 'LATENCY')).toBe(false);
      jest.restoreAllMocks();
    });

    it('increments injectionCount when isInjectionActive returns true', () => {
      service.startExperiment(makeConfig({ id: 'exp-count', requestPercentage: 100 }));
      jest.spyOn(Math, 'random').mockReturnValue(0.01);
      service.isInjectionActive('payment', 'LATENCY');
      const snap = service.getExperiment('exp-count');
      expect(snap.injectionCount).toBe(1);
      jest.restoreAllMocks();
    });

    it('increments passCount when isInjectionActive returns false due to percentage', () => {
      service.startExperiment(makeConfig({ id: 'exp-pass', requestPercentage: 10 }));
      jest.spyOn(Math, 'random').mockReturnValue(0.99);
      service.isInjectionActive('payment', 'LATENCY');
      const snap = service.getExperiment('exp-pass');
      expect(snap.passCount).toBe(1);
      jest.restoreAllMocks();
    });
  });

  // ─── Global Kill Switch ───────────────────────────────────────────────────────

  describe('global kill switch', () => {
    it('aborts all running experiments on activation', () => {
      service.startExperiment(makeConfig({ id: 'exp-ks-1' }));
      service.startExperiment(makeConfig({ id: 'exp-ks-2', type: ExperimentType.ERROR, errorRate: 1 }));
      service.activateGlobalKillSwitch();

      const snap1 = service.getExperiment('exp-ks-1');
      const snap2 = service.getExperiment('exp-ks-2');
      expect(snap1.status).toBe(ExperimentStatus.ABORTED);
      expect(snap2.status).toBe(ExperimentStatus.ABORTED);
      expect(snap1.abortReason).toBe('global kill switch activated');
    });

    it('isGlobalKillActive returns true after activation', () => {
      service.activateGlobalKillSwitch();
      expect(service.isGlobalKillActive()).toBe(true);
    });

    it('allows new experiments after kill switch is deactivated', () => {
      service.activateGlobalKillSwitch();
      service.deactivateGlobalKillSwitch();
      expect(() => service.startExperiment(makeConfig({ id: 'exp-after-kill' }))).not.toThrow();
    });
  });

  // ─── Chaos Monkey ─────────────────────────────────────────────────────────────

  describe('chaos monkey', () => {
    it('does nothing when chaosMonkeyEnabled is false', () => {
      service.setChaosMonkeyEnabled(false);
      service.runChaosMonkey();
      expect(service.listExperiments().length).toBe(0);
    });

    it('creates an experiment when enabled with known targets', () => {
      service.setChaosMonkeyEnabled(true, ['payment']);
      jest.spyOn(Math, 'random').mockReturnValue(0.1); // 0.1 < 0.7 → LATENCY
      service.runChaosMonkey();
      const exps = service.listExperiments();
      expect(exps.length).toBe(1);
      expect(exps[0].type).toBe(ExperimentType.CHAOS_MONKEY);
      expect(exps[0].targetServices).toContain('payment');
      jest.restoreAllMocks();
    });

    it('skips if a chaos monkey experiment is already running', () => {
      service.setChaosMonkeyEnabled(true, ['payment']);
      jest.spyOn(Math, 'random').mockReturnValue(0.1);
      service.runChaosMonkey(); // starts first
      service.runChaosMonkey(); // should skip
      expect(service.listExperiments(ExperimentStatus.RUNNING).length).toBe(1);
      jest.restoreAllMocks();
    });

    it('falls back to targets seen from previous experiments when no explicit targets set', () => {
      service.startExperiment(makeConfig({ id: 'seed-exp', targetServices: ['trading'] }));
      service.abortExperiment('seed-exp');
      service.setChaosMonkeyEnabled(true); // no explicit targets
      jest.spyOn(Math, 'random').mockReturnValue(0.1);
      service.runChaosMonkey();
      const monkeyExps = service.listExperiments().filter((e) => e.type === ExperimentType.CHAOS_MONKEY);
      expect(monkeyExps.length).toBeGreaterThan(0);
      jest.restoreAllMocks();
    });
  });

  // ─── Resilience Scoring ───────────────────────────────────────────────────────

  describe('resilience scoring', () => {
    it('returns a valid report with no experiments', () => {
      const report = service.getResilienceReport();
      expect(report.score.overall).toBeGreaterThanOrEqual(0);
      expect(report.score.overall).toBeLessThanOrEqual(100);
      expect(report.summary.totalExperiments).toBe(0);
    });

    it('scores experimentDiversity as 40 when 2 of 5 types have been run', () => {
      service.startExperiment(makeConfig({ id: 'div-1', type: ExperimentType.LATENCY }));
      service.startExperiment(makeConfig({ id: 'div-2', type: ExperimentType.ERROR, errorRate: 1 }));
      const report = service.getResilienceReport();
      expect(report.score.dimensions.experimentDiversity).toBe(40);
    });

    it('scores circuitBreakerCoverage as 100 when both ERROR and DB_FAILURE have been run', () => {
      service.startExperiment(makeConfig({ id: 'cb-1', type: ExperimentType.ERROR, errorRate: 1 }));
      service.startExperiment(makeConfig({ id: 'cb-2', type: ExperimentType.DB_FAILURE, dbFailureRate: 1 }));
      const report = service.getResilienceReport();
      expect(report.score.dimensions.circuitBreakerCoverage).toBe(100);
    });

    it('generates HIGH priority recommendation when circuitBreakerCoverage is below 60', () => {
      service.startExperiment(makeConfig({ id: 'rec-1', type: ExperimentType.LATENCY }));
      const report = service.getResilienceReport();
      const highRecs = report.recommendations.filter((r) => r.priority === 'HIGH');
      expect(highRecs.some((r) => r.area === 'Circuit Breaker Coverage')).toBe(true);
    });

    it('generates LOW recommendation to enable chaos monkey when it has never run', () => {
      const report = service.getResilienceReport();
      expect(report.recommendations.some((r) => r.area === 'Continuous Chaos')).toBe(true);
    });

    it('does not generate chaos monkey recommendation after monkey experiment', () => {
      service.setChaosMonkeyEnabled(true, ['payment']);
      jest.spyOn(Math, 'random').mockReturnValue(0.1);
      service.runChaosMonkey();
      const report = service.getResilienceReport();
      expect(report.recommendations.some((r) => r.area === 'Continuous Chaos')).toBe(false);
      jest.restoreAllMocks();
    });

    it('blastRadiusControl score is lower when experiments use high requestPercentage', () => {
      service.startExperiment(makeConfig({ id: 'blast-high', requestPercentage: 90 }));
      const report = service.getResilienceReport();
      expect(report.score.dimensions.blastRadiusControl).toBeLessThan(20);
    });
  });

  // ─── Query Methods ────────────────────────────────────────────────────────────

  describe('query methods', () => {
    it('listExperiments returns all experiments', () => {
      service.startExperiment(makeConfig({ id: 'q-1' }));
      service.startExperiment(makeConfig({ id: 'q-2', type: ExperimentType.ERROR, errorRate: 1 }));
      expect(service.listExperiments().length).toBe(2);
    });

    it('listExperiments filters by status', () => {
      service.startExperiment(makeConfig({ id: 'q-run' }));
      service.startExperiment(makeConfig({ id: 'q-abort', type: ExperimentType.ERROR, errorRate: 1 }));
      service.abortExperiment('q-abort');
      expect(service.listExperiments(ExperimentStatus.RUNNING).length).toBe(1);
      expect(service.listExperiments(ExperimentStatus.ABORTED).length).toBe(1);
    });

    it('getExperiment throws NotFoundException for unknown id', () => {
      expect(() => service.getExperiment('no-such-id')).toThrow(NotFoundException);
    });

    it('activatePendingExperiment moves PENDING to RUNNING', () => {
      const future = new Date(Date.now() + 60_000);
      service.startExperiment(makeConfig({ id: 'pend-act', scheduleAt: future }));
      const result = service.activatePendingExperiment('pend-act');
      expect(result.status).toBe(ExperimentStatus.RUNNING);
    });
  });
});
