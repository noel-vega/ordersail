import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE } from 'src/shared/database/database.constants';
import {
  and,
  type db as Db,
  eq,
  isNotNull,
  locationsTable,
  productsTable,
  sql,
  stripeAccountsTable,
} from 'db';
import { OnboardingStatus } from './entities/onboarding-status.entity';

@Injectable()
export class OnboardingService {
  // platform is the one context allowed to read across domains (like
  // platform/dashboard) — see apps/merchant-api/ARCHITECTURE.md § Data access.
  constructor(@Inject(DRIZZLE) private readonly db: typeof Db) {}

  async getStatus(accountId: number): Promise<OnboardingStatus> {
    const [stripeRows, locationRows, productRows] = await Promise.all([
      this.db
        .select({ one: sql`1` })
        .from(stripeAccountsTable)
        .where(
          and(
            eq(stripeAccountsTable.accountId, accountId),
            eq(stripeAccountsTable.chargesEnabled, true),
          ),
        )
        .limit(1),
      // mirrors apps/storefront-api checkout.service.ts's ship-from lookup
      // (isNotNull(addressLine1)) but stricter — every field a real shipping
      // quote needs. addressState / addressLine2 stay optional.
      this.db
        .select({ one: sql`1` })
        .from(locationsTable)
        .where(
          and(
            eq(locationsTable.accountId, accountId),
            isNotNull(locationsTable.addressLine1),
            isNotNull(locationsTable.addressCity),
            isNotNull(locationsTable.addressPostalCode),
            isNotNull(locationsTable.addressCountry),
          ),
        )
        .limit(1),
      this.db
        .select({ one: sql`1` })
        .from(productsTable)
        .where(
          and(
            eq(productsTable.accountId, accountId),
            eq(productsTable.status, 'active'),
          ),
        )
        .limit(1),
    ]);

    const stripeConnected = stripeRows.length > 0;
    const hasCompleteLocation = locationRows.length > 0;
    const hasActiveProduct = productRows.length > 0;

    return {
      stripeConnected,
      hasCompleteLocation,
      hasActiveProduct,
      complete: stripeConnected && hasCompleteLocation && hasActiveProduct,
    };
  }
}
