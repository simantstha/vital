import type { PushDeviceRegistration, PushEnvironment } from './proactiveHealthHttp';

export interface PushDeviceRow {
  id: string;
  userId: string;
  installationId: string;
  token: string;
  environment: string;
  invalidatedAt: Date | null;
  updatedAt: Date;
}

export interface PushDeviceTransaction {
  findByInstallationId(installationId: string): Promise<PushDeviceRow | null>;
  findByToken(token: string, environment: string): Promise<PushDeviceRow | null>;
  retire(row: PushDeviceRow, retiredToken: string, now: Date): Promise<void>;
  update(row: PushDeviceRow, token: string, environment: PushEnvironment, now: Date): Promise<void>;
  insert(
    userId: string,
    installationId: string,
    token: string,
    environment: PushEnvironment,
    now: Date,
  ): Promise<void>;
}

export type PushDeviceRegistrationResult = 'registered' | 'conflict';

function retiredToken(row: PushDeviceRow, now: Date): string {
  return `retired:${row.id}:${now.getTime()}`;
}

export async function reconcilePushDeviceRegistration(
  transaction: PushDeviceTransaction,
  userId: string,
  registration: PushDeviceRegistration,
  now: Date,
): Promise<PushDeviceRegistrationResult> {
  const installation = await transaction.findByInstallationId(registration.installationId);
  if (installation && installation.userId !== userId) return 'conflict';

  const tokenOwner = await transaction.findByToken(registration.token, registration.environment);
  if (tokenOwner && tokenOwner.userId !== userId) return 'conflict';

  if (tokenOwner && tokenOwner.id !== installation?.id) {
    await transaction.retire(tokenOwner, retiredToken(tokenOwner, now), now);
  }

  if (installation) {
    await transaction.update(installation, registration.token, registration.environment, now);
  } else {
    await transaction.insert(
      userId,
      registration.installationId,
      registration.token,
      registration.environment,
      now,
    );
  }
  return 'registered';
}
