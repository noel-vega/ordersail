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
import { BrandsService } from './brands.service';
import { ProductsService } from '../products/products.service';
import { ListBrandsQueryDto } from './dto/list-brands-query.dto';
import { ListProductsQueryDto } from '../products/dto/list-products-query.dto';
import { PaginatedBrands } from './entities/paginated-brands.entity';
import { BrandDetail } from './entities/brand-detail.entity';
import { CurrentAccountId } from '../app-key/app-key.decorators';

@ApiSecurity('AppKey-auth')
@Controller('brands')
export class BrandsController {
  constructor(
    private readonly brandsService: BrandsService,
    private readonly productsService: ProductsService,
  ) {}

  @Get()
  @ApiOkResponse({ type: PaginatedBrands })
  findAll(
    @Query() query: ListBrandsQueryDto,
    @CurrentAccountId() accountId: number,
  ) {
    return this.brandsService.findAll(query, accountId);
  }

  @Get(':id')
  @ApiOkResponse({ type: BrandDetail })
  @ApiNotFoundResponse()
  async findOne(
    @Param('id') id: string,
    @Query() productsQuery: ListProductsQueryDto,
    @CurrentAccountId() accountId: number,
  ): Promise<BrandDetail> {
    const brand = await this.brandsService.findOne(+id, accountId);
    if (!brand) {
      throw new NotFoundException();
    }

    const products = await this.productsService.findAll(
      { ...productsQuery, brandId: brand.id },
      accountId,
    );
    return { ...brand, products };
  }
}
