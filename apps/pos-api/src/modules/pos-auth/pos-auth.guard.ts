import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Provider,
  UnauthorizedException,
} from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
import type { Request } from "express";
import { and, eq, isNotNull, isNull, posDevicesTable, type db as Db } from "db";
import { setLogContext } from "logging";
import { DRIZZLE } from "../../database/database.constants";
import { IS_PUBLIC_KEY, type PosDeviceContext } from "./pos-auth.decorators";

const DEVICE_TOKEN_HEADER = "x-pos-device-token";
// don't write lastSeenAt on every request — once a minute is enough to tell
// "this device is alive" without a write per catalog scroll
const LAST_SEEN_THROTTLE_MS = 60 * 1000;

@Injectable()
export class PosDeviceGuard implements CanActivate {
  constructor(
    @Inject(DRIZZLE) private readonly db: typeof Db,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const token = request.headers[DEVICE_TOKEN_HEADER];
    if (!token || Array.isArray(token)) {
      throw new UnauthorizedException();
    }

    const [device] = await this.db
      .select()
      .from(posDevicesTable)
      .where(
        and(
          eq(posDevicesTable.token, token),
          isNull(posDevicesTable.revokedAt),
          isNotNull(posDevicesTable.pairedAt),
        ),
      );

    if (!device) {
      throw new UnauthorizedException();
    }

    const posDevice: PosDeviceContext = {
      deviceId: device.id,
      accountId: device.accountId,
      locationId: device.locationId,
    };
    (request as Request & { posDevice: PosDeviceContext }).posDevice =
      posDevice;
    setLogContext({
      deviceId: posDevice.deviceId,
      accountId: posDevice.accountId,
      locationId: posDevice.locationId,
    });

    const now = Date.now();
    if (
      !device.lastSeenAt ||
      now - device.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS
    ) {
      // best-effort — a failed heartbeat write shouldn't fail the request
      void (async () => {
        try {
          await this.db
            .update(posDevicesTable)
            .set({ lastSeenAt: new Date(now) })
            .where(eq(posDevicesTable.id, device.id));
        } catch {
          // ignore
        }
      })();
    }

    return true;
  }
}

export const POS_DEVICE_APP_GUARD: Provider = {
  provide: APP_GUARD,
  useClass: PosDeviceGuard,
};
