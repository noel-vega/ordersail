import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { Public, NoMfaFactorRequired } from 'src/shared/auth/decorators';

@Controller()
@NoMfaFactorRequired()
export class AppController {
  constructor(private readonly appService: AppService) {}

  // the global AuthGuard would otherwise 401 this unauthenticated root ping
  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
