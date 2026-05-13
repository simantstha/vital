import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages';
import { getCachedBrief } from '@/lib/briefCache';
import { loadAlwaysOnContext, MEMORY_TOOLS, handleToolCall } from '@/lib/memory';
import { readCoachState, writeMealOverride, writePendingBarcode, clearPendingBarcode, readPendingMeal, writePendingMeal, clearPendingMeal, type MealOverride, type PendingBarcode, type PendingMeal } from '@/lib/coachState';
import { logWeight, readWeightLog } from '@/lib/weightLog';
import { lookupBarcode, searchFoodByName } from '@/lib/openFoodFacts';
import { getDiaryMacros } from '@/lib/mfp';
import { lookupNutrition, findInSavedMeals, type SavedMeal, type NutritionixResult } from '@/lib/nutritionix';
import { readMemoryFile } from '@/lib/memory';
import { sendMessage } from '@/lib/telegram';

const client = new Anthropic();

// ── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(alwaysOnMemory: string, healthCtx: string): string {
  return `You are Vital Coach — a personal fitness and nutrition AI coach.
You respond via Telegram. Keep answers SHORT and direct (under 120 words) unless the user asks for detail.

You have access to memory tools. On each message:
1. Decide if you need more context from a domain file — check the Memory Index, then call read_memory if needed.
2. Answer the user.
3. If you learned a new fact (injury, food reaction, PR, allergy, supplement, travel, stress event), call write_memory to update the relevant file. Always read the file first, merge the new fact, then write the full updated JSON.
4. If you noticed a pattern or insight worth remembering, call append_observation (under 20 words).

NEVER display tool calls or memory operations to the user. They are silent background actions.

ACTIONS — append these at the very end of your response, NEVER display them to the user:
- If user reports eating something not in the plan:
  <vital-action type="meal_override" meal="MEAL_KEY" kcal="N" c="N" p="N" f="N" items="..." reason="..."/>
  MEAL_KEY must be one of: breakfast, lunch, snack, dinner
- If user logs their weight:
  <vital-action type="weight_log" weight="N" unit="lbs"/>
Only append an action when clearly triggered. Never preemptively.

## Long-term Memory
${alwaysOnMemory}

## Today's Health Context
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
  | { type: 'meal_photo'; query: string; items: string[] }
  | { type: 'other' }
> {
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType as 'image/jpeg', data: base64 } },
        {
          type: 'text',
          text: `Classify this image. Respond with JSON only, no markdown.

If it shows a barcode or QR code: {"type":"barcode","value":"<digits>"}
If it shows food or a meal: {"type":"meal_photo","query":"<natural language list, e.g. '6oz grilled chicken breast, 1 cup brown rice, 1 cup steamed broccoli'>","items":["<item 1>","<item 2>"]}
Otherwise: {"type":"other"}

For meal_photo: estimate realistic portion sizes. query must be comma-separated items with quantities and cooking method.`,
        },
      ],
    }],
  });
  const content = (msg.content[0] as { text: string }).text;
  return JSON.parse(content.replace(/```json\n?|```/g, '').trim());
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
  const alwaysOnMemory = loadAlwaysOnContext();
  const healthCtx = await buildHealthContext();
  const systemPrompt = buildSystemPrompt(alwaysOnMemory, healthCtx);

  let userContent: Anthropic.MessageParam['content'];

  // Handle pending meal confirmation/correction
  const pendingMeal = readPendingMeal(chatId);
  if (pendingMeal && !image) {
    const txt = text ?? '';
    const isConfirm = /^(yes|yeah|yep|correct|log|ok|looks good|right)/i.test(txt.trim());

    if (isConfirm) {
      clearPendingMeal();
      writeMealOverride({
        meal: pendingMeal.meal,
        kcal: pendingMeal.result.kcal,
        c: pendingMeal.result.c,
        p: pendingMeal.result.p,
        f: pendingMeal.result.f,
        items: pendingMeal.query,
        reason: 'meal photo + Nutritionix',
        updatedAt: new Date().toISOString(),
      });
      await sendMessage(chatId, `✅ Logged: ${pendingMeal.result.kcal}kcal · ${pendingMeal.result.p}g protein · ${pendingMeal.result.c}g carbs · ${pendingMeal.result.f}g fat\n\nWant me to save "${pendingMeal.query}" to your food library for next time? Reply *save it* or give it a shorter name.`);
      return '';
    } else {
      // User correcting portions — re-lookup with corrected text
      clearPendingMeal();
      const corrected = await lookupNutrition(txt);
      if (corrected) {
        const hour = new Date().getHours();
        const meal = hour < 10 ? 'breakfast' : hour < 14 ? 'lunch' : hour < 17 ? 'snack' : 'dinner';
        const newPending: PendingMeal = { chatId, query: txt, result: corrected, meal, expiresAt: Date.now() + 10 * 60 * 1000 };
        writePendingMeal(newPending);
        const itemLines = corrected.foods.map(f => `  • ${f.qty} ${f.unit} ${f.name} — ${f.kcal}kcal`).join('\n');
        await sendMessage(chatId, `Updated:\n${itemLines}\n\nTotal: ${corrected.kcal}kcal · ${corrected.p}g protein · ${corrected.c}g carbs · ${corrected.f}g fat\n\nLooks right? (yes / correct it)`);
        return '';
      }
    }
  }

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
    } else if (classification.type === 'meal_photo') {
      const hour = new Date().getHours();
      const meal = hour < 10 ? 'breakfast' : hour < 14 ? 'lunch' : hour < 17 ? 'snack' : 'dinner';

      // Lookup chain: savedMeals → Nutritionix → Open Food Facts → Claude estimate
      const habitsRaw = readMemoryFile('nutrition-habits.json');
      const habits = habitsRaw ? JSON.parse(habitsRaw) as { savedMeals?: SavedMeal[] } : null;
      const savedMeals: SavedMeal[] = habits?.savedMeals ?? [];
      const savedMatch = findInSavedMeals(classification.query, savedMeals);

      let nutrition: NutritionixResult | null = null;
      let source: 'saved' | 'db' | 'estimate' = 'db';

      if (savedMatch) {
        nutrition = { kcal: savedMatch.kcal, c: savedMatch.c, p: savedMatch.p, f: savedMatch.f, foods: [{ name: savedMatch.name, qty: 1, unit: 'serving', kcal: savedMatch.kcal }] };
        source = 'saved';
      } else {
        nutrition = await lookupNutrition(classification.query);
        if (!nutrition) {
          const offResult = await searchFoodByName(classification.query);
          if (offResult) {
            const factor = 1.5;
            nutrition = {
              kcal: Math.round(offResult.per100g.kcal * factor),
              c: Math.round(offResult.per100g.c * factor),
              p: Math.round(offResult.per100g.p * factor),
              f: Math.round(offResult.per100g.f * factor),
              foods: [{ name: offResult.productName, qty: 150, unit: 'g', kcal: Math.round(offResult.per100g.kcal * factor) }],
            };
          }
        }
        if (!nutrition) source = 'estimate';
      }

      const sourceTag = source === 'saved' ? '📚 your food library' : source === 'db' ? '🔍 database' : '🤖 estimated';

      if (source === 'estimate') {
        userContent = [
          { type: 'image', source: { type: 'base64', media_type: image.mimeType as 'image/jpeg', data: image.base64 } },
          { type: 'text', text: `[User sent a meal photo. Identified: "${classification.query}". No database match found — likely a regional/homemade dish. Visually estimate the macros, present clearly, ask user to confirm or correct. Once confirmed, offer to save to food library.]` },
        ];
      } else {
        const itemLines = nutrition!.foods.map(f => `  • ${f.qty} ${f.unit} ${f.name} — ${f.kcal}kcal`).join('\n');
        const confirmMsg = `I see (${sourceTag}):\n${itemLines || `  • ${nutrition!.kcal}kcal total`}\n\nTotal: ${nutrition!.kcal}kcal · ${nutrition!.p}g protein · ${nutrition!.c}g carbs · ${nutrition!.f}g fat\n\nLooks right? Reply *yes* to log, or correct the portions.`;
        const pending: PendingMeal = { chatId, query: classification.query, result: nutrition!, meal, expiresAt: Date.now() + 10 * 60 * 1000 };
        writePendingMeal(pending);
        await sendMessage(chatId, confirmMsg);
        return '';
      }
    } else {
      // other — fall through to Claude with the image
      userContent = [
        { type: 'image', source: { type: 'base64', media_type: image.mimeType as 'image/jpeg', data: image.base64 } },
        { type: 'text', text: text || 'What is this?' },
      ];
    }
  } else {
    userContent = text;
  }

  const messages: MessageParam[] = [{ role: 'user', content: userContent }];

  let response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    tools: MEMORY_TOOLS,
    messages,
  });

  let rounds = 0;
  const MAX_ROUNDS = 10;

  while (response.stop_reason === 'tool_use' && rounds < MAX_ROUNDS) {
    rounds++;
    messages.push({ role: 'assistant', content: response.content });

    const toolResults = response.content
      .filter((b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use')
      .map(block => ({
        type: 'tool_result' as const,
        tool_use_id: block.id,
        content: handleToolCall(block.name, block.input),
      }));

    messages.push({ role: 'user', content: toolResults });

    response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      tools: MEMORY_TOOLS,
      messages,
    });
  }

  const raw = response.content.find((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')?.text ?? '';
  if (!raw) {
    console.error('[telegramCoach] No text block in final response', JSON.stringify(response.content));
    return '';
  }
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
