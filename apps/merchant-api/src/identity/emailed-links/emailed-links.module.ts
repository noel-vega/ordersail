import { Module } from '@nestjs/common';
import { EmailedLinksService } from './emailed-links.service';

// Emailed links in a Nest module of its own, below everything that issues
// or redeems one: AuthModule (password reset, email verification) and
// UsersModule (Invites). A leaf by construction — it depends on the
// database and nothing else, and must stay that way, or the two modules
// that already import each other's neighbours gain a cycle through it.
@Module({
  providers: [EmailedLinksService],
  exports: [EmailedLinksService],
})
export class EmailedLinksModule {}
