export interface UsdaFood {
  fdcId: number;
  name: string;
  brand: string | null;
  dataType: 'Branded' | 'Foundation' | 'SR Legacy';
  barcode: string | null;
  servingGrams: number | null;
  servingDesc: string | null;
  per100g: { kcal: number | null; p: number | null; c: number | null; f: number | null };
}

const SEARCH_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search';
const NUTRIENT_IDS = { kcal: 1008, p: 1003, c: 1005, f: 1004 } as const;
const GRAM_UNITS = new Set(['g', 'grm', 'ml']);

interface UsdaNutrientHit {
  nutrientId: number;
  value: number;
}

interface UsdaFoodHit {
  fdcId: number;
  description?: string;
  dataType?: string;
  brandOwner?: string;
  brandName?: string;
  gtinUpc?: string;
  servingSize?: number;
  servingSizeUnit?: string;
  householdServingFullText?: string;
  foodNutrients?: UsdaNutrientHit[];
}

interface UsdaSearchResponse {
  foods?: UsdaFoodHit[];
}

function mapHit(hit: UsdaFoodHit): UsdaFood | null {
  if (!hit.description) return null;

  const nutrients = hit.foodNutrients ?? [];
  const nutrientValue = (nutrientId: number): number | null =>
    nutrients.find((n) => n.nutrientId === nutrientId)?.value ?? null;

  const unit = hit.servingSizeUnit?.toLowerCase();
  const servingGrams = hit.servingSize != null && unit != null && GRAM_UNITS.has(unit) ? hit.servingSize : null;

  return {
    fdcId: hit.fdcId,
    name: hit.description,
    brand: hit.brandOwner ?? hit.brandName ?? null,
    dataType: (hit.dataType as UsdaFood['dataType']) ?? 'Branded',
    barcode: hit.gtinUpc ?? null,
    servingGrams,
    servingDesc: hit.householdServingFullText ?? null,
    per100g: {
      kcal: nutrientValue(NUTRIENT_IDS.kcal),
      p: nutrientValue(NUTRIENT_IDS.p),
      c: nutrientValue(NUTRIENT_IDS.c),
      f: nutrientValue(NUTRIENT_IDS.f),
    },
  };
}

async function search(apiKey: string, query: string, dataType: string[], pageSize: number): Promise<UsdaFood[]> {
  try {
    const res = await fetch(`${SEARCH_URL}?api_key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, dataType, pageSize }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      console.warn(`USDA search failed with status ${res.status}`);
      return [];
    }
    const data = (await res.json()) as UsdaSearchResponse;
    const foods = data.foods ?? [];
    return foods.reduce<UsdaFood[]>((acc, hit) => {
      const food = mapHit(hit);
      if (food) acc.push(food);
      return acc;
    }, []);
  } catch (err) {
    console.warn('USDA search request failed', err);
    return [];
  }
}

function interleave(branded: UsdaFood[], generic: UsdaFood[]): UsdaFood[] {
  const result: UsdaFood[] = [];
  const maxLen = Math.max(branded.length, generic.length);
  for (let i = 0; i < maxLen; i++) {
    if (branded[i]) result.push(branded[i]);
    if (generic[i]) result.push(generic[i]);
  }
  return result;
}

export async function searchFoods(query: string): Promise<UsdaFood[]> {
  const apiKey = process.env.USDA_FDC_API_KEY;
  if (!apiKey) return [];

  const [branded, generic] = await Promise.all([
    search(apiKey, query, ['Branded'], 10),
    search(apiKey, query, ['Foundation', 'SR Legacy'], 5),
  ]);

  return interleave(branded, generic).slice(0, 10);
}

function normalizeBarcode(value: string): string {
  return value.replace(/^0+/, '');
}

export async function searchByGtin(barcode: string): Promise<UsdaFood | null> {
  const apiKey = process.env.USDA_FDC_API_KEY;
  if (!apiKey) return null;

  const hits = await search(apiKey, barcode, ['Branded'], 5);
  const target = normalizeBarcode(barcode);
  return hits.find((food) => food.barcode != null && normalizeBarcode(food.barcode) === target) ?? null;
}
