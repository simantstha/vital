export const RUNNING_COACH_TOOL_ALLOWLIST = [
  'get_metric_trend',
  'get_sleep_summary',
  'get_workouts',
  'get_baseline',
  'compare_periods',
  'remember_fact',
  'confirm_fact',
] as const;

export interface SpecialistPromptModule {
  id: 'running' | 'recovery';
  prompt: string;
}

export interface SpecialistManifest {
  id: 'running-coach';
  version: string;
  name: string;
  role: string;
  accentColor: `#${string}`;
  icon: string;
  triggerDescription: string;
  promptModules: readonly SpecialistPromptModule[];
  allowedTools: readonly string[];
  model: string;
}

interface SpecialistEnvironment {
  SPECIALIST_MODEL?: string;
}

const RUNNING_COACH_DEFINITION = {
  id: 'running-coach',
  version: '1.0.0',
  name: 'Running Coach',
  role: 'Vital Specialist',
  accentColor: '#4CC9F0',
  icon: 'figure.run',
  triggerDescription:
    'Use for running plans, workout progression, race preparation, and recovery guidance grounded in Vital health data.',
  promptModules: [
    {
      id: 'running',
      prompt:
        'Coach running with progressive load, clear workout purpose, realistic pacing, and respect for the athlete’s current history.',
    },
    {
      id: 'recovery',
      prompt:
        'Ground recovery guidance in the user’s sleep, baseline, and metric trends; reduce load when the evidence supports it.',
    },
  ],
  allowedTools: RUNNING_COACH_TOOL_ALLOWLIST,
} as const;

export class SpecialistRegistry {
  constructor(
    private readonly environment: SpecialistEnvironment = {
      SPECIALIST_MODEL: process.env.SPECIALIST_MODEL,
    },
  ) {}

  list(): SpecialistManifest[] {
    return [this.runningCoach()];
  }

  get(id: string): SpecialistManifest {
    if (id !== RUNNING_COACH_DEFINITION.id) {
      throw new Error(`Unknown specialist: ${id}`);
    }
    return this.runningCoach();
  }

  private runningCoach(): SpecialistManifest {
    const model = this.environment.SPECIALIST_MODEL;
    if (!model) {
      throw new Error('SPECIALIST_MODEL must be configured before loading a specialist');
    }
    return { ...RUNNING_COACH_DEFINITION, model };
  }
}

export const specialistRegistry = new SpecialistRegistry();
