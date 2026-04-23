import { Test, TestingModule } from '@nestjs/testing';
import { EventHandlerService } from './event-handler.service';
import { PrismaService } from '../../prisma.service';
import { NotificationService } from '../../notification/services/notification.service';
import { ReputationService } from '../../reputation/reputation.service';
import { ContractEventType } from '../types/event-types';
import { 
  createMockParsedEvent, 
  mockProjectCreatedData, 
  mockContributionMadeData,
  mockMilestoneApprovedData 
} from '../tests/fixtures/event.fixtures';

describe('EventHandlerService', () => {
  let service: EventHandlerService;
  let prisma: PrismaService;
  let notificationService: NotificationService;
  let reputationService: ReputationService;

  const mockPrisma = {
    user: { upsert: jest.fn() },
    project: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    contribution: { findMany: jest.fn(), upsert: jest.fn() },
    milestone: { updateMany: jest.fn() },
    $transaction: jest.fn((promises) => Promise.all(promises)),
  };

  const mockNotificationService = {
    notify: jest.fn().mockResolvedValue(true),
  };

  const mockReputationService = {
    updateTrustScore: jest.fn().mockResolvedValue(true),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventHandlerService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationService, useValue: mockNotificationService },
        { provide: ReputationService, useValue: mockReputationService },
      ],
    }).compile();

    service = module.get<EventHandlerService>(EventHandlerService);
    prisma = module.get<PrismaService>(PrismaService);
    notificationService = module.get<NotificationService>(NotificationService);
    reputationService = module.get<ReputationService>(ReputationService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('processEvent', () => {
    it('should route PROJECT_CREATED to correct handler', async () => {
      const event = createMockParsedEvent({
        eventType: ContractEventType.PROJECT_CREATED,
        data: mockProjectCreatedData,
      });

      mockPrisma.user.upsert.mockResolvedValue({ id: 'user-1' });

      const result = await service.processEvent(event);

      expect(result).toBe(true);
      expect(prisma.user.upsert).toHaveBeenCalled();
      expect(prisma.project.upsert).toHaveBeenCalled();
    });

    it('should route CONTRIBUTION_MADE to correct handler and update funds', async () => {
      const event = createMockParsedEvent({
        eventType: ContractEventType.CONTRIBUTION_MADE,
        data: mockContributionMadeData,
      });

      mockPrisma.user.upsert.mockResolvedValue({ id: 'user-2' });
      mockPrisma.project.findUnique.mockResolvedValue({ id: 'proj-1', title: 'Test Project' });

      const result = await service.processEvent(event);

      expect(result).toBe(true);
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(notificationService.notify).toHaveBeenCalled();
    });

    it('should route MILESTONE_APPROVED and update reputation', async () => {
      const event = createMockParsedEvent({
        eventType: ContractEventType.MILESTONE_APPROVED,
        data: mockMilestoneApprovedData,
      });

      mockPrisma.project.findUnique.mockResolvedValue({ 
        id: 'proj-1', 
        title: 'Test Project',
        creatorId: 'creator-1' 
      });
      mockPrisma.contribution.findMany.mockResolvedValue([{ investorId: 'investor-1' }]);

      const result = await service.processEvent(event);

      expect(result).toBe(true);
      expect(prisma.milestone.updateMany).toHaveBeenCalled();
      expect(reputationService.updateTrustScore).toHaveBeenCalledWith('creator-1');
    });

    it('should route MILESTONE_REJECTED and notify investors', async () => {
      const event = createMockParsedEvent({
        eventType: ContractEventType.MILESTONE_REJECTED,
        data: { projectId: 'proj-1', milestoneId: 1 },
      });

      mockPrisma.project.findUnique.mockResolvedValue({ id: 'proj-1', title: 'Test', creatorId: 'c1' });
      mockPrisma.contribution.findMany.mockResolvedValue([{ investorId: 'i1' }]);

      const result = await service.processEvent(event);

      expect(result).toBe(true);
      expect(prisma.milestone.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: { status: 'REJECTED' }
      }));
      expect(notificationService.notify).toHaveBeenCalled();
    });

    it('should route FUNDS_RELEASED', async () => {
      const event = createMockParsedEvent({
        eventType: ContractEventType.FUNDS_RELEASED,
        data: { projectId: 'proj-1', milestoneId: 1, amount: '1000' },
      });

      mockPrisma.project.findUnique.mockResolvedValue({ id: 'proj-1' });

      const result = await service.processEvent(event);

      expect(result).toBe(true);
      expect(prisma.milestone.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'FUNDED' })
      }));
    });

    it('should route PROJECT_COMPLETED', async () => {
      const event = createMockParsedEvent({
        eventType: ContractEventType.PROJECT_COMPLETED,
        data: { projectId: 'proj-1' },
      });

      const result = await service.processEvent(event);

      expect(result).toBe(true);
      expect(prisma.project.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: { status: 'COMPLETED' }
      }));
    });

    it('should route PROJECT_FAILED', async () => {
      const event = createMockParsedEvent({
        eventType: ContractEventType.PROJECT_FAILED,
        data: { projectId: 'proj-1' },
      });

      const result = await service.processEvent(event);

      expect(result).toBe(true);
      expect(prisma.project.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: { status: 'CANCELLED' }
      }));
    });

    it('should return false if no handler exists', async () => {
      const event = createMockParsedEvent({
        eventType: 'UNKNOWN_EVENT' as any,
      });

      const result = await service.processEvent(event);

      expect(result).toBe(false);
    });

    it('should return false if validation fails', async () => {
      const event = createMockParsedEvent({
        eventType: ContractEventType.PROJECT_CREATED,
        data: {}, // Missing required fields
      });

      const result = await service.processEvent(event);

      expect(result).toBe(false);
    });
  });
});
