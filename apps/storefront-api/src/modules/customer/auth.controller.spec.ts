import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

describe('AuthController', () => {
  let controller: AuthController;
  let service: {
    signup: jest.Mock;
    signin: jest.Mock;
    createRefreshToken: jest.Mock;
    refreshTokens: jest.Mock;
    logout: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      signup: jest.fn(),
      signin: jest.fn(),
      createRefreshToken: jest.fn(),
      refreshTokens: jest.fn(),
      logout: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: service }],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('signup returns both tokens in the response body', async () => {
    service.signup.mockResolvedValue({
      customerId: 1,
      email: 'a@b.test',
      accountId: 7,
      firstName: 'A',
      lastName: 'B',
      access_token: 'access-1',
    });
    service.createRefreshToken.mockResolvedValue('refresh-1');

    const result = await controller.signup(
      { firstName: 'A', lastName: 'B', email: 'a@b.test', password: 'x' },
      7,
    );

    expect(result).toEqual({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
    });
  });

  it('signin returns both tokens in the response body', async () => {
    service.signin.mockResolvedValue({
      customerId: 1,
      email: 'a@b.test',
      accountId: 7,
      firstName: 'A',
      lastName: 'B',
      access_token: 'access-2',
    });
    service.createRefreshToken.mockResolvedValue('refresh-2');

    const result = await controller.signin(
      { email: 'a@b.test', password: 'x' },
      7,
      undefined,
    );

    expect(result).toEqual({
      access_token: 'access-2',
      refresh_token: 'refresh-2',
    });
  });

  it('refreshToken passes the request-body refresh token to the service and returns the rotated pair', async () => {
    service.refreshTokens.mockResolvedValue({
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
    });

    const result = await controller.refreshToken({
      refresh_token: 'a-refresh-token',
    });

    expect(service.refreshTokens).toHaveBeenCalledWith('a-refresh-token');
    expect(result).toEqual({
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
    });
  });

  it('logout passes the request-body refresh token to the service', async () => {
    service.logout.mockResolvedValue(undefined);

    await controller.logout({ refresh_token: 'a-refresh-token' });

    expect(service.logout).toHaveBeenCalledWith('a-refresh-token');
  });
});
