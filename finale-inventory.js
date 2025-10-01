const axios = require('axios');
const fs = require('fs');
const path = require('path');

// -------------------
// Finale credentials
// -------------------
const finaleApiKey = process.env.PAYLINK_API_KEY;
const finaleApiSecret = process.env.PAYLINK_SECRET_ID;
const finaleAuth = Buffer.from(`${finaleApiKey}:${finaleApiSecret}`).toString('base64');

// -------------------
// Shopify credentials
// -------------------
const shopifyDomain = process.env.SHOPIFY_DOMAIN;
const shopifyToken = process.env.SHOPIFY_KEY;

// -------------------
// Fetch all Shopify variants (paginated)
// -------------------
async function fetchAllShopifyVariants() {
  let url = `https://${shopifyDomain}/admin/api/2025-07/variants.json?limit=250`;
  let allVariants = [];

  while (url) {
    const res = await axios.get(url, { headers: { 'X-Shopify-Access-Token': shopifyToken } });
    allVariants.push(...res.data.variants);

    const linkHeader = res.headers.link;
    const nextMatch = linkHeader && linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;

    console.log(`Fetched ${allVariants.length} variants so far...`);
  }

  console.log(`Total Shopify variants fetched: ${allVariants.length}`);
  return allVariants;
}

// -------------------
// Extract SKU prefix and quantity
// e.g., FR320-20 -> { prefix: FR320, qty: 20 }
// If no number at end, qty = 1
// -------------------
function parseSku(sku) {
  const match = sku.match(/^(.*?)-(\d+)$/);
  if (match) return { prefix: match[1], qty: parseInt(match[2], 10) };
  return { prefix: sku, qty: 1 };
}

// -------------------
// Fetch Finale full product data
// -------------------
async function fetchFinaleData() {
  console.log("Fetching Finale data from API...");
  const url = `https://app.finaleinventory.com/trueshotgunclub/api/product/`;

  const res = await axios.get(url, {
    headers: { Authorization: `Basic ${finaleAuth}`, 'Content-Type': 'application/json' }
  });

  const data = res.data;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `finale_full_${timestamp}.json`;
  const filePath = path.join(__dirname, fileName);

  // Save temporarily
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`Finale data temporarily saved to ${fileName}`);

  return { data, filePath };
}

// -------------------
// Update Shopify variant cost
// -------------------
async function updateShopifyCost(variantId, newCost) {
  try {
    await axios.put(
      `https://${shopifyDomain}/admin/api/2025-07/variants/${variantId}.json`,
      { variant: { id: variantId, cost: newCost } },
      { headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json' } }
    );
    console.log(`Updated variant ${variantId} cost to ${newCost}`);
  } catch (err) {
    console.error(`Failed to update variant ${variantId}:`, err.response ? err.response.data : err.message);
  }
}

// -------------------
// Main runner
// -------------------
(async () => {
  console.time('Total runtime');
  let finaleFilePath = null;

  try {
    const variants = await fetchAllShopifyVariants();
    const skuData = variants
      .filter(v => v.sku)
      .map(v => {
        const parsed = parseSku(v.sku);
        return { variantId: v.id, originalSku: v.sku, prefix: parsed.prefix, qty: parsed.qty };
      });

    console.log(`Total Shopify SKU entries: ${skuData.length}`);

    const { data: finaleProducts, filePath } = await fetchFinaleData();
    finaleFilePath = filePath; // store for deletion

    const finaleSupplierList = finaleProducts.supplierList;
    const finaleMap = {};

    if (Array.isArray(finaleSupplierList)) {
      for (const supplierArr of finaleSupplierList) {
        for (const supplier of supplierArr) {
          if (supplier.supplierProductId) finaleMap[supplier.supplierProductId] = supplier;
        }
      }
    } else {
      console.error("Unexpected Finale data format: supplierList not found or not an array");
    }

    const prefixGroups = {};
    for (const v of skuData) {
      if (!prefixGroups[v.prefix]) prefixGroups[v.prefix] = [];
      prefixGroups[v.prefix].push(v);
    }

    for (const prefix in prefixGroups) {
      const group = prefixGroups[prefix];
      const minQty = Math.min(...group.map(v => v.qty));
      const baseSupplier = finaleMap[prefix];

      if (baseSupplier) {
        for (const v of group) {
          const factor = v.qty / minQty;
          const newPrice = parseFloat((baseSupplier.price * factor).toFixed(2));
          await updateShopifyCost(v.variantId, newPrice);
          await new Promise(r => setTimeout(r, 150)); // optional API delay
        }
      }
    }

    console.log(`Finished updating Shopify variant costs.`);

  } catch (err) {
    console.error('Error in main process:', err.message);
  } finally {
    if (finaleFilePath && fs.existsSync(finaleFilePath)) {
      fs.unlinkSync(finaleFilePath); // delete the temporary file
      console.log(`Deleted temporary file ${path.basename(finaleFilePath)}`);
    }
    console.timeEnd('Total runtime');
  }
})();
