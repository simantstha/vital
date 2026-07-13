import { getUserIdFromRequest } from '@/lib/auth';
import { createAnalysisHttpHandler } from '@/lib/proactiveHealthHttp';
import { proactiveHealthRepository } from '@/lib/proactiveHealthRepository';

export const dynamic = 'force-dynamic';

export const { GET } = createAnalysisHttpHandler({
  authenticate: getUserIdFromRequest,
  repository: proactiveHealthRepository,
  kind: 'sleep',
});
