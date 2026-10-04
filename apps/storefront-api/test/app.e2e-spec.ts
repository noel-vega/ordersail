import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/configure-app';

describe('storefront-api (e2e)', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    configureApp(app);
    await app.init();
    // Fastify only accepts requests once its plugins have loaded
    await app.getHttpAdapter().getInstance().ready();
  });

  it('/v1/products (GET) without an app key is rejected', () => {
    return request(app.getHttpServer()).get('/v1/products').expect(401);
  });

  afterEach(async () => {
    await app.close();
  });
});
