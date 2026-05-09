import { MFPClient } from 'myfitnesspal';

export interface MFPMacros {
  calories: number;
  carbs: number;
  protein: number;
  fat: number;
  date: string;
}

// In-memory token cache (lives for the process lifetime)
let cachedClient: MFPClient | null = null;
let tokenExpiry = 0;

async function getClient(): Promise<MFPClient> {
  if (cachedClient && Date.now() < tokenExpiry) return cachedClient;

  const client = new MFPClient(
    process.env.MFP_USERNAME!,
    process.env.MFP_PASSWORD!,
  );
  await client.initialLoad();

  cachedClient = client;
  // expires_in is in seconds; back off 60s for safety
  const expiresIn = client.IDTokenResponse?.expires_in ?? 3600;
  tokenExpiry = Date.now() + expiresIn * 1000 - 60_000;
  return client;
}

async function getMFPUsername(token: string): Promise<string> {
  const res = await fetch('https://api.myfitnesspal.com/v2/me?fields[]=username', {
    headers: mfpHeaders(token),
  });
  const data = await res.json();
  const username = data?.data?.username ?? data?.username;
  if (!username) throw new Error(`Could not resolve MFP username: ${JSON.stringify(data)}`);
  return username;
}

function mfpHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'mfp-client-id': 'mfp-mobile-android-google',
    'User-Agent':
      'MyFitnessPal/22.19.0 (mfp-mobile-android-google) (Android 11; Google generic_x86_arm / google sdk_gphone_x86_arm; T-Mobile) (preload=false;locale=en_US;clientidbase=)',
    Accept: 'application/json',
  };
}

export async function getDiaryMacros(date: string): Promise<MFPMacros> {
  const client = await getClient();
  const token: string = client.IDTokenResponse.access_token;
  const username = await getMFPUsername(token);

  const res = await fetch(
    `https://api.myfitnesspal.com/v2/diary/${username}?date=${date}&fields[]=nutritional_contents`,
    { headers: mfpHeaders(token) },
  );
  const data = await res.json();

  // Sum all food entries for the day
  const items: unknown[] = data?.items ?? data?.data?.items ?? [];
  let calories = 0, carbs = 0, protein = 0, fat = 0;

  for (const item of items) {
    const nc = (item as Record<string, unknown>)?.nutritional_contents as Record<string, unknown> | undefined;
    if (!nc) continue;
    const energy = nc.energy as Record<string, number> | number | undefined;
    calories += typeof energy === 'object' && energy !== null ? energy.value : (energy ?? 0);
    carbs   += (nc.carbohydrates as number) ?? 0;
    protein += (nc.protein as number) ?? 0;
    fat     += (nc.fat as number) ?? 0;
  }

  return {
    calories: Math.round(calories),
    carbs: Math.round(carbs),
    protein: Math.round(protein),
    fat: Math.round(fat),
    date,
  };
}
