import { Module } from '@nestjs/common';
import {
  PrometheusModule,
  makeCounterProvider,
  makeHistogramProvider,
  makeGaugeProvider,
} from '@willsoto/nestjs-prometheus';
import { MetricsService } from './metrics.service';

@Module({
  imports: [
    PrometheusModule.register({
      path: '/metrics',
      defaultMetrics: { enabled: true },
    }),
  ],
  providers: [
    MetricsService,

    // HTTP metrics
    makeCounterProvider({ name: 'http_requests_total', help: 'Total HTTP requests', labelNames: ['method', 'route', 'status'] }),
    makeHistogramProvider({ name: 'http_request_duration_seconds', help: 'HTTP request duration', labelNames: ['method', 'route'], buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] }),

    // Error metrics
    makeCounterProvider({ name: 'errors_total', help: 'Total errors', labelNames: ['type', 'endpoint'] }),

    // Business metrics
    makeCounterProvider({ name: 'contributions_total', help: 'Total contributions processed', labelNames: ['status'] }),
    makeCounterProvider({ name: 'notifications_sent_total', help: 'Notifications sent', labelNames: ['type'] }),
    makeCounterProvider({ name: 'notifications_deduplicated_total', help: 'Notifications deduplicated', labelNames: ['type'] }),
    makeGaugeProvider({ name: 'active_projects_total', help: 'Currently active projects' }),
    makeGaugeProvider({ name: 'active_users_total', help: 'Currently active users' }),

    // Blockchain / indexer metrics
    makeGaugeProvider({ name: 'indexer_current_ledger', help: 'Current ledger being indexed' }),
    makeGaugeProvider({ name: 'indexer_network_ledger', help: 'Latest ledger on network' }),
    makeGaugeProvider({ name: 'indexer_lag_ledgers', help: 'Indexer lag in ledgers' }),
    makeCounterProvider({ name: 'blockchain_events_processed_total', help: 'Blockchain events processed', labelNames: ['event_type'] }),

    // WebSocket metrics
    makeGaugeProvider({ name: 'websocket_connections_active', help: 'Active WebSocket connections' }),

    // Cache metrics
    makeCounterProvider({ name: 'cache_hits_total', help: 'Cache hits', labelNames: ['cache'] }),
    makeCounterProvider({ name: 'cache_misses_total', help: 'Cache misses', labelNames: ['cache'] }),

    // DB metrics
    makeHistogramProvider({ name: 'db_query_duration_seconds', help: 'Database query duration', labelNames: ['operation'], buckets: [0.01, 0.05, 0.1, 0.5, 1, 5] }),
  ],
  exports: [MetricsService],
})
export class MetricsModule {}