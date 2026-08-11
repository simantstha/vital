export const COACH_WORKSPACE_DISABLED_RESPONSE = {
  error: 'Coach Workspace is disabled.',
  code: 'COACH_WORKSPACE_DISABLED',
} as const;

export const COACH_WORKSPACE_DISABLED_STATUS = 404;

export function isCoachWorkspaceEnabled(
  environment: { COACH_WORKSPACE_V1?: string } = {
    COACH_WORKSPACE_V1: process.env.COACH_WORKSPACE_V1,
  },
): boolean {
  return environment.COACH_WORKSPACE_V1 === 'true';
}
