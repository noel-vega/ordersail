import { Module } from '@nestjs/common';
import { QueuesModule } from '../../queues.module';
import { EmailProcessor } from './email.processor';
import { MailerService } from './mailer.service';

@Module({
  imports: [QueuesModule],
  providers: [EmailProcessor, MailerService],
  // exported so HealthModule can query the same singleton instance's
  // isRunning()/lastActiveAt — see EmailProcessor.getLiveness()
  exports: [EmailProcessor],
})
export class EmailModule {}
