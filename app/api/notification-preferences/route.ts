import { getUserIdFromRequest } from '@/lib/auth';
import { createNotificationPreferencesHttpHandlers } from '@/lib/proactiveHealthHttp';
import { proactiveHealthRepository } from '@/lib/proactiveHealthRepository';

export const dynamic = 'force-dynamic';

const handlers = createNotificationPreferencesHttpHandlers({
  authenticate: getUserIdFromRequest,
  repository: proactiveHealthRepository,
});

export const { GET, PUT } = handlers;
