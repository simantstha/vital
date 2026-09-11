import { getUserIdFromRequest } from '@/lib/auth';
import { createNotificationReadHttpHandlers } from '@/lib/notificationInboxHttp';
import { notificationInboxRepository } from '@/lib/notificationInboxRepository';

export const dynamic = 'force-dynamic';

export const { POST } = createNotificationReadHttpHandlers({
  authenticate: getUserIdFromRequest,
  repository: notificationInboxRepository,
});
