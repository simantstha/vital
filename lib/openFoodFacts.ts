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

export interface OFFSearchResult {
  productName: string;
  per100g: { kcal: number; c: number; p: number; f: number };
}

export async function searchFoodByName(query: string): Promise<OFFSearchResult | null> {
  try {
    const params = new URLSearchParams({
      search_terms: query,
      json: '1',
      page_size: '3',
      search_simple: '1',
      fields: 'product_name,nutriments',
    });
    const res = await fetch(
      `https://world.openfoodfacts.org/cgi/search.pl?${params}`,
      { headers: { 'User-Agent': 'VitalHealthDashboard/1.0' } }
    );
    if (!res.ok) return null;

    const data = await res.json() as {
      products?: {
        product_name?: string;
        nutriments?: {
          'energy-kcal_100g'?: number;
          energy_100g?: number;
          carbohydrates_100g?: number;
          proteins_100g?: number;
          fat_100g?: number;
        };
      }[];
    };

    const product = data.products?.find(p => p.product_name && p.nutriments);
    if (!product) return null;

    const n = product.nutriments!;
    const kcal = n['energy-kcal_100g'] ?? Math.round((n.energy_100g ?? 0) / 4.184);

    return {
      productName: product.product_name!,
      per100g: {
        kcal: Math.round(kcal),
        c: Math.round(n.carbohydrates_100g ?? 0),
        p: Math.round(n.proteins_100g ?? 0),
        f: Math.round(n.fat_100g ?? 0),
      },
    };
  } catch { return null; }
}
