import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CustomerService } from './customer.service';
import { CustomerController } from './customer.controller';
import { CustomerOrdersController } from './orders/customer-orders.controller';
import { CustomerOrdersService } from './orders/customer-orders.service';
import { CustomerAuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { jwtConstants } from './auth.constants';
import { CartModule } from '../cart/cart.module';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [
    CartModule,
    EmailModule,
    JwtModule.register({
      global: true,
      secret: jwtConstants.secret,
      signOptions: { expiresIn: '60s' },
    }),
  ],
  controllers: [CustomerController, CustomerOrdersController, AuthController],
  providers: [
    CustomerService,
    CustomerOrdersService,
    CustomerAuthGuard,
    AuthService,
  ],
  exports: [CustomerService],
})
export class CustomerModule {}
