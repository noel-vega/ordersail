import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiSecurity,
} from '@nestjs/swagger';
import { CategoriesService } from './categories.service';
import { ProductsService } from '../products/products.service';
import { ListCategoriesQueryDto } from './dto/list-categories-query.dto';
import { ListProductsQueryDto } from '../products/dto/list-products-query.dto';
import { PaginatedCategories } from './entities/paginated-categories.entity';
import { CategoryDetail } from './entities/category-detail.entity';
import { CurrentAccountId } from '../app-key/app-key.decorators';

@ApiSecurity('AppKey-auth')
@Controller('categories')
export class CategoriesController {
  constructor(
    private readonly categoriesService: CategoriesService,
    private readonly productsService: ProductsService,
  ) {}

  @Get()
  @ApiOkResponse({ type: PaginatedCategories })
  findAll(
    @Query() query: ListCategoriesQueryDto,
    @CurrentAccountId() accountId: number,
  ) {
    return this.categoriesService.findAll(query, accountId);
  }

  @Get(':id')
  @ApiOkResponse({ type: CategoryDetail })
  @ApiNotFoundResponse()
  async findOne(
    @Param('id') id: string,
    @Query() productsQuery: ListProductsQueryDto,
    @CurrentAccountId() accountId: number,
  ): Promise<CategoryDetail> {
    const category = await this.categoriesService.findOne(+id, accountId);
    if (!category) {
      throw new NotFoundException();
    }

    const products = await this.productsService.findAll(
      { ...productsQuery, categoryId: category.id },
      accountId,
    );
    return { ...category, products };
  }
}
