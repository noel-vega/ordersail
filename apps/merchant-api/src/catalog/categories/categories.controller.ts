import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { Category } from './entities/category.entity';
import { PaginatedCategories } from './entities/paginated-categories.entity';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from 'src/shared/auth/decorators';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Post()
  @RequirePermissions('products:write')
  @ApiBearerAuth('JWT-auth')
  @ApiCreatedResponse({ type: Category })
  create(
    @Body() createCategoryDto: CreateCategoryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.categoriesService.create(createCategoryDto, user.accountId);
  }

  @Get()
  @RequirePermissions('products:read')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: PaginatedCategories })
  @ApiQuery({ name: 'q', required: false, description: 'name match' })
  findAll(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @CurrentUser() user: AuthenticatedUser,
    @Query('q') q?: string,
  ) {
    return this.categoriesService.findAll(limit, offset, user.accountId, q);
  }

  @Patch(':id')
  @RequirePermissions('products:write')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: Category })
  async update(
    @Param('id') id: string,
    @Body() updateCategoryDto: UpdateCategoryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const category = await this.categoriesService.update(
      +id,
      updateCategoryDto,
      user.accountId,
    );
    if (!category) throw new NotFoundException();
    return category;
  }

  @Delete(':id')
  @RequirePermissions('products:write')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: Category })
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const category = await this.categoriesService.remove(+id, user.accountId);
    if (!category) throw new NotFoundException();
    return category;
  }
}
