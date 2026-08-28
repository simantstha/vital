export const RUNNING_COACH_TOOL_ALLOWLIST = [
  'get_metric_trend',
  'get_sleep_summary',
  'get_workouts',
  'get_baseline',
  'compare_periods',
  'propose_fact',
  'confirm_fact',
] as const;

export const NUTRITIONIST_TOOL_ALLOWLIST = [
  'query_events',
  'calculate_macros',
  'log_meal',
  'update_diet_budget',
  'get_metric_trend',
  'get_baseline',
  'propose_fact',
  'confirm_fact',
] as const;

export const STRENGTH_COACH_TOOL_ALLOWLIST = [
  'get_workouts',
  'get_metric_trend',
  'get_sleep_summary',
  'get_baseline',
  'compare_periods',
  'query_events',
  'get_schedule',
  'propose_fact',
  'confirm_fact',
] as const;

export type SpecialistId = 'running-coach' | 'nutritionist' | 'strength-coach';

export interface SpecialistPromptModule {
  id: 'running' | 'recovery' | 'nutrition' | 'diet-budget' | 'strength' | 'programming';
  prompt: string;
}

export interface SpecialistManifest {
  id: SpecialistId;
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

export function assertValidSpecialistManifest(
  manifest: Omit<SpecialistManifest, 'accentColor'> & { accentColor: string },
): asserts manifest is SpecialistManifest {
  if (!/^#[0-9A-F]{6}$/i.test(manifest.accentColor)) {
    throw new Error(`Invalid specialist accent color: ${manifest.accentColor}`);
  }
  if (manifest.promptModules.length === 0) {
    throw new Error('Specialist manifest must include at least one prompt module');
  }
  if (new Set(manifest.allowedTools).size !== manifest.allowedTools.length) {
    throw new Error('Specialist manifest contains a duplicate tool');
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error(`Invalid specialist manifest version: ${manifest.version}`);
  }
}

interface SpecialistEnvironment {
  SPECIALIST_MODEL?: string;
}

type SpecialistDefinition = Omit<SpecialistManifest, 'model'>;

const SPECIALIST_DEFINITIONS: Record<SpecialistId, SpecialistDefinition> = {
  'running-coach': {
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
  },
  nutritionist: {
    id: 'nutritionist',
    version: '1.0.0',
    name: 'Nutritionist',
    role: 'Vital Specialist',
    accentColor: '#57CC99',
    icon: 'fork.knife',
    triggerDescription:
      'Use for meal planning, calorie and macro targets, diet budget adjustments, and food logging guidance grounded in Vital health data.',
    promptModules: [
      {
        id: 'nutrition',
        prompt:
          'Ground meal and macro guidance in calculate_macros output and the athlete’s training load and recovery data; never estimate targets from memory.',
      },
      {
        id: 'diet-budget',
        prompt:
          'The Diet Budget shown in context is the source of truth for calorie and macro targets. Propose the specific change and get the user’s explicit agreement first, THEN call update_diet_budget. Never change it silently.',
      },
    ],
    allowedTools: NUTRITIONIST_TOOL_ALLOWLIST,
  },
  'strength-coach': {
    id: 'strength-coach',
    version: '1.0.0',
    name: 'Strength Coach',
    role: 'Vital Specialist',
    accentColor: '#F4A261',
    icon: 'dumbbell.fill',
    triggerDescription:
      'Use for strength training programming, lifting structure, and resistance workout guidance grounded in Vital health data.',
    promptModules: [
      {
        id: 'strength',
        prompt:
          'The database stores no sets, reps, or load. Strength work is visible only as generic workout_completed events (type, duration, heart rate, calories). Never claim to know the athlete’s lift history or invent past loads.',
      },
      {
        id: 'programming',
        prompt:
          'Advise on programming principles — progressive overload, recovery-driven load management, and session structure — grounded in recovery signals and workout frequency, not assumed strength numbers.',
      },
    ],
    allowedTools: STRENGTH_COACH_TOOL_ALLOWLIST,
  },
};

export class SpecialistRegistry {
  constructor(
    private readonly environment: SpecialistEnvironment = {
      SPECIALIST_MODEL: process.env.SPECIALIST_MODEL,
    },
  ) {}

  list(): SpecialistManifest[] {
    return (Object.keys(SPECIALIST_DEFINITIONS) as SpecialistId[]).map((id) => this.build(id));
  }

  get(id: string): SpecialistManifest {
    if (!Object.prototype.hasOwnProperty.call(SPECIALIST_DEFINITIONS, id)) {
      throw new Error(`Unknown specialist: ${id}`);
    }
    return this.build(id as SpecialistId);
  }

  private build(id: SpecialistId): SpecialistManifest {
    const model = this.environment.SPECIALIST_MODEL;
    if (!model) {
      throw new Error('SPECIALIST_MODEL must be configured before loading a specialist');
    }
    const manifest = { ...SPECIALIST_DEFINITIONS[id], model };
    assertValidSpecialistManifest(manifest);
    return manifest;
  }
}

export const specialistRegistry = new SpecialistRegistry();
