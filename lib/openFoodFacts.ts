export interface ProductInfo {
  productName: string;
  brand?: string;
  per100g: {
    kcal: number;
    c: number;    // carbs g
    p: number;    // protein g
    f: number;    // fat g
  };
}

export async function lookupBarcode(barcode: string): Promise<ProductInfo | null> {
  try {
    const res = await fetch(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`, {
      headers: { 'User-Agent': 'VitalHealthDashboard/1.0' },
    });
    if (!res.ok) return null;

    const data = await res.json() as {
      status: number;
      product?: {
        product_name?: string;
        brands?: string;
        nutriments?: {
          'energy-kcal_100g'?: number;
          energy_100g?: number;
          carbohydrates_100g?: number;
          proteins_100g?: number;
          fat_100g?: number;
        };
      };
    };

    if (data.status !== 1 || !data.product) return null;

    const p = data.product;
    const n = p.nutriments ?? {};
    const kcal = n['energy-kcal_100g'] ?? Math.round((n.energy_100g ?? 0) / 4.184);

    if (!p.product_name) return null;

    return {
      productName: p.product_name,
      brand: p.brands?.split(',')[0]?.trim(),
      per100g: {
        kcal: Math.round(kcal),
        c: Math.round(n.carbohydrates_100g ?? 0),
        p: Math.round(n.proteins_100g ?? 0),
        f: Math.round(n.fat_100g ?? 0),
      },
    };
  } catch { return null; }
}
