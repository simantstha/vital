import { getUserIdFromRequest } from '@/lib/auth';
import { createNotificationInboxHttpHandlers } from '@/lib/notificationInboxHttp';
import { notificationInboxRepository } from '@/lib/notificationInboxRepository';

export const dynamic = 'force-dynamic';

export const { GET } = createNotificationInboxHttpHandlers({
  authenticate: getUserIdFromRequest,
  repository: notificationInboxRepository,
});
