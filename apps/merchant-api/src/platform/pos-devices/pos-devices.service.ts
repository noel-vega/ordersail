import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DRIZZLE } from 'src/shared/database/database.constants';
import {
  and,
  desc,
  eq,
  locationsTable,
  posDevicesTable,
  type db as Db,
} from 'db';
import { CreatePosDeviceDto } from './dto/create-pos-device.dto';
import { UpdatePosDeviceDto } from './dto/update-pos-device.dto';
import { PosDevice, PosDeviceStatus } from './entities/pos-device.entity';
import { PosDevicePairing } from './entities/pos-device-pairing.entity';
import { PAIRING_TTL_MS, generatePairingCode } from './pos-devices.util';
import { LOCATIONS_PORT, type LocationsPort } from './ports/locations.port';

type PosDeviceRow = typeof posDevicesTable.$inferSelect;

@Injectable()
export class PosDevicesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: typeof Db,
    @Inject(LOCATIONS_PORT) private readonly locations: LocationsPort,
  ) {}

  async create(
    dto: CreatePosDeviceDto,
    accountId: number,
    userId: number,
  ): Promise<PosDevicePairing> {
    await this.locations.assertAccountLocation(accountId, dto.locationId);

    const [device] = await this.db
      .insert(posDevicesTable)
      .values({
        accountId,
        locationId: dto.locationId,
        name: dto.name,
        createdByUserId: userId,
        pairingCode: generatePairingCode(),
        pairingExpiresAt: new Date(Date.now() + PAIRING_TTL_MS),
      })
      .returning();

    return this.toPairing(device);
  }

  async findAll(accountId: number): Promise<PosDevice[]> {
    const rows = await this.db
      .select({
        device: posDevicesTable,
        locationName: locationsTable.name,
      })
      .from(posDevicesTable)
      .leftJoin(
        locationsTable,
        eq(locationsTable.id, posDevicesTable.locationId),
      )
      .where(eq(posDevicesTable.accountId, accountId))
      .orderBy(desc(posDevicesTable.createdAt));

    return rows.map(({ device, locationName }) =>
      this.toEntity(device, locationName),
    );
  }

  async update(
    id: number,
    dto: UpdatePosDeviceDto,
    accountId: number,
  ): Promise<PosDevice> {
    await this.getOwnedOrThrow(id, accountId);

    if (dto.locationId !== undefined) {
      await this.locations.assertAccountLocation(accountId, dto.locationId);
    }

    if (dto.name !== undefined || dto.locationId !== undefined) {
      await this.db
        .update(posDevicesTable)
        .set({
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.locationId !== undefined
            ? { locationId: dto.locationId }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(posDevicesTable.id, id),
            eq(posDevicesTable.accountId, accountId),
          ),
        );
    }

    return this.findOneOrThrow(id, accountId);
  }

  async revoke(id: number, accountId: number): Promise<PosDevice> {
    await this.getOwnedOrThrow(id, accountId);

    await this.db
      .update(posDevicesTable)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(posDevicesTable.id, id),
          eq(posDevicesTable.accountId, accountId),
        ),
      );

    return this.findOneOrThrow(id, accountId);
  }

  async rotatePairing(
    id: number,
    accountId: number,
  ): Promise<PosDevicePairing> {
    const device = await this.getOwnedOrThrow(id, accountId);
    if (device.revokedAt) {
      throw new BadRequestException('Device is revoked');
    }
    if (device.pairedAt) {
      throw new BadRequestException('Device is already paired');
    }

    const [updated] = await this.db
      .update(posDevicesTable)
      .set({
        pairingCode: generatePairingCode(),
        pairingExpiresAt: new Date(Date.now() + PAIRING_TTL_MS),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(posDevicesTable.id, id),
          eq(posDevicesTable.accountId, accountId),
        ),
      )
      .returning();

    return this.toPairing(updated);
  }

  private async getOwnedOrThrow(
    id: number,
    accountId: number,
  ): Promise<PosDeviceRow> {
    const [device] = await this.db
      .select()
      .from(posDevicesTable)
      .where(
        and(
          eq(posDevicesTable.id, id),
          eq(posDevicesTable.accountId, accountId),
        ),
      );
    if (!device) {
      throw new NotFoundException();
    }
    return device;
  }

  private async findOneOrThrow(
    id: number,
    accountId: number,
  ): Promise<PosDevice> {
    const [row] = await this.db
      .select({
        device: posDevicesTable,
        locationName: locationsTable.name,
      })
      .from(posDevicesTable)
      .leftJoin(
        locationsTable,
        eq(locationsTable.id, posDevicesTable.locationId),
      )
      .where(
        and(
          eq(posDevicesTable.id, id),
          eq(posDevicesTable.accountId, accountId),
        ),
      );
    if (!row) {
      throw new NotFoundException();
    }
    return this.toEntity(row.device, row.locationName);
  }

  private toEntity(row: PosDeviceRow, locationName: string | null): PosDevice {
    return {
      id: row.id,
      name: row.name,
      locationId: row.locationId,
      locationName,
      status: this.statusOf(row),
      lastSeenAt: row.lastSeenAt,
      pairedAt: row.pairedAt,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
    };
  }

  private toPairing(row: PosDeviceRow): PosDevicePairing {
    return {
      id: row.id,
      name: row.name,
      locationId: row.locationId,
      pairingCode: row.pairingCode!,
      pairingExpiresAt: row.pairingExpiresAt!,
    };
  }

  private statusOf(row: PosDeviceRow): PosDeviceStatus {
    if (row.revokedAt) return 'revoked';
    if (row.pairedAt) return 'active';
    return 'pending';
  }
}
