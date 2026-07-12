export type PushEnvironment = 'sandbox' | 'production';

export interface PushDeviceRegistration {
  installationId: string;
  token: string;
  environment: PushEnvironment;
}

export interface NotificationPreferences {
  morningBriefEnabled: boolean;
  morningBriefTimeMinutes: number;
  workoutNotificationsEnabled: boolean;
  sleepNotificationsEnabled: boolean;
  timezone: string;
}

export interface AnalysisRecord {
  id: string;
  userId: string;
  status: string;
  deletedAt: Date | null;
  date: string;
  result: unknown;
  createdAt: Date;
}

export type AnalysisKind = 'workout' | 'sleep';

export interface ProactiveHealthRepository {
  registerPushDevice(userId: string, device: PushDeviceRegistration): Promise<'registered' | 'conflict'>;
  invalidatePushDevice(userId: string, installationId: string): Promise<boolean>;
  getNotificationPreferences(userId: string): Promise<NotificationPreferences | null>;
  putNotificationPreferences(
    userId: string,
    preferences: NotificationPreferences,
  ): Promise<NotificationPreferences>;
  getAnalysis(kind: AnalysisKind, userId: string, id: string): Promise<AnalysisRecord | null>;
}

interface HttpDependencies {
  authenticate(request: Request): string;
  repository: ProactiveHealthRepository;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  morningBriefEnabled: true,
  morningBriefTimeMinutes: 450,
  workoutNotificationsEnabled: true,
  sleepNotificationsEnabled: true,
  timezone: 'UTC',
};

function authenticate(request: Request, dependencies: HttpDependencies): string | Response {
  try {
    return dependencies.authenticate(request);
  } catch {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }
}

async function jsonObject(request: Request): Promise<Record<string, unknown> | Response> {
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APNS_TOKEN_PATTERN = /^[0-9a-f]{64}$/i;

function uuid(value: unknown): string | null {
  const parsed = nonEmptyString(value);
  return parsed && UUID_PATTERN.test(parsed) ? parsed.toLowerCase() : null;
}

function parsePushDevice(body: Record<string, unknown>): PushDeviceRegistration | null {
  const installationId = uuid(body.installationId);
  const rawToken = nonEmptyString(body.token);
  const token = rawToken && APNS_TOKEN_PATTERN.test(rawToken) ? rawToken.toLowerCase() : null;
  const environment = body.environment;
  if (!installationId || !token || (environment !== 'sandbox' && environment !== 'production')) return null;
  return { installationId, token, environment };
}

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function parsePreferences(body: Record<string, unknown>): NotificationPreferences | null {
  const {
    morningBriefEnabled,
    morningBriefTimeMinutes,
    workoutNotificationsEnabled,
    sleepNotificationsEnabled,
    timezone,
  } = body;
  if (
    typeof morningBriefEnabled !== 'boolean'
    || !Number.isInteger(morningBriefTimeMinutes)
    || (morningBriefTimeMinutes as number) < 0
    || (morningBriefTimeMinutes as number) > 1439
    || typeof workoutNotificationsEnabled !== 'boolean'
    || typeof sleepNotificationsEnabled !== 'boolean'
    || typeof timezone !== 'string'
    || !isIanaTimezone(timezone)
  ) return null;
  return {
    morningBriefEnabled,
    morningBriefTimeMinutes: morningBriefTimeMinutes as number,
    workoutNotificationsEnabled,
    sleepNotificationsEnabled,
    timezone,
  };
}

export function createPushDevicesHttpHandlers(dependencies: HttpDependencies) {
  return {
    async POST(request: Request): Promise<Response> {
      const userId = authenticate(request, dependencies);
      if (userId instanceof Response) return userId;
      const body = await jsonObject(request);
      if (body instanceof Response) return body;
      const device = parsePushDevice(body);
      if (!device) return Response.json({ error: 'Invalid push device registration.' }, { status: 400 });
      const result = await dependencies.repository.registerPushDevice(userId, device);
      if (result === 'conflict') {
        return Response.json(
          { error: 'Device registration conflicts with another account.' },
          { status: 409 },
        );
      }
      return Response.json({ installationId: device.installationId, environment: device.environment });
    },

    async DELETE(request: Request): Promise<Response> {
      const userId = authenticate(request, dependencies);
      if (userId instanceof Response) return userId;
      const body = await jsonObject(request);
      if (body instanceof Response) return body;
      const installationId = uuid(body.installationId);
      if (!installationId) return Response.json({ error: 'installationId is required.' }, { status: 400 });
      await dependencies.repository.invalidatePushDevice(userId, installationId);
      return new Response(null, { status: 204 });
    },
  };
}

export function createNotificationPreferencesHttpHandlers(dependencies: HttpDependencies) {
  return {
    async GET(request: Request): Promise<Response> {
      const userId = authenticate(request, dependencies);
      if (userId instanceof Response) return userId;
      const preferences = await dependencies.repository.getNotificationPreferences(userId);
      return Response.json(preferences ?? DEFAULT_NOTIFICATION_PREFERENCES);
    },

    async PUT(request: Request): Promise<Response> {
      const userId = authenticate(request, dependencies);
      if (userId instanceof Response) return userId;
      const body = await jsonObject(request);
      if (body instanceof Response) return body;
      const preferences = parsePreferences(body);
      if (!preferences) return Response.json({ error: 'Invalid notification preferences.' }, { status: 400 });
      return Response.json(await dependencies.repository.putNotificationPreferences(userId, preferences));
    },
  };
}

export function createAnalysisHttpHandler(
  dependencies: HttpDependencies & { kind: AnalysisKind },
) {
  return {
    async GET(
      request: Request,
      context: { params: Promise<{ id: string }> },
    ): Promise<Response> {
      const userId = authenticate(request, dependencies);
      if (userId instanceof Response) return userId;
      const { id } = await context.params;
      const normalizedId = uuid(id);
      if (!normalizedId) return Response.json({ error: 'Invalid analysis id.' }, { status: 400 });
      const analysis = await dependencies.repository.getAnalysis(
        dependencies.kind,
        userId,
        normalizedId,
      );
      if (
        !analysis
        || analysis.userId !== userId
        || analysis.status !== 'ready'
        || analysis.deletedAt !== null
      ) return Response.json({ error: 'Analysis not found.' }, { status: 404 });
      return Response.json({
        id: analysis.id,
        date: analysis.date,
        result: analysis.result,
        createdAt: analysis.createdAt.toISOString(),
      });
    },
  };
}
