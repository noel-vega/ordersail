import {
  Controller,
  DefaultValuePipe,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';
import { CartsService } from './carts.service';
import { PaginatedCarts } from './entities/paginated-carts.entity';
import { CartDetail } from './entities/cart-detail.entity';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from 'src/shared/auth/decorators';

@Controller('carts')
export class CartsController {
  constructor(private readonly cartsService: CartsService) {}

  @Get()
  @RequirePermissions('orders:read')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: PaginatedCarts })
  findAll(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.cartsService.findAll(limit, offset, user.accountId);
  }

  @Get(':id')
  @RequirePermissions('orders:read')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: CartDetail })
  async findOne(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const cart = await this.cartsService.findOne(+id, user.accountId);
    if (!cart) throw new NotFoundException();
    return cart;
  }
}
