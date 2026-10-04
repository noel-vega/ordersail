import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

const CART_TOKEN_HEADER = 'x-cart-token';

// there's no customer login yet, so a cart is identified purely by this
// opaque token — undefined means "no cart yet", which addItem treats as
// "create one"
export const CurrentCartToken = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest<FastifyRequest>();
    const token = request.headers[CART_TOKEN_HEADER];
    return typeof token === 'string' ? token : undefined;
  },
);
