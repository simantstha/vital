import { getUserIdFromRequest } from '@/lib/auth';
import { createPushDevicesHttpHandlers } from '@/lib/proactiveHealthHttp';
import { proactiveHealthRepository } from '@/lib/proactiveHealthRepository';

export const dynamic = 'force-dynamic';

const handlers = createPushDevicesHttpHandlers({
  authenticate: getUserIdFromRequest,
  repository: proactiveHealthRepository,
});

export const { POST, DELETE } = handlers;
