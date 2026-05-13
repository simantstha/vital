import Anthropic from '@anthropic-ai/sdk';
import { getCachedBrief } from '@/lib/briefCache';
import { readUserProfile } from '@/lib/claude';
import { readCoachState, writeMealOverride, writePendingBarcode, clearPendingBarcode, type MealOverride, type PendingBarcode } from '@/lib/coachState';
import { logWeight, readWeightLog } from '@/lib/weightLog';
import { lookupBarcode } from '@/lib/openFoodFacts';
import { getDiaryMacros } from '@/lib/mfp';

const client = new Anthropic();

// ── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(userProfile: string, healthCtx: string): string {
  return `You are Vital Coach — personal AI coach for a marathon runner training for the Twin Cities Marathon (October 4, 2026).
You're responding via Telegram. Keep answers SHORT and direct (under 120 words) unless the user asks for detail.

ACTIONS — append these at the very end of your response, NEVER display them to the user:
- If user reports eating something not in the plan:
  <vital-action type="meal_override" meal="MEAL_KEY" kcal="N" c="N" p="N" f="N" items="..." reason="..."/>
  MEAL_KEY must be one of: breakfast, lunch, snack, dinner
- If user logs their weight:
  <vital-action type="weight_log" weight="N" unit="lbs"/>
Only append an action when clearly triggered. Never preemptively.

## Long-term User Profile
${userProfile}

${healthCtx}`;
}

// ── Health context from cache + live MFP ────────────────────────────────────

async function buildHealthContext(): Promise<string> {
  const brief = getCachedBrief();
  const state = readCoachState();
  const weights = readWeightLog().slice(-7);
  const today = new Date().toISOString().split('T')[0];

  let ctx = '';

  if (brief) {
    ctx += `## Today's Brief\n${brief.body}\n\n`;
    ctx += `## Today's Meal Plan\n`;
    for (const meal of brief.meals) {
      const override = state.mealOverrides.find(o => o.meal === meal.k.toLowerCase());
      if (override) {
        ctx += `${meal.k} at ${meal.t}: ${override.items} — ${override.kcal}kcal [ADJUSTED via chat]\n`;
      } else {
        ctx += `${meal.k} at ${meal.t}: ${meal.items} — ${meal.kcal}kcal (${meal.c}g C/${meal.p}g P/${meal.f}g F)\n`;
      }
    }
  } else {
    ctx += `## Brief\nNo brief generated yet today.\n`;
  }

  // Live MFP diary — what was actually logged
  try {
    const mfp = await getDiaryMacros(today);
    if (mfp.hasData) {
      ctx += `\n## MyFitnessPal (actually logged today)\n`;
      ctx += `Calories: ${mfp.calories} kcal · Carbs: ${mfp.carbs}g · Protein: ${mfp.protein}g · Fat: ${mfp.fat}g\n`;
    } else {
      ctx += `\n## MyFitnessPal\nNo diary entries logged yet today.\n`;
    }
  } catch {
    ctx += `\n## MyFitnessPal\nUnavailable right now.\n`;
  }

  if (weights.length > 0) {
    ctx += `\n## Recent Weight Log (last ${weights.length} entries)\n`;
    for (const w of weights) ctx += `${w.date}: ${w.weight}${w.unit}\n`;
  }

  return ctx;
}

// ── vital-action parser ──────────────────────────────────────────────────────

function stripAction(text: string): string {
  return text.replace(/<vital-action[^>]*\/>/g, '').trim();
}

interface ParsedAction {
  type: 'meal_override' | 'weight_log';
  [key: string]: string | number;
}

function parseAction(text: string): ParsedAction | null {
  const match = /<vital-action([^>]*)\/>/.exec(text);
  if (!match) return null;
  const attrs: Record<string, string> = {};
  const attrRe = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = attrRe.exec(match[1])) !== null) attrs[m[1]] = m[2];
  if (!attrs.type) return null;
  return attrs as unknown as ParsedAction;
}

// ── Barcode image classification ─────────────────────────────────────────────

async function classifyImage(base64: string, mimeType: string): Promise<
  | { type: 'barcode'; value: string }
  | { type: 'meal' }
> {
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 100,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType as 'image/jpeg', data: base64 } },
        { type: 'text', text: 'Is this image a barcode/product label, or a prepared meal/food? If barcode, extract the numeric barcode value. Reply with JSON only: {"type":"barcode","value":"..."} or {"type":"meal"}' },
      ],
    }],
  });

  try {
    const content = (msg.content[0] as { text: string }).text;
    const json = JSON.parse(content.replace(/```json\n?|```/g, '').trim()) as { type: string; value?: string };
    if (json.type === 'barcode' && json.value) return { type: 'barcode', value: json.value };
  } catch { /* fall through */ }
  return { type: 'meal' };
}

// ── Quantity resolver (pending barcode → macro calc) ─────────────────────────

export async function resolveQuantity(pending: PendingBarcode, quantityText: string): Promise<string> {
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `Product: ${pending.productName}${pending.brand ? ` (${pending.brand})` : ''}\nNutrition per 100g: ${pending.per100g.kcal}kcal, ${pending.per100g.c}g carbs, ${pending.per100g.p}g protein, ${pending.per100g.f}g fat\n\nUser says they had: "${quantityText}"\n\nCalculate the macros for that quantity and reply with JSON only:\n{"grams":N,"kcal":N,"c":N,"p":N,"f":N,"summary":"short description"}\n\nIf you can't determine grams, use a reasonable standard serving estimate.`,
    }],
  });

  try {
    const content = (msg.content[0] as { text: string }).text;
    const calc = JSON.parse(content.replace(/```json\n?|```/g, '').trim()) as {
      grams: number; kcal: number; c: number; p: number; f: number; summary: string;
    };

    const hour = new Date().getHours();
    const meal = hour < 10 ? 'breakfast' : hour < 14 ? 'lunch' : hour < 17 ? 'snack' : 'dinner';

    const override: MealOverride = {
      meal,
      kcal: Math.round(calc.kcal),
      c: Math.round(calc.c),
      p: Math.round(calc.p),
      f: Math.round(calc.f),
      items: `${pending.productName} — ${calc.summary}`,
      reason: `barcode scan`,
      updatedAt: new Date().toISOString(),
    };
    writeMealOverride(override);
    clearPendingBarcode();

    return `Logged: ${pending.productName} (${calc.grams}g) — ${Math.round(calc.kcal)} kcal, ${Math.round(calc.c)}g carbs, ${Math.round(calc.p)}g protein, ${Math.round(calc.f)}g fat. Added to your ${meal}.`;
  } catch {
    clearPendingBarcode();
    return `Got it — logged ${pending.productName} as your meal. Couldn't parse exact quantity, but it's noted.`;
  }
}

// ── Main entry point ─────────────────────────────────────────────────────────

export async function processMessage(
  text: string,
  chatId: number,
  image?: { base64: string; mimeType: string },
): Promise<string> {
  const userProfile = readUserProfile();
  const healthCtx = await buildHealthContext();
  const systemPrompt = buildSystemPrompt(userProfile, healthCtx);

  let userContent: Anthropic.MessageParam['content'];

  if (image) {
    // First classify: barcode or meal?
    const classification = await classifyImage(image.base64, image.mimeType);

    if (classification.type === 'barcode') {
      const product = await lookupBarcode(classification.value);

      if (product) {
        const pending: PendingBarcode = {
          chatId,
          productName: product.productName,
          brand: product.brand,
          per100g: product.per100g,
          expiresAt: Date.now() + 5 * 60 * 1000,
        };
        writePendingBarcode(pending);

        return `Found *${product.productName}*${product.brand ? ` (${product.brand})` : ''}\n100g = ${product.per100g.kcal} kcal · ${product.per100g.c}g carbs · ${product.per100g.p}g protein · ${product.per100g.f}g fat\n\nHow much did you have?`;
      }

      // Barcode not in database — fall through to Claude with the image
      userContent = [
        { type: 'image', source: { type: 'base64', media_type: image.mimeType as 'image/jpeg', data: image.base64 } },
        { type: 'text', text: `Barcode ${classification.value} wasn't found in the food database. Can you identify this product from the packaging and estimate the macros?` },
      ];
    } else {
      // Meal photo
      userContent = [
        { type: 'image', source: { type: 'base64', media_type: image.mimeType as 'image/jpeg', data: image.base64 } },
        { type: 'text', text: text || 'What is this meal and what are the estimated macros?' },
      ];
    }
  } else {
    userContent = text;
  }

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });

  const raw = (msg.content[0] as { text: string }).text;
  const action = parseAction(raw);
  const clean = stripAction(raw);

  if (action?.type === 'meal_override') {
    const override: MealOverride = {
      meal: String(action.meal),
      kcal: Number(action.kcal),
      c: Number(action.c),
      p: Number(action.p),
      f: Number(action.f),
      items: String(action.items),
      reason: String(action.reason ?? ''),
      updatedAt: new Date().toISOString(),
    };
    writeMealOverride(override);
  }

  if (action?.type === 'weight_log') {
    const date = new Date().toISOString().split('T')[0];
    logWeight(date, Number(action.weight), (action.unit as 'lbs' | 'kg') ?? 'lbs');
  }

  return clean;
}
