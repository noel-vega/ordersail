import { env } from '../../env';

export const jwtConstants = {
  secret: env.CUSTOMER_JWT_SECRET,
};
