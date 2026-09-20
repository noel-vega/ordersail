import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DRIZZLE } from 'src/shared/database/database.constants';
import {
  accountApiKeysTable,
  accountsTable,
  type db as Db,
  eq,
  usersTable,
} from 'db/identity';
import { locationsTable } from 'db/stock';
import * as bcrypt from 'bcryptjs';
import { generateApiKey } from '../api-keys/api-keys.util';
import { RolesService } from '../roles/roles.service';
import { UpdateAccountDto } from './dto/update-account.dto';

// Deliberately not auth's SignUpDto: this module sits underneath auth, and
// the DTO satisfies this structurally anyway.
export interface ProvisionAccountInput {
  businessName: string;
  phone: string;
  email: string;
  firstName: string;
  lastName: string;
  // plaintext — hashed here, so no caller can hand over an unhashed value
  // under a "hashed" name
  password: string;
}

@Injectable()
export class AccountService {
  constructor(
    @Inject(DRIZZLE) private readonly db: typeof Db,
    private readonly rolesService: RolesService,
  ) {}

  // Creates an Account with its first Owner — everything a new tenant needs
  // to be usable, in one transaction: the Account, its first API key, the
  // Default location, the first User, and the Owner Role assigned to them.
  // Starting a session for that User is the caller's business (see
  // AuthService.signup), as is translating the unique violation a duplicate
  // email raises.
  async provision(input: ProvisionAccountInput) {
    // hashed before the transaction opens, so a pooled connection isn't held
    // idle for the length of a bcrypt round
    const hashedPassword = await bcrypt.hash(input.password, 10);

    return this.db.transaction(async (tx) => {
      const [account] = await tx
        .insert(accountsTable)
        .values({
          name: input.businessName,
          phone: input.phone,
          email: input.email,
        })
        .returning();

      await tx.insert(accountApiKeysTable).values({
        accountId: account.id,
        key: generateApiKey(),
      });

      // products need somewhere to hold stock — every account starts
      // with a single seeded location, see locationsTable
      await tx.insert(locationsTable).values({
        accountId: account.id,
        name: 'Default',
      });

      const [owner] = await tx
        .insert(usersTable)
        .values({
          firstname: input.firstName,
          lastname: input.lastName,
          email: input.email,
          password: hashedPassword,
          accountId: account.id,
        })
        .returning();

      // every account starts with a non-deletable "Owner" role holding
      // every permission, assigned to the account's first user
      await this.rolesService.createSystemRole(tx, account.id, owner.id);

      return { account, owner };
    });
  }

  async findOne(accountId: number) {
    const [account] = await this.db
      .select()
      .from(accountsTable)
      .where(eq(accountsTable.id, accountId));
    if (!account) throw new NotFoundException();
    return account;
  }

  async update(accountId: number, dto: UpdateAccountDto) {
    const { requireMfa, ...rest } = dto;
    const [account] = await this.db
      .update(accountsTable)
      .set({
        ...rest,
        // undefined -> omitted from the update, leaving the column as-is
        ...(requireMfa !== undefined && {
          requireMfaAt: requireMfa ? new Date() : null,
        }),
        updatedAt: new Date(),
      })
      .where(eq(accountsTable.id, accountId))
      .returning();
    if (!account) throw new NotFoundException();
    return account;
  }
}
