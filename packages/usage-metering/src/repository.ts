import type {
  IntelligenceUsageEvent,
  UsageBudgetPosition,
} from './index.ts';

export interface RecordIntelligenceUsageResult {
  readonly recorded: boolean;
  readonly event: IntelligenceUsageEvent;
}

export interface UsagePositionQuery {
  readonly tenantId: string;
  readonly organizationId: string | null;
  readonly currency: string;
  readonly period: string;
}

export interface IntelligenceUsageRepository {
  record(
    event: IntelligenceUsageEvent,
  ): Promise<RecordIntelligenceUsageResult>;
  monthlyPosition(
    query: UsagePositionQuery,
  ): Promise<UsageBudgetPosition>;
}
