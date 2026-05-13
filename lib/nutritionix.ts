interface CalorieNinjasFood {
  name: string;
  calories: number;
  serving_size_g: number;
  fat_total_g: number;
  protein_g: number;
  carbohydrates_total_g: number;
}

export interface NutritionixResult {
  kcal: number;
  c: number;
  p: number;
  f: number;
  foods: { name: string; qty: number; unit: string; kcal: number }[];
}

export async function lookupNutrition(query: string): Promise<NutritionixResult | null> {
  try {
    const res = await fetch(
      `https://api.calorieninjas.com/v1/nutrition?query=${encodeURIComponent(query)}`,
      { headers: { 'X-Api-Key': process.env.CALORIENINJAS_API_KEY ?? '' } }
    );

    if (!res.ok) return null;

    const data = await res.json() as { items: CalorieNinjasFood[] };
    if (!data.items?.length) return null;

    const totals = data.items.reduce(
      (acc, f) => ({
        kcal: acc.kcal + Math.round(f.calories),
        c: acc.c + Math.round(f.carbohydrates_total_g),
        p: acc.p + Math.round(f.protein_g),
        f: acc.f + Math.round(f.fat_total_g),
      }),
      { kcal: 0, c: 0, p: 0, f: 0 }
    );

    return {
      ...totals,
      foods: data.items.map(f => ({
        name: f.name,
        qty: Math.round(f.serving_size_g),
        unit: 'g',
        kcal: Math.round(f.calories),
      })),
    };
  } catch { return null; }
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
