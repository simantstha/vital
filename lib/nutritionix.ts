export interface NutritionixFood {
  food_name: string;
  serving_qty: number;
  serving_unit: string;
  nf_calories: number;
  nf_total_carbohydrate: number;
  nf_protein: number;
  nf_total_fat: number;
}

export interface NutritionixResult {
  kcal: number;
  c: number;
  p: number;
  f: number;
  foods: { name: string; qty: number; unit: string; kcal: number }[];
}

export async function lookupNutrition(query: string): Promise<NutritionixResult | null> {
  const res = await fetch('https://trackapi.nutritionix.com/v2/natural/nutrients', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-app-id': process.env.NUTRITIONIX_APP_ID!,
      'x-app-key': process.env.NUTRITIONIX_APP_KEY!,
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) return null;

  const data = await res.json() as { foods: NutritionixFood[] };

  const totals = data.foods.reduce(
    (acc, f) => ({
      kcal: acc.kcal + Math.round(f.nf_calories),
      c: acc.c + Math.round(f.nf_total_carbohydrate),
      p: acc.p + Math.round(f.nf_protein),
      f: acc.f + Math.round(f.nf_total_fat),
    }),
    { kcal: 0, c: 0, p: 0, f: 0 }
  );

  return {
    ...totals,
    foods: data.foods.map(f => ({
      name: f.food_name,
      qty: f.serving_qty,
      unit: f.serving_unit,
      kcal: Math.round(f.nf_calories),
    })),
  };
}

export interface SavedMeal {
  name: string;
  aliases?: string[];
  kcal: number;
  c: number;
  p: number;
  f: number;
  notes?: string;
}

export function findInSavedMeals(query: string, savedMeals: SavedMeal[]): SavedMeal | null {
  const q = query.toLowerCase();
  return savedMeals.find(meal =>
    [meal.name, ...(meal.aliases ?? [])].some(alias =>
      q.includes(alias.toLowerCase()) || alias.toLowerCase().includes(q)
    )
  ) ?? null;
}
