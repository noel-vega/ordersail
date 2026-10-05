import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ApiException } from 'errors';
import { Customer } from './entities/customer.entity';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { DRIZZLE } from '../../database/database.constants';
import { customersTable, and, eq, type db as Db } from 'db';

const POSTGRES_UNIQUE_VIOLATION = '23505';

// node-postgres errors carry `.code`, but drizzle-orm wraps them in a
// DrizzleQueryError, so the pg error ends up at `.cause` instead — same
// unwrap merchant-api's auth/users services use for the same kind of
// unique constraint
function isUniqueViolation(err: unknown): boolean {
  const pgError =
    typeof err === 'object' && err !== null && 'cause' in err ? err.cause : err;
  return (
    typeof pgError === 'object' &&
    pgError !== null &&
    'code' in pgError &&
    pgError.code === POSTGRES_UNIQUE_VIOLATION
  );
}

function toCustomer(row: typeof customersTable.$inferSelect): Customer {
  return {
    id: row.id,
    accountId: row.accountId,
    firstName: row.firstname,
    lastName: row.lastname,
    email: row.email,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class CustomerService {
  constructor(@Inject(DRIZZLE) private readonly db: typeof Db) {}

  // raw row (includes password hash) — used by AuthService for signin, not
  // exposed outside the auth flow
  async getByEmail(accountId: number, email: string) {
    const [customer] = await this.db
      .select()
      .from(customersTable)
      .where(
        and(
          eq(customersTable.accountId, accountId),
          eq(customersTable.email, email),
        ),
      );

    return customer;
  }

  // also returns the raw row — AuthService needs the id/email/accountId to
  // build the JWT payload right after signup
  async create(
    dto: { firstName: string; lastName: string; email: string },
    hashedPassword: string,
    accountId: number,
  ) {
    try {
      const [customer] = await this.db
        .insert(customersTable)
        .values({
          firstname: dto.firstName,
          lastname: dto.lastName,
          email: dto.email,
          password: hashedPassword,
          accountId,
        })
        .returning();

      return customer;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ApiException('email_taken', { param: 'email' });
      }
      throw err;
    }
  }

  async findOne(id: number): Promise<Customer> {
    const [row] = await this.db
      .select()
      .from(customersTable)
      .where(eq(customersTable.id, id));

    if (!row) throw new NotFoundException();
    return toCustomer(row);
  }

  async update(id: number, dto: UpdateCustomerDto): Promise<Customer> {
    try {
      const [row] = await this.db
        .update(customersTable)
        .set({
          firstname: dto.firstName,
          lastname: dto.lastName,
          email: dto.email,
          updatedAt: new Date(),
        })
        .where(eq(customersTable.id, id))
        .returning();

      if (!row) throw new NotFoundException();
      return toCustomer(row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ApiException('email_taken', { param: 'email' });
      }
      throw err;
    }
  }
}
