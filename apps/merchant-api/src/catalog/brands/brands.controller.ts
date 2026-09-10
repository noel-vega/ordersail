import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { BrandsService } from './brands.service';
import { CreateBrandDto } from './dto/create-brand.dto';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { Brand } from './entities/brand.entity';
import { PaginatedBrands } from './entities/paginated-brands.entity';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from 'src/shared/auth/decorators';

@Controller('brands')
export class BrandsController {
  constructor(private readonly brandsService: BrandsService) {}

  @Post()
  @RequirePermissions('products:write')
  @ApiBearerAuth('JWT-auth')
  @ApiCreatedResponse({ type: Brand })
  create(
    @Body() createBrandDto: CreateBrandDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.brandsService.create(createBrandDto, user.accountId);
  }

  @Get()
  @RequirePermissions('products:read')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: PaginatedBrands })
  @ApiQuery({ name: 'q', required: false, description: 'name match' })
  findAll(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @CurrentUser() user: AuthenticatedUser,
    @Query('q') q?: string,
  ) {
    return this.brandsService.findAll(limit, offset, user.accountId, q);
  }
}
