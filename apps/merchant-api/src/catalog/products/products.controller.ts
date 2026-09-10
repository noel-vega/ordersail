import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  DefaultValuePipe,
  ParseEnumPipe,
  ParseIntPipe,
  Query,
  NotFoundException,
} from '@nestjs/common';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { CreateVariantsDto } from './dto/create-variant.dto';
import { UpdateProductOptionDto } from './dto/update-product-option.dto';
import { UpdateVariantDto } from './dto/update-variant.dto';
import { GetImageUploadUrlDto } from './dto/get-image-upload-url.dto';
import { CreateProductImageDto } from './dto/create-product-image.dto';
import { ReorderProductImagesDto } from './dto/reorder-product-images.dto';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { productStatusEnum } from 'db/catalog';
import { Product } from './entities/product.entity';
import { PaginatedProducts } from './entities/paginated-products.entity';
import type { ProductStatus } from './products.service';
import { ProductDetail } from './entities/product-detail.entity';
import { ProductVariant } from './entities/product-variant.entity';
import { ProductOption } from './entities/product-option.entity';
import { ProductImage } from './entities/product-image.entity';
import { ImageUploadUrl } from './entities/image-upload-url.entity';
import {
  CurrentUser,
  type AuthenticatedUser,
} from 'src/shared/auth/decorators';

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Post()
  @ApiBearerAuth('JWT-auth')
  @ApiCreatedResponse({ type: Product })
  create(
    @Body() createProductDto: CreateProductDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.productsService.create(createProductDto, user.accountId);
  }

  @Get()
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: PaginatedProducts })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'name or description match',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: productStatusEnum.enumValues,
  })
  findAll(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @CurrentUser() user: AuthenticatedUser,
    @Query('q') q?: string,
    @Query(
      'status',
      new ParseEnumPipe(productStatusEnum.enumValues, { optional: true }),
    )
    status?: ProductStatus,
  ) {
    return this.productsService.findAll(limit, offset, user.accountId, {
      q,
      status,
    });
  }

  @Get(':id')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: ProductDetail })
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.productsService.findOne(+id, user.accountId);
  }

  @Get(':id/variants')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: [ProductVariant] })
  findVariants(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.productsService.findVariants(+id, user.accountId);
  }

  @Get(':id/options')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: [ProductOption] })
  findOptions(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.productsService.findOptions(+id, user.accountId);
  }

  @Patch(':id/options/:optionId')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: ProductOption })
  updateOption(
    @Param('id') id: string,
    @Param('optionId') optionId: string,
    @Body() updateProductOptionDto: UpdateProductOptionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.productsService.updateOption(
      +id,
      +optionId,
      updateProductOptionDto,
      user.accountId,
    );
  }

  @Delete(':id/options/:optionId')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: ProductOption })
  removeOption(
    @Param('id') id: string,
    @Param('optionId') optionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.productsService.removeOption(+id, +optionId, user.accountId);
  }

  @Delete(':id/options/:optionId/values/:valueId')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: ProductOption })
  removeOptionValue(
    @Param('id') id: string,
    @Param('optionId') optionId: string,
    @Param('valueId') valueId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.productsService.removeOptionValue(
      +id,
      +optionId,
      +valueId,
      user.accountId,
    );
  }

  @Post(':id/variants')
  @ApiBearerAuth('JWT-auth')
  @ApiCreatedResponse({ type: [ProductVariant] })
  createVariants(
    @Param('id') id: string,
    @Body() createVariantsDto: CreateVariantsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.productsService.createVariants(
      +id,
      createVariantsDto,
      user.accountId,
    );
  }

  @Patch(':id')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: Product })
  update(
    @Param('id') id: string,
    @Body() updateProductDto: UpdateProductDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.productsService.update(+id, updateProductDto, user.accountId);
  }

  @Patch(':id/variants/:variantId')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: ProductVariant })
  updateVariant(
    @Param('id') id: string,
    @Param('variantId') variantId: string,
    @Body() updateVariantDto: UpdateVariantDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.productsService.updateVariant(
      +id,
      +variantId,
      updateVariantDto,
      user.accountId,
    );
  }

  @Delete(':id')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: Product })
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.productsService.remove(+id, user.accountId);
  }

  @Post(':id/images/upload-url')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: ImageUploadUrl })
  async getImageUploadUrl(
    @Param('id') id: string,
    @Body() dto: GetImageUploadUrlDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.productsService.getImageUploadUrl(
      +id,
      user.accountId,
      dto,
    );
    if (!result) throw new NotFoundException();
    return result;
  }

  @Post(':id/images')
  @ApiBearerAuth('JWT-auth')
  @ApiCreatedResponse({ type: ProductImage })
  async createImage(
    @Param('id') id: string,
    @Body() dto: CreateProductImageDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const image = await this.productsService.createImage(
      +id,
      user.accountId,
      dto,
    );
    if (!image) throw new NotFoundException();
    return image;
  }

  @Patch(':id/images/order')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: [ProductImage] })
  async reorderImages(
    @Param('id') id: string,
    @Body() dto: ReorderProductImagesDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const images = await this.productsService.reorderImages(
      +id,
      user.accountId,
      dto,
    );
    if (!images) throw new NotFoundException();
    return images;
  }

  @Delete(':id/images/:imageId')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: ProductImage })
  async removeImage(
    @Param('id') id: string,
    @Param('imageId') imageId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const image = await this.productsService.removeImage(
      +id,
      user.accountId,
      +imageId,
    );
    if (!image) throw new NotFoundException();
    return image;
  }
}
