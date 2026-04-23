import { setupTestApp, teardownTestApp, prisma } from './setup';
import { IndexerService } from '../src/indexer/services/indexer.service';
import { ContractEventType } from '../src/indexer/types/event-types';
import { createSorobanEvent } from './factories/event.factory';
import { SorobanRpc } from '@stellar/stellar-sdk';

describe('Indexer Pipeline (e2e)', () => {
  let indexerService: IndexerService;
  let mockRpcServer: any;

  beforeAll(async () => {
    await setupTestApp();
    indexerService = (global as any).app.get(IndexerService);
    
    // Get the mock instance
    mockRpcServer = (indexerService as any).rpc;
  });

  afterAll(async () => {
    await teardownTestApp();
  });

  beforeEach(async () => {
    // Clear DB between tests
    await (global as any).prisma.processedEvent.deleteMany();
    await (global as any).prisma.project.deleteMany();
    await (global as any).prisma.user.deleteMany();
    await (global as any).prisma.ledgerCursor.deleteMany();
    
    jest.clearAllMocks();
  });

  it('should index a PROJECT_CREATED event and store in DB', async () => {
    const contractId = 'CC' + Math.random().toString(36).substring(7).toUpperCase();
    const eventId = 'event-1';
    
    // 1. Prepare mock RPC response
    const mockEvent = createSorobanEvent(ContractEventType.PROJECT_CREATED, 'mock-xdr', {
      contractId,
      id: eventId,
      ledger: 1001,
    });

    // Mock parseEventData to return structured data
    // Since we're doing e2e, we'd normally let the real parseEvent run, 
    // but it's currently a stub in IndexerService.
    // Let's mock the internal parseEventData to return what we want for the test.
    jest.spyOn(indexerService as any, 'parseEventData').mockReturnValue({
      projectId: 1,
      creator: 'G-CREATOR',
      fundingGoal: '1000000',
      deadline: Math.floor(Date.now() / 1000) + 86400,
      token: 'XLM',
    });

    mockRpcServer.getLatestLedger.mockResolvedValue({ sequence: 1001 });
    mockRpcServer.getEvents.mockResolvedValue({
      events: [mockEvent],
      cursor: undefined,
    });

    // 2. Trigger poll
    await indexerService.pollEvents();

    // 3. Verify Database state
    const project = await (global as any).prisma.project.findUnique({
      where: { contractId: '1' }, // Based on our mock data mapping
    });

    expect(project).toBeDefined();
    expect(project.status).toBe('ACTIVE');

    const processed = await (global as any).prisma.processedEvent.findUnique({
      where: { eventId },
    });
    expect(processed).toBeDefined();
    expect(processed.ledgerSeq).toBe(1001);
  });

  it('should handle idempotency - processing same event twice', async () => {
    const eventId = 'idemp-1';
    const mockEvent = createSorobanEvent(ContractEventType.PROJECT_CREATED, 'mock-xdr', { id: eventId });

    jest.spyOn(indexerService as any, 'parseEventData').mockReturnValue({
      projectId: 2,
      creator: 'G-CREATOR',
      fundingGoal: '1000',
      deadline: Date.now(),
      token: 'XLM',
    });

    mockRpcServer.getLatestLedger.mockResolvedValue({ sequence: 1000 });
    mockRpcServer.getEvents.mockResolvedValue({ events: [mockEvent] });

    // Process first time
    await indexerService.pollEvents();
    
    // Process second time
    await indexerService.pollEvents();

    const count = await (global as any).prisma.processedEvent.count({
      where: { eventId },
    });
    expect(count).toBe(1);
  });

  it('should benchmark bulk event processing', async () => {
    const eventCount = 100;
    const events = [];
    for (let i = 0; i < eventCount; i++) {
      events.push(createSorobanEvent(ContractEventType.PROJECT_CREATED, 'xdr', { id: `bulk-${i}`, ledger: 1000 + i }));
    }

    jest.spyOn(indexerService as any, 'parseEventData').mockImplementation((_, type, id) => ({
      projectId: parseInt((id as string).split('-')[1]),
      creator: 'G-BULK',
      fundingGoal: '100',
      deadline: Date.now(),
      token: 'XLM',
    }));

    mockRpcServer.getLatestLedger.mockResolvedValue({ sequence: 1000 + eventCount });
    mockRpcServer.getEvents.mockResolvedValue({ events });

    const startTime = Date.now();
    await indexerService.pollEvents();
    const endTime = Date.now();

    const durationSeconds = (endTime - startTime) / 1000;
    const eventsPerSecond = eventCount / durationSeconds;

    console.log(`Benchmark: Processed ${eventCount} events in ${durationSeconds.toFixed(2)}s (${eventsPerSecond.toFixed(2)} events/sec)`);
    
    expect(eventsPerSecond).toBeGreaterThan(0);
  });
});
