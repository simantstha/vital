import { getUserIdFromRequest } from '@/lib/auth';
import { createDevicesHttpHandlers } from '@/lib/devicesHttp';
import { devicesRepository } from '@/lib/devicesRepository';

export const dynamic = 'force-dynamic';

const handlers = createDevicesHttpHandlers({
  authenticate: getUserIdFromRequest,
  repository: devicesRepository,
});

export const { GET, PATCH } = handlers;
