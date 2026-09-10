import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  ParseEnumPipe,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { InventoryService } from './inventory.service';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { inventoryMovementReasonEnum } from 'db/stock';
import { InventoryMovementRecord } from './entities/inventory.entity';
import {
  PaginatedInventory,
  PaginatedInventoryMovements,
} from './entities/paginated-inventory.entity';
import { CreateInventoryMovementDto } from './dto/create-inventory-movement.dto';
import {
  CurrentUser,
  type AuthenticatedUser,
} from 'src/shared/auth/decorators';

type MovementReason = (typeof inventoryMovementReasonEnum.enumValues)[number];

@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get()
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: PaginatedInventory })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'SKU or product name match',
  })
  @ApiQuery({ name: 'productId', required: false, type: Number })
  @ApiQuery({ name: 'locationId', required: false, type: Number })
  @ApiQuery({
    name: 'stockLte',
    required: false,
    type: Number,
    description: 'only rows at or below this on-hand quantity',
  })
  findAll(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @CurrentUser() user: AuthenticatedUser,
    @Query('q') q?: string,
    @Query('productId', new ParseIntPipe({ optional: true }))
    productId?: number,
    @Query('locationId', new ParseIntPipe({ optional: true }))
    locationId?: number,
    @Query('stockLte', new ParseIntPipe({ optional: true }))
    stockLte?: number,
  ) {
    return this.inventoryService.findAll(limit, offset, user.accountId, {
      q,
      productId,
      locationId,
      stockLte,
    });
  }

  @Post('movements')
  @ApiBearerAuth('JWT-auth')
  @ApiCreatedResponse({ type: InventoryMovementRecord })
  createMovement(
    @Body() createInventoryMovementDto: CreateInventoryMovementDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.inventoryService.createMovement(
      createInventoryMovementDto,
      user.sub,
      user.accountId,
    );
  }

  @Get('movements')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: PaginatedInventoryMovements })
  @ApiQuery({ name: 'variantId', required: false, type: Number })
  @ApiQuery({ name: 'locationId', required: false, type: Number })
  @ApiQuery({
    name: 'reason',
    required: false,
    enum: inventoryMovementReasonEnum.enumValues,
  })
  findMovements(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @CurrentUser() user: AuthenticatedUser,
    @Query('variantId', new ParseIntPipe({ optional: true }))
    variantId?: number,
    @Query('locationId', new ParseIntPipe({ optional: true }))
    locationId?: number,
    @Query(
      'reason',
      new ParseEnumPipe(inventoryMovementReasonEnum.enumValues, {
        optional: true,
      }),
    )
    reason?: MovementReason,
  ) {
    return this.inventoryService.findMovements(limit, offset, user.accountId, {
      variantId,
      locationId,
      reason,
    });
  }
}
