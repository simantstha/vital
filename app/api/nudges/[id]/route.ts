import { getUserIdFromRequest } from '@/lib/auth';
import { createNudgeHttpHandlers } from '@/lib/notificationInboxHttp';
import { notificationInboxRepository } from '@/lib/notificationInboxRepository';

export const dynamic = 'force-dynamic';

export const { GET } = createNudgeHttpHandlers({
  authenticate: getUserIdFromRequest,
  repository: notificationInboxRepository,
});
