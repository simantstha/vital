// MFP mobile-app OAuth, implemented directly.
// The `myfitnesspal` npm package used index[1] for the signing key, which is now
// algorithm "dir" (JWE). We pick the first HS* key (index 5 as of 2026-05).
// User ID flow: after auth we call /userinfo on the identity API to get both the
// MFP "domainUserId" (needed as mfp-user-id header) and the display username.

import jwt from 'jsonwebtoken';

export interface MFPMacros {
  calories: number;
  carbs: number;
  protein: number;
  fat: number;
  date: string;
  hasData: boolean; // false when no diary entries logged for the day
}

const IDENTITY_BASE = 'identity-api.myfitnesspal.com';
const API_BASE      = 'api.myfitnesspal.com';
const CLIENT_ID     = '1c70aed5-15c7-40a2-b4f0-a55ed1a5c43c';
const CLIENT_SECRET = '7xilqzoa2lqngjgi7vilqaqygq64cgbmc7pmsf4onvfelatb6vla';
const CALLBACK_URL  = 'mfp://identity/callback?code=';
const UA_IDENTITY   = 'Identity/ (build ) MYFITNESSPAL/22.19.0 Android/11 (API 30)';
const UA_API        = 'MyFitnessPal/22.19.0 (mfp-mobile-android-google) (Android 11; Google generic_x86_arm / google sdk_gphone_x86_arm; T-Mobile)';

interface Session {
  accessToken: string;
  mfpUserId: string;    // MFP legacy domain user ID (from accountLinks[].domainUserId)
  mfpUsername: string;  // display name (from profile.displayName)
  expiresAt: number;
}

let session: Session | null = null;

async function identityFetch(url: string, init: RequestInit) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, data: body, location: res.headers.get('location') };
}

async function authenticate(): Promise<Session> {
  const encodedAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const identityHeaders = { 'User-Agent': UA_IDENTITY, Accept: 'application/json' };

  // 1. Client keys — pick the HS* signing key
  const keysRes = await identityFetch(`https://${IDENTITY_BASE}/clientKeys`, {
    headers: { ...identityHeaders, Authorization: `Basic ${encodedAuth}` },
  });
  const keys: Array<{ key: { k: string; kid: string; alg: string } }> =
    keysRes.data?._embedded?.clientKeys ?? [];
  const sk = keys.find(k => /^HS/i.test(k.key.alg));
  if (!sk) throw new Error(`No HS* key found. Available algs: ${keys.map(k => k.key.alg).join(', ')}`);

  const secret = Buffer.from(sk.key.k, 'base64');

  // 2. Client-credentials token
  const atRes = await identityFetch(`https://${IDENTITY_BASE}/oauth/token`, {
    method: 'POST',
    headers: { ...identityHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials`,
  });
  const clientToken: string = atRes.data?.access_token;
  if (!clientToken) throw new Error('Failed to get client access token');

  // 3. Credential JWT + OAuth authorize
  const nonce = Math.floor(Math.random() * (586550506 - 100000000 + 1)) + 100000000;
  const credJwt = jwt.sign(
    { username: process.env.MFP_USERNAME, password: process.env.MFP_PASSWORD },
    secret,
    { algorithm: sk.key.alg as jwt.Algorithm, header: { alg: sk.key.alg, kid: sk.key.kid } } as jwt.SignOptions,
  );

  const authorizeRes = await fetch(`https://${IDENTITY_BASE}/oauth/authorize`, {
    method: 'POST',
    headers: { ...identityHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `client_id=${CLIENT_ID}&credentials=${credJwt}&nonce=${nonce}` +
          `&redirect_uri=mfp%3A%2F%2Fidentity%2Fcallback&response_type=code&scope=openid`,
    redirect: 'manual',
  });
  const location = authorizeRes.headers.get('location') ?? '';
  const code = location.split(CALLBACK_URL)[1];
  if (!code) throw new Error(`OAuth authorize failed — location: ${location}`);

  // 4. Exchange code for user tokens
  const tokenRes = await identityFetch(
    `https://${IDENTITY_BASE}/oauth/token?auto_create_account_link=false`,
    {
      method: 'POST',
      headers: { ...identityHeaders, 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${clientToken}` },
      body: `grant_type=authorization_code&code=${code}&redirect_uri=mfp%3A%2F%2Fidentity%2Fcallback`,
    },
  );
  const accessToken: string = tokenRes.data?.access_token;
  const expiresIn: number   = tokenRes.data?.expires_in ?? 3600;
  if (!accessToken) throw new Error(`Token exchange failed: ${JSON.stringify(tokenRes.data)}`);

  // 5. /userinfo → get MFP domain user ID + display username
  const userinfoRes = await identityFetch(`https://${IDENTITY_BASE}/userinfo`, {
    headers: { ...identityHeaders, Authorization: `Bearer ${accessToken}`, 'mfp-client-id': 'mfp-mobile-android-google' },
  });
  const mfpLink = (userinfoRes.data?.accountLinks ?? []).find(
    (l: { domain: string }) => l.domain === 'MFP',
  );
  const mfpUserId   = mfpLink?.domainUserId as string | undefined;
  const mfpUsername = userinfoRes.data?.profile?.displayName as string | undefined;
  if (!mfpUserId || !mfpUsername) {
    throw new Error(`Could not resolve MFP IDs from /userinfo: ${JSON.stringify(userinfoRes.data).substring(0, 200)}`);
  }

  return { accessToken, mfpUserId, mfpUsername, expiresAt: Date.now() + expiresIn * 1000 - 60_000 };
}

async function getSession(): Promise<Session> {
  if (session && Date.now() < session.expiresAt) return session;
  session = await authenticate();
  return session;
}

function apiHeaders(s: Session) {
  return {
    Authorization: `Bearer ${s.accessToken}`,
    'mfp-client-id': 'mfp-mobile-android-google',
    'mfp-user-id': s.mfpUserId,
    'User-Agent': UA_API,
    Accept: 'application/json',
  };
}

export async function getDiaryMacros(date: string): Promise<MFPMacros> {
  const s = await getSession();

  // No username in path — the API resolves the user from mfp-user-id header
  const res = await fetch(`https://${API_BASE}/v2/diary?date=${date}`, { headers: apiHeaders(s) });

  if (!res.ok) {
    return { calories: 0, carbs: 0, protein: 0, fat: 0, date, hasData: false };
  }

  const data = await res.json();
  // Only "diary_meal" items carry nutritional totals; skip exercise/steps entries
  const meals = ((data?.items ?? []) as Record<string, unknown>[]).filter(
    i => i.type === 'diary_meal',
  );

  let calories = 0, carbs = 0, protein = 0, fat = 0;
  for (const meal of meals) {
    const nc = meal.nutritional_contents as Record<string, unknown> | undefined;
    if (!nc) continue;
    const energy = nc.energy as Record<string, number> | undefined;
    calories += energy?.value ?? 0;
    carbs    += (nc.carbohydrates as number) ?? 0;
    protein  += (nc.protein      as number) ?? 0;
    fat      += (nc.fat          as number) ?? 0;
  }

  return {
    calories: Math.round(calories),
    carbs:    Math.round(carbs),
    protein:  Math.round(protein),
    fat:      Math.round(fat),
    date,
    hasData:  meals.length > 0,
  };
}
