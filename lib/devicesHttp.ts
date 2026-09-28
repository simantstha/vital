/**
 * GET/PATCH /api/devices — the Devices settings screen (phase 2 "both
 * devices" contract, PR A). Thin HTTP layer: validation + shaping only; the
 * device-resolution logic lives in lib/devicesContext.ts, the DB reads/writes
 * in lib/devicesRepository.ts.
 */

import { parseDevicePatch, resolvePrimaryDevices, type DevicePreferences } from './devicesContext';

export interface DeviceStatus {
  connected: boolean;
  lastSyncAt: Date | null;
}

export interface DevicesState {
  apple: DeviceStatus;
  whoop: DeviceStatus;
  explicit: DevicePreferences;
  mergedThisMonth: number;
}

export interface DevicesRepository {
  getDevicesState(userId: string): Promise<DevicesState>;
  updateDevicePreferences(userId: string, update: Partial<DevicePreferences>): Promise<DevicePreferences>;
}

interface HttpDependencies {
  authenticate(request: Request): string;
  repository: DevicesRepository;
}

function authenticate(request: Request, dependencies: HttpDependencies): string | Response {
  try {
    return dependencies.authenticate(request);
  } catch {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }
}

function devicesResponseBody(state: DevicesState) {
  const primary = resolvePrimaryDevices(state.explicit, state.whoop.connected);
  return {
    devices: [
      { id: 'apple' as const, connected: state.apple.connected, lastSyncAt: state.apple.lastSyncAt?.toISOString() ?? null },
      { id: 'whoop' as const, connected: state.whoop.connected, lastSyncAt: state.whoop.lastSyncAt?.toISOString() ?? null },
    ],
    primary,
    explicit: state.explicit,
    mergedThisMonth: state.mergedThisMonth,
  };
}

export function createDevicesHttpHandlers(dependencies: HttpDependencies) {
  return {
    async GET(request: Request): Promise<Response> {
      const userId = authenticate(request, dependencies);
      if (userId instanceof Response) return userId;
      const state = await dependencies.repository.getDevicesState(userId);
      return Response.json(devicesResponseBody(state));
    },

    async PATCH(request: Request): Promise<Response> {
      const userId = authenticate(request, dependencies);
      if (userId instanceof Response) return userId;

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
      }

      const update = parseDevicePatch(body);
      if (!update) {
        return Response.json({ error: "Body must be { primary: { workouts?, sleep?, recovery? } }, each 'apple' | 'whoop' | null." }, { status: 400 });
      }

      await dependencies.repository.updateDevicePreferences(userId, update);
      const state = await dependencies.repository.getDevicesState(userId);
      return Response.json(devicesResponseBody(state));
    },
  };
}
