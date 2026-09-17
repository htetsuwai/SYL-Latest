import { supabaseConfig, demoUser } from "./supabase-config.js";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const TABLE_BY_COLLECTION = {
  users: "profiles",
  products: "products",
  settings: "settings",
  sales: "sales",
  saleItems: "sale_items",
  suppliers: "suppliers",
  purchases: "purchases",
  credits: "credits",
  creditPayments: "credit_payments",
  expenses: "expenses",
  stockDamages: "stock_damages",
  stockReturns: "stock_returns"
};

const COLLECTIONS = Object.keys(TABLE_BY_COLLECTION);

let supabase = null;

function snakeToCamel(key) {
  return key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function camelToSnake(key) {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function fromDbRow(row) {
  if (!row) return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    const camelKey = snakeToCamel(key);
    if (camelKey === "marginPercent" && value === null) {
      out.marginPercent = "";
    } else {
      out[camelKey] = value;
    }
  }
  return out;
}

function toDbRow(data) {
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    const snakeKey = camelToSnake(key);
    if (key === "marginPercent" && value === "") {
      out.margin_percent = null;
    } else {
      out[snakeKey] = value;
    }
  }
  return out;
}

function throwIfError(error) {
  if (error) throw new Error(error.message);
}

const DEFAULT_SETTINGS = {
  id: "main",
  baseFx: 4500,
  currentFx: 4500,
  roundTo: 100,
  defaultMargin: 8,
  lowStockThreshold: 5,
  marginBands: [
    { max: 10000, margin: 10 },
    { max: 100000, margin: 5 },
    { max: null, margin: 4 }
  ]
};

function lowStockThreshold() {
  return Number(state.settings.lowStockThreshold ?? DEFAULT_SETTINGS.lowStockThreshold);
}

function stockStatus(stockQty) {
  const qty = Number(stockQty || 0);
  const threshold = lowStockThreshold();
  if (qty <= 0) {
    return { level: "out", label: "Out of Stock", badgeClass: "status-pill status-out", stockClass: "stock-out" };
  }
  if (qty <= threshold) {
    return { level: "low", label: "Low Stock", badgeClass: "status-pill status-low", stockClass: "stock-low" };
  }
  return { level: "healthy", label: "In Stock", badgeClass: "status-pill status-in", stockClass: "stock-in" };
}

function stockOnHandHtml(stockQty, unit = "") {
  const qty = Number(stockQty || 0);
  const status = stockStatus(qty);
  const unitSuffix = unit ? ` ${unit}` : "";
  return `
    <div class="stock-on-hand">
      <span class="badge ${status.level === "healthy" ? "text-bg-success" : "text-bg-danger"}">${status.label === "In Stock" ? "Healthy" : status.label === "Out of Stock" ? "Out" : "Low"}</span>
      <span class="stock-qty ${status.level !== "healthy" ? "low-stock" : ""}">${qty.toLocaleString()}${unitSuffix}</span>
    </div>
  `;
}

function landedCost(product) {
  return Number(product?.cost || 0) + Number(product?.cogs || 0);
}

function isValidProductImageUrl(url) {
  if (!url) return false;
  return url.startsWith("data:image/") || url.startsWith("http://") || url.startsWith("https://");
}

function productImageHtml(imageUrl, alt = "Product", className = "product-thumb") {
  if (!isValidProductImageUrl(imageUrl)) {
    return `<div class="${className} product-thumb-empty">No image</div>`;
  }
  const safeAlt = String(alt || "Product").replace(/"/g, "&quot;");
  return `<img src="${imageUrl}" alt="${safeAlt}" class="${className}" loading="lazy">`;
}

function setProductImagePreview(imageUrl) {
  qs("#product-image-url").value = isValidProductImageUrl(imageUrl) ? imageUrl : "";
  qs("#product-image-preview").innerHTML = productImageHtml(
    qs("#product-image-url").value,
    qs("#product-name").value.trim() || "Product",
    "product-image-preview-img"
  );
  qs("#clear-product-image").classList.toggle("d-none", !qs("#product-image-url").value);
}

function clearProductImage() {
  qs("#product-image").value = "";
  setProductImagePreview("");
}

function resizeImageFile(file, maxWidth = 400, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => reject(new Error("Could not load image."));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error("Could not read image file."));
    reader.readAsDataURL(file);
  });
}

async function handleProductImageChange(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    showToast("Please choose an image file.");
    event.target.value = "";
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    showToast("Image must be under 2 MB.");
    event.target.value = "";
    return;
  }

  try {
    setProductImagePreview(await resizeImageFile(file));
  } catch (error) {
    showToast(error.message || "Could not process image.");
    event.target.value = "";
  }
}

function inventoryMetrics() {
  const threshold = lowStockThreshold();
  let low = 0;
  let out = 0;
  let healthy = 0;
  let stockValue = 0;

  for (const product of state.products) {
    const qty = Number(product.stockQty || 0);
    stockValue += qty * landedCost(product);
    if (qty <= 0) out += 1;
    else if (qty <= threshold) low += 1;
    else healthy += 1;
  }

  return { total: state.products.length, low, out, healthy, stockValue, threshold };
}

function getInventoryFilters() {
  return {
    search: (qs("#inventory-search")?.value || "").trim().toLowerCase(),
    status: qs("#inventory-status-filter")?.value || "all",
    type: qs("#inventory-type-filter")?.value || "all"
  };
}

function matchesInventoryFilters(product, filters) {
  const qty = Number(product.stockQty || 0);
  const threshold = lowStockThreshold();

  if (filters.type !== "all" && product.type !== filters.type) return false;
  if (filters.status === "out" && qty > 0) return false;
  if (filters.status === "low" && (qty <= 0 || qty > threshold)) return false;
  if (filters.status === "healthy" && qty <= threshold) return false;

  if (filters.search) {
    const haystack = [product.name, product.sku, product.barcode].join(" ").toLowerCase();
    if (!haystack.includes(filters.search)) return false;
  }

  return true;
}

function inventorySortRank(product) {
  const qty = Number(product.stockQty || 0);
  if (qty <= 0) return 0;
  if (qty <= lowStockThreshold()) return 1;
  return 2;
}

function productHasSales(productId) {
  return state.saleItems.some((item) => String(item.productId) === String(productId));
}

function soldQtyForProduct(productId) {
  return state.saleItems.reduce((sum, item) => {
    if (String(item.productId) !== String(productId)) return sum;
    return sum + Number(item.qty || 0);
  }, 0);
}

function returnedQtyForProduct(productId, excludeReturnId = null) {
  return state.stockReturns.reduce((sum, item) => {
    if (String(item.productId) !== String(productId)) return sum;
    if (excludeReturnId && String(item.id) === String(excludeReturnId)) return sum;
    return sum + Number(item.qty || 0);
  }, 0);
}

function returnableQtyForProduct(productId, excludeReturnId = null) {
  return Math.max(0, soldQtyForProduct(productId) - returnedQtyForProduct(productId, excludeReturnId));
}

function openProductRestock(productId) {
  location.hash = "#products";
  showRoute();
  openProductFormModal(state.products.find((product) => product.id === productId));
}

function setDamageModalMode(mode, record = null) {
  const isEdit = mode === "edit";
  qs("#damage-record-id").value = isEdit ? record.id : "";
  qs("#damage-product-modal-label").textContent = isEdit ? "Edit damage record" : "Record damaged stock";
  qs("#damage-submit-btn").textContent = isEdit ? "Save changes" : "Record damage";
}

function openDamageModal(productId) {
  const product = state.products.find((item) => item.id === productId);
  if (!product) {
    showToast("Product not found.");
    return;
  }

  if (!productHasSales(product.id)) {
    showToast("Return and damage are available only after this product has been sold.");
    return;
  }

  const stockQty = Number(product.stockQty || 0);
  if (stockQty <= 0) {
    showToast("No stock available to mark as damaged.");
    return;
  }

  setDamageModalMode("create");
  qs("#damage-product-id").value = product.id;
  qs("#damage-product-name").textContent = product.name;
  qs("#damage-available-stock").textContent = `${stockQty.toLocaleString()} ${product.unit}`;
  qs("#damage-qty").value = 1;
  qs("#damage-qty").max = stockQty;
  qs("#damage-note").value = "";
  bootstrap.Modal.getOrCreateInstance(qs("#damage-product-modal")).show();
}

function openDamageEditModal(recordId) {
  const record = state.stockDamages.find((item) => item.id === recordId);
  const product = state.products.find((item) => item.id === record?.productId);
  if (!record || !product) {
    showToast("Damage record not found.");
    return;
  }

  const stockQty = Number(product.stockQty || 0);
  setDamageModalMode("edit", record);
  qs("#damage-product-id").value = product.id;
  qs("#damage-product-name").textContent = product.name;
  qs("#damage-available-stock").textContent = `${stockQty.toLocaleString()} ${product.unit}`;
  qs("#damage-qty").value = Math.max(1, Math.round(Number(record.qty || 1)));
  qs("#damage-qty").max = Math.max(1, Math.round(stockQty + Number(record.qty || 0)));
  qs("#damage-note").value = record.note || "";
  bootstrap.Modal.getOrCreateInstance(qs("#damage-product-modal")).show();
}

async function updateProductStock(productId, nextQty) {
  const stockQty = Math.max(0, Number(nextQty || 0));
  const product = state.products.find((item) => item.id === productId);
  if (!product) throw new Error("Product not found.");

  if (!state.isSupabaseReady) {
    const saved = await saveDoc("products", {
      ...product,
      stockQty,
      updatedAt: nowIso()
    });
    const index = state.products.findIndex((item) => item.id === productId);
    if (index >= 0) state.products[index] = { ...state.products[index], stockQty };
    return saved;
  }

  const { data, error } = await supabase
    .from("products")
    .update({
      stock_qty: stockQty,
      updated_at: nowIso()
    })
    .eq("id", productId)
    .select()
    .single();
  throwIfError(error);

  const saved = fromDbRow(data);
  const index = state.products.findIndex((item) => item.id === productId);
  if (index >= 0) state.products[index] = { ...state.products[index], stockQty: Number(saved.stockQty) };
  return saved;
}

async function recordProductDamage(event) {
  event.preventDefault();

  const recordId = qs("#damage-record-id").value;
  const productId = qs("#damage-product-id").value;
  const product = state.products.find((item) => item.id === productId);
  const qty = Math.max(1, Math.round(numberValue("#damage-qty")));
  const note = qs("#damage-note").value.trim();
  const stockQty = Number(product?.stockQty || 0);

  if (!product) {
    showToast("Product not found.");
    return;
  }
  if (qty <= 0) {
    showToast("Enter a valid damage qty.");
    return;
  }

  const unitCost = landedCost(product);

  if (recordId) {
    const record = state.stockDamages.find((item) => item.id === recordId);
    if (!record) {
      showToast("Damage record not found.");
      return;
    }

    const oldQty = Number(record.qty || 0);
    const delta = qty - oldQty;
    if (delta > 0 && delta > stockQty) {
      showToast("Damage qty exceeds available stock.");
      return;
    }

    await saveDoc("stockDamages", {
      ...record,
      qty,
      unit: product.unit,
      unitCost,
      lossValue: qty * unitCost,
      note
    });

    const updated = await updateProductStock(product.id, stockQty - delta);
    bootstrap.Modal.getInstance(qs("#damage-product-modal"))?.hide();
    await loadData();
    showToast(`Damage updated. In stock now ${Number(updated.stockQty || 0).toLocaleString()} ${product.unit}.`);
    return;
  }

  if (qty > stockQty) {
    showToast("Damage qty exceeds in-stock amount.");
    return;
  }

  await saveDoc("stockDamages", {
    date: nowIso(),
    productId: product.id,
    productName: product.name,
    sku: product.sku,
    qty,
    unit: product.unit,
    unitCost,
    lossValue: qty * unitCost,
    note,
    userId: state.user?.id || state.user?.uid
  });

  const updated = await updateProductStock(product.id, stockQty - qty);
  bootstrap.Modal.getInstance(qs("#damage-product-modal"))?.hide();
  await loadData();
  showToast(`Damage recorded. Stock reduced by ${qty.toLocaleString()} ${product.unit}. In stock now ${Number(updated.stockQty || 0).toLocaleString()}.`);
}

async function deleteDamageRecord(recordId) {
  const record = state.stockDamages.find((item) => item.id === recordId);
  if (!record) {
    showToast("Damage record not found.");
    return;
  }

  if (!confirm(`Delete damage record for ${record.productName}?`)) return;

  const product = state.products.find((item) => item.id === record.productId);
  if (product) {
    await updateProductStock(product.id, Number(product.stockQty || 0) + Number(record.qty || 0));
  }

  await removeDoc("stockDamages", recordId);
  await loadData();
  showToast("Damage record deleted. Stock restored.");
}

function setReturnModalMode(mode, record = null) {
  const isEdit = mode === "edit";
  qs("#return-record-id").value = isEdit ? record.id : "";
  qs("#return-product-modal-label").textContent = isEdit ? "Edit return record" : "Record product return";
  qs("#return-submit-btn").textContent = isEdit ? "Save changes" : "Record return";
}

function openReturnModal(productId) {
  const product = state.products.find((item) => item.id === productId);
  if (!product) {
    showToast("Product not found.");
    return;
  }

  const soldQty = soldQtyForProduct(product.id);
  const returnedQty = returnedQtyForProduct(product.id);
  const returnableQty = returnableQtyForProduct(product.id);

  if (returnableQty <= 0) {
    showToast(soldQty <= 0
      ? "No sales yet. Return is available only after this product has been sold."
      : "All sold qty has already been returned.");
    return;
  }

  setReturnModalMode("create");
  qs("#return-product-id").value = product.id;
  qs("#return-product-name").textContent = product.name;
  qs("#return-current-stock").textContent = `${Number(product.stockQty || 0).toLocaleString()} ${product.unit}`;
  qs("#return-sold-qty").textContent = `${soldQty.toLocaleString()} ${product.unit}`;
  qs("#return-returned-qty").textContent = `${returnedQty.toLocaleString()} ${product.unit}`;
  qs("#return-returnable-qty").textContent = `${returnableQty.toLocaleString()} ${product.unit}`;
  qs("#return-qty").value = Math.min(1, returnableQty);
  qs("#return-qty").max = returnableQty;
  qs("#return-customer").value = "";
  qs("#return-note").value = "";
  bootstrap.Modal.getOrCreateInstance(qs("#return-product-modal")).show();
}

function openReturnEditModal(recordId) {
  const record = state.stockReturns.find((item) => item.id === recordId);
  const product = state.products.find((item) => item.id === record?.productId);
  if (!record || !product) {
    showToast("Return record not found.");
    return;
  }

  const soldQty = soldQtyForProduct(product.id);
  const returnedQty = returnedQtyForProduct(product.id, record.id);
  const returnableQty = returnableQtyForProduct(product.id, record.id);

  setReturnModalMode("edit", record);
  qs("#return-product-id").value = product.id;
  qs("#return-product-name").textContent = product.name;
  qs("#return-current-stock").textContent = `${Number(product.stockQty || 0).toLocaleString()} ${product.unit}`;
  qs("#return-sold-qty").textContent = `${soldQty.toLocaleString()} ${product.unit}`;
  qs("#return-returned-qty").textContent = `${returnedQty.toLocaleString()} ${product.unit}`;
  qs("#return-returnable-qty").textContent = `${returnableQty.toLocaleString()} ${product.unit}`;
  qs("#return-qty").value = Math.max(1, Math.round(Number(record.qty || 1)));
  qs("#return-qty").max = Math.max(1, Math.round(returnableQty));
  qs("#return-customer").value = record.customerName || "";
  qs("#return-note").value = record.note || "";
  bootstrap.Modal.getOrCreateInstance(qs("#return-product-modal")).show();
}

async function recordProductReturn(event) {
  event.preventDefault();

  const recordId = qs("#return-record-id").value;
  const productId = qs("#return-product-id").value;
  const product = state.products.find((item) => item.id === productId);
  const qty = Math.max(1, Math.round(numberValue("#return-qty")));
  const customerName = qs("#return-customer").value.trim();
  const note = qs("#return-note").value.trim();
  const stockQty = Number(product?.stockQty || 0);
  const returnableQty = returnableQtyForProduct(productId, recordId || null);

  if (!product) {
    showToast("Product not found.");
    return;
  }
  if (qty <= 0) {
    showToast("Enter a valid return qty.");
    return;
  }
  if (qty > returnableQty) {
    showToast(`Return qty cannot exceed sold qty available to return (${returnableQty.toLocaleString()} ${product.unit}).`);
    return;
  }

  const unitCost = landedCost(product);
  const refundValue = qty * Number(product.price || 0);

  if (recordId) {
    const record = state.stockReturns.find((item) => item.id === recordId);
    if (!record) {
      showToast("Return record not found.");
      return;
    }

    const oldQty = Number(record.qty || 0);
    const delta = qty - oldQty;
    if (delta < 0 && Math.abs(delta) > stockQty) {
      showToast("Cannot reduce return below available stock.");
      return;
    }

    await saveDoc("stockReturns", {
      ...record,
      qty,
      unit: product.unit,
      unitCost,
      refundValue,
      customerName,
      note
    });

    await updateProductStock(product.id, stockQty + delta);
    bootstrap.Modal.getInstance(qs("#return-product-modal"))?.hide();
    await loadData();
    showToast("Return record updated.");
    return;
  }

  await saveDoc("stockReturns", {
    date: nowIso(),
    productId: product.id,
    productName: product.name,
    sku: product.sku,
    qty,
    unit: product.unit,
    unitCost,
    refundValue,
    customerName,
    note,
    userId: state.user?.id || state.user?.uid
  });

  await updateProductStock(product.id, stockQty + qty);
  bootstrap.Modal.getInstance(qs("#return-product-modal"))?.hide();
  await loadData();
  showToast(`${qty.toLocaleString()} ${product.unit} returned to stock.`);
}

async function deleteReturnRecord(recordId) {
  const record = state.stockReturns.find((item) => item.id === recordId);
  if (!record) {
    showToast("Return record not found.");
    return;
  }

  if (!confirm(`Delete return record for ${record.productName}?`)) return;

  const product = state.products.find((item) => item.id === record.productId);
  const returnQty = Number(record.qty || 0);
  if (product) {
    const stockQty = Number(product.stockQty || 0);
    if (returnQty > stockQty) {
      showToast("Not enough stock to reverse this return.");
      return;
    }

    await updateProductStock(product.id, stockQty - returnQty);
  }

  await removeDoc("stockReturns", recordId);
  await loadData();
  showToast("Return record deleted.");
}

const state = {
  user: null,
  isSupabaseReady:
    Boolean(supabaseConfig.url) &&
    Boolean(supabaseConfig.anonKey) &&
    !supabaseConfig.url.startsWith("PASTE_") &&
    !supabaseConfig.anonKey.startsWith("PASTE_"),
  handlingLogin: false,
  settings: DEFAULT_SETTINGS,
  products: [],
  suppliers: [],
  purchases: [],
  sales: [],
  saleItems: [],
  credits: [],
  creditPayments: [],
  expenses: [],
  stockDamages: [],
  stockReturns: [],
  cart: [],
  lastReceipt: null,
  productsPage: 1,
  productsPageSize: 8,
  viewingProductId: null
};

const qs = (selector) => document.querySelector(selector);
const qsa = (selector) => [...document.querySelectorAll(selector)];
const money = (value) => `${Number(value || 0).toLocaleString("en-US")} MMK`;
const numberValue = (selector) => Number(qs(selector).value || 0);
const nowIso = () => new Date().toISOString();
const id = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

function showToast(message) {
  const toastEl = qs("#app-toast");
  toastEl.querySelector(".toast-body").textContent = message;
  bootstrap.Toast.getOrCreateInstance(toastEl).show();
}

function setLoginLoading(isLoading, message = "Signing in...") {
  qs("#login-btn").disabled = isLoading;
  qs("#login-spinner").classList.toggle("d-none", !isLoading);
  qs("#login-btn-text").textContent = isLoading ? message : "Sign in";
  qs("#login-email").disabled = isLoading;
  qs("#login-password").disabled = isLoading;
}

function setSaveProductLoading(isLoading) {
  qs("#save-product-btn").disabled = isLoading;
  qs("#save-product-spinner").classList.toggle("d-none", !isLoading);
  qs("#save-product-text").textContent = isLoading ? "Saving..." : "Save Product";
}

function slugifyName(name) {
  return String(name || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 20) || "ITEM";
}

function yearSuffix() {
  return String(new Date().getFullYear()).slice(-2);
}

function generateSku(type, name, excludeId) {
  const slug = slugifyName(name);
  const prefix = `${type}-${slug}`;
  const sameGroup = state.products.filter(
    (product) =>
      product.id !== excludeId &&
      product.type === type &&
      slugifyName(product.name) === slug
  );
  const serial = String(sameGroup.length + 1).padStart(3, "0");
  return `${prefix}-${serial}-${yearSuffix()}`;
}

function generateBarcode() {
  const numbers = state.products
    .map((product) => Number(product.barcode))
    .filter((value) => Number.isFinite(value));
  const next = numbers.length ? Math.max(...numbers) + 1 : Number(`${yearSuffix()}000001`);
  return String(next);
}

function weightedAverage(oldQty, oldValue, addQty, addValue) {
  const totalQty = Number(oldQty || 0) + Number(addQty || 0);
  if (totalQty <= 0) return Number(addValue || 0);
  if (Number(oldQty || 0) <= 0) return Number(addValue || 0);
  return ((Number(oldQty) * Number(oldValue)) + (Number(addQty) * Number(addValue))) / totalQty;
}

function batchCogsPerUnit(batchCogs, qty) {
  const quantity = Number(qty || 0);
  if (quantity <= 0) return 0;
  return Number(batchCogs || 0) / quantity;
}

function localDb() {
  const existing = localStorage.getItem("electronics-pos-db");
  if (existing) {
    const db = JSON.parse(existing);
    db.products = (db.products || []).map((product, index) => ({
      ...product,
      sku: product.sku || `${product.type || "HA"}-${slugifyName(product.name)}-${String(index + 1).padStart(3, "0")}-${yearSuffix()}`,
      barcode: product.barcode || String(Number(`${yearSuffix()}00000${index + 1}`))
    }));
    saveLocalDb(db);
    return db;
  }

  const initial = Object.fromEntries(COLLECTIONS.map((name) => [name, []]));
  initial.settings = [DEFAULT_SETTINGS];
  initial.users = [demoUser];
  initial.products = [
    {
      id: id(),
      type: "HA",
      name: "Demo Rice Cooker",
      sku: "HA-DEMORICECOOKER-001-26",
      barcode: "26000001",
      unit: "pcs",
      cost: 85000,
      cogs: 500,
      marginPercent: "",
      price: 97200,
      stockQty: 10,
      active: true,
      createdAt: nowIso()
    },
    {
      id: id(),
      type: "IA",
      name: "Demo Cable",
      sku: "IA-DEMOCABLE-001-26",
      barcode: "26000002",
      unit: "ft",
      cost: 1800,
      cogs: 100,
      marginPercent: 10,
      price: 2100,
      stockQty: 500,
      active: true,
      createdAt: nowIso()
    }
  ];
  localStorage.setItem("electronics-pos-db", JSON.stringify(initial));
  return initial;
}

function saveLocalDb(db) {
  localStorage.setItem("electronics-pos-db", JSON.stringify(db));
}

async function listDocs(collectionName) {
  if (!state.isSupabaseReady) return localDb()[collectionName] || [];

  const table = TABLE_BY_COLLECTION[collectionName];
  const { data, error } = await supabase.from(table).select("*");
  throwIfError(error);
  return (data || []).map(fromDbRow);
}

async function saveDoc(collectionName, data) {
  if (!state.isSupabaseReady) {
    const db = localDb();
    const collectionRows = db[collectionName] || [];
    const record = { ...data, id: data.id || id() };
    const index = collectionRows.findIndex((item) => item.id === record.id);
    if (index >= 0) collectionRows[index] = record;
    else collectionRows.push(record);
    db[collectionName] = collectionRows;
    saveLocalDb(db);
    return record;
  }

  const table = TABLE_BY_COLLECTION[collectionName];
  const row = toDbRow(data);
  const rowId = row.id;
  delete row.id;

  if (rowId) {
    const { data: saved, error } = await supabase
      .from(table)
      .upsert({ id: rowId, ...row })
      .select()
      .single();
    throwIfError(error);
    return fromDbRow(saved);
  }

  const { data: saved, error } = await supabase.from(table).insert(row).select().single();
  throwIfError(error);
  return fromDbRow(saved);
}

async function removeDoc(collectionName, docId) {
  if (!state.isSupabaseReady) {
    const db = localDb();
    db[collectionName] = (db[collectionName] || []).filter((item) => item.id !== docId);
    saveLocalDb(db);
    return;
  }

  const table = TABLE_BY_COLLECTION[collectionName];
  const { error } = await supabase.from(table).delete().eq("id", docId);
  throwIfError(error);
}

async function getUserProfile(user) {
  if (!state.isSupabaseReady) return demoUser;

  const { data, error } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  if (error || !data) {
    throw new Error("User profile not found. Ask admin to add your profile in Supabase.");
  }

  const profile = fromDbRow(data);
  return { ...profile, uid: profile.id };
}

function marginFor(product, settings = state.settings) {
  if (product.marginPercent !== "" && product.marginPercent !== null && product.marginPercent !== undefined) {
    return Number(product.marginPercent);
  }

  const landedCost = Number(product.cost || 0) + Number(product.cogs || 0);
  const band = (settings.marginBands || []).find((item) => item.max === null || landedCost <= Number(item.max));
  return Number((band && band.margin) || settings.defaultMargin || 0);
}

function roundPrice(value, roundTo = state.settings.roundTo) {
  const step = Number(roundTo || 100);
  return Math.round(Number(value || 0) / step) * step;
}

function calculatePrice(product, settings = state.settings) {
  const landedCost = Number(product.cost || 0) + Number(product.cogs || 0);
  const fxFactor = Number(settings.currentFx || 1) / Number(settings.baseFx || settings.currentFx || 1);
  return roundPrice(landedCost * (1 + marginFor(product, settings) / 100) * fxFactor, settings.roundTo);
}

async function loadCoreData() {
  const [settings, products] = await Promise.all([
    listDocs("settings"),
    listDocs("products")
  ]);

  state.settings = { ...DEFAULT_SETTINGS, ...(settings.find((item) => item.id === "main") || {}) };
  state.products = products.sort((a, b) => a.name.localeCompare(b.name));

  renderSettings();
  renderProducts();
  renderInventory();
  renderProductSupplierSelect();
  renderCart();
}

async function loadAdminData() {
  const role = state.user?.role || "sales";
  if (role !== "admin" && state.isSupabaseReady) {
    state.suppliers = [];
    state.purchases = [];
    state.sales = [];
    state.saleItems = [];
    state.credits = [];
    state.creditPayments = [];
    state.expenses = [];
    state.stockDamages = [];
    state.stockReturns = [];
    return;
  }

  const [
    suppliers,
    purchases,
    sales,
    saleItems,
    credits,
    creditPayments,
    expenses,
    stockDamages,
    stockReturns
  ] = await Promise.all([
    listDocs("suppliers"),
    listDocs("purchases"),
    listDocs("sales"),
    listDocs("saleItems"),
    listDocs("credits"),
    listDocs("creditPayments"),
    listDocs("expenses"),
    listDocs("stockDamages"),
    listDocs("stockReturns")
  ]);

  state.suppliers = suppliers.sort((a, b) => a.name.localeCompare(b.name));
  state.purchases = purchases.sort((a, b) => b.date.localeCompare(a.date));
  state.sales = sales.sort((a, b) => b.date.localeCompare(a.date));
  state.saleItems = saleItems;
  state.credits = credits.sort((a, b) => b.date.localeCompare(a.date));
  state.creditPayments = creditPayments;
  state.expenses = expenses.sort((a, b) => b.date.localeCompare(a.date));
  state.stockDamages = stockDamages.sort((a, b) => b.date.localeCompare(a.date));
  state.stockReturns = stockReturns.sort((a, b) => b.date.localeCompare(a.date));

  renderSuppliersTable();
  renderProductSupplierSelect();
  renderPurchases();
  renderCredits();
  renderExpenses();
  renderReports();
  renderInventory();
}

async function loadData() {
  await loadCoreData();
  await loadAdminData();
}

function renderAll() {
  renderSettings();
  renderProducts();
  renderInventory();
  renderProductSupplierSelect();
  renderSuppliersTable();
  renderPurchases();
  renderCredits();
  renderExpenses();
  renderCart();
  renderReports();
}

function applyRole() {
  const role = state.user?.role || "sales";
  qs("#current-role").textContent = role.toUpperCase();
  qsa(".admin-only").forEach((item) => item.classList.toggle("d-none", role !== "admin"));

  if (role !== "admin" && location.hash !== "#pos") {
    location.hash = "#pos";
  }
}

function setProductsNavOpen(open) {
  const group = qs('[data-group="products"]');
  const toggle = qs("#products-nav-toggle");
  const submenu = qs("#products-submenu");
  if (!group || !toggle || !submenu) return;
  group.classList.toggle("open", open);
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  submenu.hidden = !open;
}

function setSidebarOpen(open) {
  const shell = qs("#app-shell");
  const backdrop = qs("#sidebar-backdrop");
  if (!shell) return;
  shell.classList.toggle("sidebar-open", open);
  if (backdrop) backdrop.hidden = !open;
}

function showRoute() {
  const hash = location.hash || "#pos";
  const target = qs(hash) || qs("#pos");
  qsa(".view").forEach((view) => view.classList.remove("active"));
  target.classList.add("active");

  const route = target.id;
  qsa(".sidebar-link[data-route], .sidebar-sublink[data-route]").forEach((link) => {
    link.classList.toggle("active", link.dataset.route === route);
  });

  if (route === "products" || route === "inventory") {
    setProductsNavOpen(true);
  }

  setSidebarOpen(false);
  if (target.id === "pos") qs("#barcode-input")?.focus();
}

function leaveApp(message = "Signed out. Sign in again to continue.") {
  state.user = null;
  state.cart = [];
  state.lastReceipt = null;
  state.products = [];
  state.suppliers = [];
  state.purchases = [];
  state.sales = [];
  state.saleItems = [];
  state.credits = [];
  state.creditPayments = [];
  state.expenses = [];
  state.stockDamages = [];
  state.stockReturns = [];
  state.settings = { ...DEFAULT_SETTINGS };

  qs("#app-shell").classList.add("d-none");
  qs("#auth-screen").classList.remove("d-none");
  qs("#login-password").value = "";
  qs("#auth-message").textContent = message;
  location.hash = "";
}

async function signOutUser() {
  const btn = qs("#logout-btn");
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Signing out...";
  state.handlingLogin = true;

  try {
    if (state.isSupabaseReady && supabase) {
      const { error } = await supabase.auth.signOut({ scope: "local" });
      if (error) throw error;
    }
    leaveApp();
  } catch (error) {
    showToast(error.message || "Could not sign out.");
    leaveApp("Sign out had a problem. Please sign in again.");
  } finally {
    state.handlingLogin = false;
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function enterApp(profile) {
  state.user = profile;
  qs("#auth-screen").classList.add("d-none");
  qs("#app-shell").classList.remove("d-none");
  applyRole();
  showRoute();

  await loadCoreData();
  loadAdminData().catch((error) => showToast(error.message));
}

async function showApp(profile) {
  await enterApp(profile);
}

function renderSettings() {
  qs("#base-fx").value = state.settings.baseFx;
  qs("#current-fx").value = state.settings.currentFx;
  qs("#round-to").value = state.settings.roundTo;
  qs("#default-margin").value = state.settings.defaultMargin;
  qs("#low-stock-threshold").value = lowStockThreshold();
  qs("#margin-bands").value = JSON.stringify(state.settings.marginBands || [], null, 2);
}

function productDraftFromForm(existing) {
  const isEdit = Boolean(existing?.id);
  const qty = Math.max(1, Math.round(numberValue("#product-qty")));
  const unitCost = numberValue("#product-unit-cost");
  const batchCogs = numberValue("#product-batch-cogs");
  const cogsPerUnit = batchCogsPerUnit(batchCogs, qty);

  const base = {
    id: existing?.id,
    type: qs("#product-type").value,
    unit: qs("#product-unit").value,
    name: qs("#product-name").value.trim(),
    brand: qs("#product-brand")?.value.trim() || "",
    sku: isEdit ? existing.sku : (qs("#product-sku").value.trim() || generateSku(qs("#product-type").value, qs("#product-name").value.trim())),
    barcode: isEdit ? existing.barcode : (qs("#product-barcode").value.trim() || generateBarcode()),
    marginPercent: qs("#product-margin").value === "" ? "" : numberValue("#product-margin"),
    imageUrl: qs("#product-image-url").value || existing?.imageUrl || "",
    active: true,
    updatedAt: nowIso()
  };

  const oldStock = Number(existing?.stockQty || 0);
  const oldCost = Number(existing?.cost || 0);
  const oldCogs = Number(existing?.cogs || 0);

  if (qty > 0) {
    base.stockQty = oldStock + qty;
    base.cost = weightedAverage(oldStock, oldCost, qty, unitCost);
    base.cogs = weightedAverage(oldStock, oldCogs, qty, cogsPerUnit);
  } else if (isEdit) {
    base.stockQty = oldStock;
    base.cost = oldCost;
    base.cogs = oldCogs;
  } else {
    base.stockQty = 0;
    base.cost = unitCost;
    base.cogs = cogsPerUnit;
  }

  base.price = calculatePrice(base);
  return { product: base, qty, unitCost, batchCogs, cogsPerUnit };
}

function renderProducts() {
  const body = qs("#products-body");
  const metricsEl = qs("#products-metrics");
  if (!body) return;

  const metrics = inventoryMetrics();
  const total = metrics.total || 1;
  if (metricsEl) {
    metricsEl.innerHTML = `
      <div class="kpi-card">
        <div class="kpi-icon kpi-blue" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 7h16v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" stroke="currentColor" stroke-width="1.8"/><path d="M8 7V5a4 4 0 0 1 8 0v2" stroke="currentColor" stroke-width="1.8"/></svg></div>
        <div><span>Total Products</span><strong>${metrics.total}</strong><small class="text-muted">All catalog items</small></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon kpi-green" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M20 7 12 3 4 7l8 4 8-4Z" stroke="currentColor" stroke-width="1.8"/><path d="m4 7 8 4v10l-8-4V7Zm16 0v10l-8 4V11l8-4Z" stroke="currentColor" stroke-width="1.8"/></svg></div>
        <div><span>In Stock</span><strong>${metrics.healthy}</strong><small class="text-muted">${Math.round((metrics.healthy / total) * 100)}% of total</small></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon kpi-orange" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" stroke="currentColor" stroke-width="1.8"/></svg></div>
        <div><span>Low Stock</span><strong>${metrics.low}</strong><small class="text-muted">${Math.round((metrics.low / total) * 100)}% of total</small></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon kpi-red" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="m8 8 8 8M16 8l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></div>
        <div><span>Out of Stock</span><strong>${metrics.out}</strong><small class="text-muted">${Math.round((metrics.out / total) * 100)}% of total</small></div>
      </div>
    `;
  }

  populateProductBrandFilter();
  const filtered = filteredProductsList();
  const pageSize = Number(qs("#products-page-size")?.value || state.productsPageSize || 8);
  state.productsPageSize = pageSize;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  if (state.productsPage > pageCount) state.productsPage = pageCount;
  const start = (state.productsPage - 1) * pageSize;
  const pageRows = filtered.slice(start, start + pageSize);

  body.innerHTML = pageRows.length
    ? pageRows.map((product) => {
      const qty = Number(product.stockQty || 0);
      const status = stockStatus(qty);
      const brand = productBrand(product);
      return `
        <tr>
          <td><input type="checkbox" class="form-check-input product-row-check" value="${product.id}" aria-label="Select ${product.name}"></td>
          <td>
            <div class="product-cell">
              ${productImageHtml(product.imageUrl, product.name, "product-thumb product-thumb-lg")}
              <div>
                <strong>${product.name}</strong>
                <div class="small text-muted">${productTypeLabel(product.type)} · ${product.unit || "pcs"}</div>
              </div>
            </div>
          </td>
          <td><code>${product.sku || "-"}</code></td>
          <td><code>${product.barcode || "-"}</code></td>
          <td>${productTypeLabel(product.type)}</td>
          <td>${brand}</td>
          <td class="text-end">${Number(product.price || 0).toLocaleString("en-US")}</td>
          <td class="text-end"><span class="${status.stockClass}">${qty.toLocaleString()}</span></td>
          <td><span class="${status.badgeClass}"><span class="status-dot"></span>${status.label}</span></td>
          <td class="text-end">
            <div class="product-actions">
              <button class="action-btn action-edit" type="button" data-edit-product="${product.id}" title="Edit / Restock" aria-label="Edit">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="m4 20 4.5-1.2L19 8.3a2 2 0 0 0 0-2.8L18.5 5a2 2 0 0 0-2.8 0L5.2 15.5 4 20Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>
              </button>
              <button class="action-btn action-view" type="button" data-view-product="${product.id}" title="View" aria-label="View">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.7"/></svg>
              </button>
              <button class="action-btn action-delete" type="button" data-delete-product="${product.id}" title="Delete" aria-label="Delete">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M4 7h16M9 7V5h6v2m-8 0 1 12h8l1-12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
            </div>
          </td>
        </tr>`;
    }).join("")
    : `<tr><td colspan="10" class="text-center text-muted py-4">No products match your filters.</td></tr>`;

  const info = qs("#products-page-info");
  if (info) {
    if (!filtered.length) info.textContent = "Showing 0 products";
    else info.textContent = `Showing ${start + 1} – ${Math.min(start + pageSize, filtered.length)} of ${filtered.length} products`;
  }

  const pager = qs("#products-pagination");
  if (pager) {
    const buttons = [];
    buttons.push(`<button type="button" class="page-btn" data-products-page="${Math.max(1, state.productsPage - 1)}" ${state.productsPage <= 1 ? "disabled" : ""}>‹</button>`);
    for (let page = 1; page <= pageCount; page += 1) {
      if (pageCount > 7 && Math.abs(page - state.productsPage) > 2 && page !== 1 && page !== pageCount) {
        if (page === 2 || page === pageCount - 1) buttons.push(`<span class="page-ellipsis">…</span>`);
        continue;
      }
      buttons.push(`<button type="button" class="page-btn ${page === state.productsPage ? "active" : ""}" data-products-page="${page}">${page}</button>`);
    }
    buttons.push(`<button type="button" class="page-btn" data-products-page="${Math.min(pageCount, state.productsPage + 1)}" ${state.productsPage >= pageCount ? "disabled" : ""}>›</button>`);
    pager.innerHTML = buttons.join("");
  }

  const selectAll = qs("#products-select-all");
  if (selectAll) selectAll.checked = false;
}

function productTypeLabel(type) {
  if (type === "HA") return "Household Appliances";
  if (type === "IA") return "Industry Appliances";
  return type || "-";
}

function productBrand(product) {
  if (product?.brand) return product.brand;
  const purchase = state.purchases.find((item) => String(item.productId) === String(product?.id));
  return purchase?.supplierName || "-";
}

function getProductListFilters() {
  return {
    search: (qs("#products-search")?.value || "").trim().toLowerCase(),
    category: qs("#products-category-filter")?.value || "all",
    brand: qs("#products-brand-filter")?.value || "all",
    status: qs("#products-status-filter")?.value || "all"
  };
}

function matchesProductListFilters(product, filters) {
  const qty = Number(product.stockQty || 0);
  const threshold = lowStockThreshold();
  const brand = productBrand(product);

  if (filters.category !== "all" && product.type !== filters.category) return false;
  if (filters.brand !== "all" && brand !== filters.brand) return false;
  if (filters.status === "out" && qty > 0) return false;
  if (filters.status === "low" && (qty <= 0 || qty > threshold)) return false;
  if (filters.status === "healthy" && qty <= threshold) return false;

  if (filters.search) {
    const haystack = [product.name, product.sku, product.barcode, brand].join(" ").toLowerCase();
    if (!haystack.includes(filters.search)) return false;
  }
  return true;
}

function filteredProductsList() {
  const filters = getProductListFilters();
  return state.products
    .filter((product) => matchesProductListFilters(product, filters))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function populateProductBrandFilter() {
  const select = qs("#products-brand-filter");
  if (!select) return;
  const current = select.value || "all";
  const brands = [...new Set(state.products.map((product) => productBrand(product)).filter((brand) => brand && brand !== "-"))].sort((a, b) => a.localeCompare(b));
  select.innerHTML = [`<option value="all">All Brands</option>`, ...brands.map((brand) => `<option value="${brand.replace(/"/g, "&quot;")}">${brand}</option>`)].join("");
  select.value = brands.includes(current) || current === "all" ? current : "all";
}

function openProductFormModal(product = null) {
  fillProductForm(product || undefined);
  const title = qs("#product-form-modal-label");
  if (title) title.textContent = product?.id ? "Edit / Restock Product" : "Add New Product";
  bootstrap.Modal.getOrCreateInstance(qs("#product-form-modal")).show();
}

function openProductViewModal(productId) {
  const product = state.products.find((item) => item.id === productId);
  if (!product) return;
  state.viewingProductId = productId;
  const status = stockStatus(product.stockQty);
  qs("#product-view-body").innerHTML = `
    <div class="d-flex gap-3 mb-3">
      ${productImageHtml(product.imageUrl, product.name, "product-thumb product-thumb-lg")}
      <div>
        <h3 class="h5 mb-1">${product.name}</h3>
        <div class="text-muted small mb-2">${productTypeLabel(product.type)} · ${product.unit || "pcs"}</div>
        <span class="${status.badgeClass}"><span class="status-dot"></span>${status.label}</span>
      </div>
    </div>
    <div class="row g-3 small">
      <div class="col-6"><div class="text-muted">SKU</div><strong>${product.sku || "-"}</strong></div>
      <div class="col-6"><div class="text-muted">Barcode</div><strong>${product.barcode || "-"}</strong></div>
      <div class="col-6"><div class="text-muted">Brand</div><strong>${productBrand(product)}</strong></div>
      <div class="col-6"><div class="text-muted">Price</div><strong>${money(product.price)}</strong></div>
      <div class="col-6"><div class="text-muted">Stock</div><strong>${Number(product.stockQty || 0).toLocaleString()} ${product.unit || ""}</strong></div>
      <div class="col-6"><div class="text-muted">Landed cost</div><strong>${money(landedCost(product))}</strong></div>
    </div>
  `;
  bootstrap.Modal.getOrCreateInstance(qs("#product-view-modal")).show();
}

function renderInventory() {
  const metricsEl = qs("#inventory-metrics");
  const bodyEl = qs("#inventory-body");
  if (!metricsEl || !bodyEl) return;

  const metrics = inventoryMetrics();
  metricsEl.innerHTML = [
    `<div class="col-sm-6 col-xl"><div class="metric"><span>Total products</span><strong>${metrics.total}</strong></div></div>`,
    `<div class="col-sm-6 col-xl"><div class="metric"><span>Low stock (≤ ${metrics.threshold})</span><strong class="text-danger">${metrics.low}</strong></div></div>`,
    `<div class="col-sm-6 col-xl"><div class="metric"><span>Out of stock</span><strong class="text-danger">${metrics.out}</strong></div></div>`,
    `<div class="col-sm-6 col-xl"><div class="metric"><span>Healthy stock</span><strong class="text-success">${metrics.healthy}</strong></div></div>`,
    `<div class="col-sm-6 col-xl"><div class="metric"><span>Total stock value</span><strong>${money(metrics.stockValue)}</strong></div></div>`
  ].join("");

  const filters = getInventoryFilters();
  const products = state.products
    .filter((product) => matchesInventoryFilters(product, filters))
    .sort((a, b) => {
      const rankDiff = inventorySortRank(a) - inventorySortRank(b);
      if (rankDiff !== 0) return rankDiff;
      return a.name.localeCompare(b.name);
    });

  bodyEl.innerHTML = products.length
    ? products.map((product) => {
      const qty = Number(product.stockQty || 0);
      const unitCost = landedCost(product);
      const hasSales = productHasSales(product.id);
      const returnableQty = returnableQtyForProduct(product.id);
      const returnDisabled = returnableQty <= 0 ? "disabled" : "";
      const damageDisabled = !hasSales || qty <= 0 ? "disabled" : "";
      const returnTitle = returnableQty > 0
        ? `Return up to ${returnableQty.toLocaleString()} ${product.unit} (based on sales)`
        : "Return available only for sold qty not yet returned";
      return `
    <tr>
      <td class="product-image-cell">${productImageHtml(product.imageUrl, product.name)}</td>
      <td>
        <strong>${product.name}</strong>
        <div class="small text-muted">${product.unit}</div>
      </td>
      <td><code>${product.sku || "-"}</code></td>
      <td>${product.type}</td>
      <td class="text-end">${stockOnHandHtml(product.stockQty, product.unit)}</td>
      <td class="text-end">${money(unitCost)}</td>
      <td class="text-end">${money(product.price)}</td>
      <td class="text-end">${money(qty * unitCost)}</td>
      <td class="text-end">
        <div class="d-flex flex-wrap justify-content-end gap-1">
          <button class="btn btn-sm btn-outline-secondary" data-print-label="${product.id}">Print label</button>
          <button class="btn btn-sm btn-outline-success" data-return-product="${product.id}" ${returnDisabled} title="${returnTitle}">Return</button>
          <button class="btn btn-sm btn-outline-danger" data-damage-product="${product.id}" ${damageDisabled} title="${hasSales ? "Record damage" : "Available after first sale"}">Damage</button>
          <button class="btn btn-sm btn-outline-primary" data-restock-product="${product.id}">Restock</button>
        </div>
      </td>
    </tr>`;
    }).join("")
    : `<tr><td colspan="9" class="text-center text-muted py-4">No products match your filters.</td></tr>`;

  renderDamageLog();
  renderReturnLog();
}

function renderReturnLog() {
  const bodyEl = qs("#return-log-body");
  if (!bodyEl) return;

  bodyEl.innerHTML = state.stockReturns.length
    ? state.stockReturns.slice(0, 100).map((row) => `
    <tr>
      <td>${new Date(row.date).toLocaleDateString()}</td>
      <td>${row.productName}</td>
      <td><code>${row.sku || "-"}</code></td>
      <td class="text-end">${Number(row.qty || 0).toLocaleString()} ${row.unit || ""}</td>
      <td class="text-end">${money(row.refundValue)}</td>
      <td>${row.customerName || "-"}</td>
      <td>${row.note || "-"}</td>
      <td class="text-end">
        <div class="d-flex flex-wrap justify-content-end gap-1">
          <button class="btn btn-sm btn-outline-primary" data-edit-return="${row.id}">Edit</button>
          <button class="btn btn-sm btn-outline-danger" data-delete-return="${row.id}">Delete</button>
        </div>
      </td>
    </tr>`).join("")
    : `<tr><td colspan="8" class="text-center text-muted py-3">No return records yet.</td></tr>`;
}

function renderDamageLog() {
  const bodyEl = qs("#damage-log-body");
  if (!bodyEl) return;

  bodyEl.innerHTML = state.stockDamages.length
    ? state.stockDamages.slice(0, 100).map((row) => `
    <tr>
      <td>${new Date(row.date).toLocaleDateString()}</td>
      <td>${row.productName}</td>
      <td><code>${row.sku || "-"}</code></td>
      <td class="text-end">${Number(row.qty || 0).toLocaleString()} ${row.unit || ""}</td>
      <td class="text-end">${money(row.lossValue)}</td>
      <td>${row.note || "-"}</td>
      <td class="text-end">
        <div class="d-flex flex-wrap justify-content-end gap-1">
          <button class="btn btn-sm btn-outline-primary" data-edit-damage="${row.id}">Edit</button>
          <button class="btn btn-sm btn-outline-danger" data-delete-damage="${row.id}">Delete</button>
        </div>
      </td>
    </tr>`).join("")
    : `<tr><td colspan="7" class="text-center text-muted py-3">No damage records yet.</td></tr>`;
}

function renderProductSupplierSelect(preferredSupplierId = null) {
  const select = qs("#product-supplier");
  if (!select) return;

  const previous = preferredSupplierId || select.value;
  const supplierOptions = state.suppliers.map(
    (supplier) => `<option value="${supplier.id}">${supplier.name}</option>`
  );

  if (state.suppliers.length) {
    select.innerHTML = [
      ...supplierOptions,
      `<option value="__new__">+ New supplier</option>`
    ].join("");
    const keepPrevious = previous && previous !== "__new__" && state.suppliers.some((supplier) => String(supplier.id) === String(previous));
    select.value = keepPrevious ? String(previous) : String(state.suppliers[0].id);
  } else {
    select.innerHTML = `<option value="__new__">+ New supplier</option>`;
    select.value = "__new__";
  }

  toggleNewSupplierField();
}

function lastSupplierIdForProduct(productId) {
  if (!productId) return null;
  const purchase = state.purchases.find((item) => String(item.productId) === String(productId) && item.supplierId);
  return purchase?.supplierId || null;
}

function renderSuppliersTable() {
  qs("#suppliers-body").innerHTML = state.suppliers.map((supplier) => `
    <tr>
      <td>${supplier.name}</td>
      <td>${supplier.phone || ""}</td>
      <td>${supplier.address || ""}</td>
      <td class="text-end">
        <button class="btn btn-sm btn-outline-primary" data-edit-supplier="${supplier.id}">Edit</button>
        <button class="btn btn-sm btn-outline-danger" data-delete-supplier="${supplier.id}">Delete</button>
      </td>
    </tr>
  `).join("");
}

function toggleNewSupplierField() {
  const isNew = qs("#product-supplier").value === "__new__";
  qs("#new-supplier-wrap").classList.toggle("d-none", !isNew);
}

function fillSupplierForm(supplier) {
  qs("#supplier-id").value = supplier?.id || "";
  qs("#supplier-name").value = supplier?.name || "";
  qs("#supplier-phone").value = supplier?.phone || "";
  qs("#supplier-address").value = supplier?.address || "";
}

function fillProductForm(product) {
  const isEdit = Boolean(product?.id);
  qs("#product-id").value = product?.id || "";
  qs("#product-form-mode").textContent = isEdit ? "Restock existing product" : "New product";
  qs("#product-type").value = product?.type || "HA";
  qs("#product-type").disabled = isEdit;
  qs("#product-unit").value = product?.unit || "pcs";
  qs("#product-name").value = product?.name || "";
  qs("#product-name").readOnly = isEdit;
  if (qs("#product-brand")) qs("#product-brand").value = product?.brand || "";
  qs("#product-sku").value = product?.sku || "";
  qs("#product-barcode").value = product?.barcode || "";
  qs("#product-unit-cost").value = 0;
  qs("#product-batch-cogs").value = 0;
  qs("#product-qty").value = isEdit ? 1 : 1;
  qs("#product-margin").value = product?.marginPercent ?? "";
  qs("#product-payment").value = "paid";
  qs("#product-payment-type").value = "cash";
  qs("#product-new-supplier").value = "";
  qs("#product-image").value = "";
  setProductImagePreview(product?.imageUrl || "");
  qs("#display-stock").innerHTML = stockOnHandHtml(product?.stockQty || 0, product?.unit || qs("#product-unit").value);
  qs("#display-avg-cost").textContent = money(product?.cost || 0);
  qs("#display-avg-cogs").textContent = money(product?.cogs || 0);
  previewGeneratedCodes();
  updateComputedPrice(product);
  renderProductSupplierSelect(lastSupplierIdForProduct(product?.id));
}

function previewGeneratedCodes() {
  const existingId = qs("#product-id").value;
  const isEdit = Boolean(existingId);
  if (isEdit) return;

  const type = qs("#product-type").value;
  const name = qs("#product-name").value.trim();
  if (!name) {
    qs("#product-sku").value = "";
    qs("#product-barcode").value = "";
    return;
  }

  qs("#product-sku").value = generateSku(type, name, existingId || undefined);
  qs("#product-barcode").value = generateBarcode();
}

function updateComputedPrice(existing) {
  const draft = productDraftFromForm(existing || state.products.find((item) => item.id === qs("#product-id").value));
  qs("#display-avg-cost").textContent = money(draft.product.cost);
  qs("#display-avg-cogs").textContent = money(draft.product.cogs);
  qs("#display-stock").innerHTML = stockOnHandHtml(draft.product.stockQty, draft.product.unit);
  qs("#computed-product-price").textContent = money(draft.product.price);
}

async function resolveSupplier() {
  const selected = qs("#product-supplier").value;
  if (selected !== "__new__") {
    return state.suppliers.find((supplier) => supplier.id === selected);
  }

  const name = qs("#product-new-supplier").value.trim();
  if (!name) return null;

  const existing = state.suppliers.find((supplier) => supplier.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;

  return saveDoc("suppliers", {
    name,
    phone: "",
    createdAt: nowIso()
  });
}

async function saveProduct(event) {
  event.preventDefault();
  setSaveProductLoading(true);

  try {
    const existing = state.products.find((item) => item.id === qs("#product-id").value);
    const { product, qty, unitCost, batchCogs, cogsPerUnit } = productDraftFromForm(existing);

    if (!product.name) {
      showToast("Product name is required.");
      return;
    }

    const supplier = await resolveSupplier();
    if (qty > 0 && !supplier) {
      showToast("Supplier is required when adding stock.");
      return;
    }

    const savedProduct = await saveDoc(
      "products",
      existing ? product : { ...product, createdAt: nowIso() }
    );

    if (qty > 0) {
      const total = qty * unitCost + batchCogs;
      const purchase = await saveDoc("purchases", {
        date: nowIso(),
        supplierId: supplier.id,
        supplierName: supplier.name,
        productId: savedProduct.id,
        productName: savedProduct.name,
        qty,
        unitCost,
        batchCogs,
        cogsPerUnit,
        total,
        paymentStatus: qs("#product-payment").value,
        paymentType: qs("#product-payment-type").value || "cash"
      });

      if (purchase.paymentStatus === "payable") {
        await saveDoc("credits", {
          type: "payable",
          partyName: supplier.name,
          sourceId: purchase.id,
          amount: total,
          paidAmount: 0,
          status: "open",
          date: purchase.date
        });
      }
    }

    fillProductForm();
    bootstrap.Modal.getInstance(qs("#product-form-modal"))?.hide();
    await loadData();
    showToast(existing ? "Product restocked." : "Product saved.");
  } catch (error) {
    showToast(error.message || "Could not save product.");
  } finally {
    setSaveProductLoading(false);
  }
}

function addProductToCart(product, quantity = 1) {
  if (!product || Number(product.stockQty || 0) <= 0) {
    showToast("Product is out of stock.");
    return;
  }

  const addQty = Math.max(1, Math.round(Number(quantity || 1)));
  const existing = state.cart.find((item) => item.productId === product.id);
  if (existing) existing.qty = Math.max(1, Math.round(Number(existing.qty || 0) + addQty));
  else {
    state.cart.push({
      productId: product.id,
      name: product.name,
      barcode: product.barcode,
      unit: product.unit,
      price: Number(product.price || 0),
      qty: addQty
    });
  }

  renderCart();
  qs("#barcode-input").value = "";
  qs("#barcode-input").focus();
}

function cartSubtotal() {
  return state.cart.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.qty || 0), 0);
}

function getCartDiscount() {
  const subtotal = cartSubtotal();
  const type = qs("#discount-type")?.value || "none";
  const value = Number(qs("#discount-value")?.value || 0);
  let amount = 0;

  if (type === "percent") {
    amount = subtotal * (Math.min(Math.max(value, 0), 100) / 100);
  } else if (type === "manual") {
    amount = Math.min(Math.max(value, 0), subtotal);
  }

  amount = Math.round(amount);
  return {
    type,
    value: type === "none" ? 0 : value,
    amount,
    total: Math.max(0, subtotal - amount),
    subtotal
  };
}

function cartTotal() {
  return getCartDiscount().total;
}

function syncDiscountInputState() {
  const type = qs("#discount-type")?.value || "none";
  const input = qs("#discount-value");
  if (!input) return;
  input.disabled = type === "none";
  if (type === "none") input.value = 0;
  input.placeholder = type === "percent" ? "% off" : type === "manual" ? "MMK off" : "0";
}

function resetCheckoutDiscount() {
  if (qs("#discount-type")) qs("#discount-type").value = "none";
  if (qs("#discount-value")) qs("#discount-value").value = 0;
  syncDiscountInputState();
}

function renderCart() {
  qs("#cart-body").innerHTML = state.cart.map((item) => `
    <tr>
      <td>
        <strong>${item.name}</strong>
        <div class="small text-muted">${item.barcode} / ${item.unit}</div>
      </td>
      <td class="text-end">${money(item.price)}</td>
      <td class="text-center">
        <input class="form-control form-control-sm text-center cart-qty" data-cart-product="${item.productId}" type="number" min="1" step="1" value="${Math.max(1, Math.round(Number(item.qty || 1)))}">
      </td>
      <td class="text-end">${money(item.price * item.qty)}</td>
      <td class="text-end"><button class="btn btn-sm btn-outline-danger" data-remove-cart="${item.productId}">Remove</button></td>
    </tr>
  `).join("");

  const discount = getCartDiscount();
  qs("#cart-items").textContent = state.cart.reduce((sum, item) => sum + Number(item.qty || 0), 0).toLocaleString();
  qs("#cart-subtotal").textContent = money(discount.subtotal);
  qs("#cart-discount").textContent = discount.amount > 0
    ? `-${money(discount.amount)}${discount.type === "percent" ? ` (${discount.value}%)` : ""}`
    : money(0);
  qs("#cart-total").textContent = money(discount.total);
}

function renderReceipt(sale, items) {
  const discountAmount = Number(sale.discountAmount || 0);
  const subtotal = Number(sale.subtotal != null ? sale.subtotal : sale.total || 0);
  const receipt = `
    <h4>Electronics Shop</h4>
    <p class="text-center mb-2">Receipt #${sale.receiptNo}<br>${new Date(sale.date).toLocaleString()}</p>
    ${(items || []).map((item) => `
      <div>
        <strong>${item.name}</strong>
        <div class="receipt-line"><span>${item.qty} ${item.unit} x ${money(item.price)}</span><span>${money(item.lineTotal)}</span></div>
      </div>
    `).join("")}
    <hr>
    <div class="receipt-line"><span>Subtotal</span><span>${money(subtotal)}</span></div>
    ${discountAmount > 0 ? `<div class="receipt-line"><span>Discount${sale.discountType === "percent" ? ` (${sale.discountValue}%)` : ""}</span><span>-${money(discountAmount)}</span></div>` : ""}
    <div class="receipt-line"><strong>Total</strong><strong>${money(sale.total)}</strong></div>
    <div class="receipt-line"><span>Payment</span><span>${paymentTypeLabel(sale.paymentType)}</span></div>
    <p class="text-center mt-3 mb-0">Thank you</p>
  `;
  qs("#receipt-preview").innerHTML = receipt;
  state.lastReceipt = { sale, items };
}

function paymentTypeLabel(type) {
  const labels = {
    cash: "Cash",
    kpay: "KPay",
    kbz: "KBZ Mobile Banking",
    credit: "Credit sale"
  };
  return labels[type] || type || "-";
}

function findProductByBarcode(barcode) {
  const clean = barcode.trim().toLowerCase();
  return state.products.find((product) => String(product.barcode).toLowerCase() === clean && product.active !== false);
}

async function completeSale() {
  if (!state.cart.length) {
    showToast("Cart is empty.");
    return;
  }

  for (const item of state.cart) {
    const product = state.products.find((row) => row.id === item.productId);
    if (!product || Number(product.stockQty || 0) < Number(item.qty || 0)) {
      showToast(`${item.name} does not have enough stock.`);
      return;
    }
  }

  const discount = getCartDiscount();
  const sale = await saveDoc("sales", {
    receiptNo: `S-${Date.now()}`,
    date: nowIso(),
    userId: state.user.id || state.user.uid,
    customerName: qs("#customer-name").value.trim(),
    paymentType: qs("#payment-type").value,
    subtotal: discount.subtotal,
    discountType: discount.type,
    discountValue: discount.value,
    discountAmount: discount.amount,
    total: discount.total
  });

  const savedItems = [];
  for (const item of state.cart) {
    const saleItem = await saveDoc("saleItems", {
      saleId: sale.id,
      productId: item.productId,
      name: item.name,
      barcode: item.barcode,
      unit: item.unit,
      price: item.price,
      qty: item.qty,
      lineTotal: item.price * item.qty,
      date: sale.date
    });
    savedItems.push(saleItem);

    const product = state.products.find((row) => row.id === item.productId);
    await saveDoc("products", {
      ...product,
      stockQty: Number(product.stockQty || 0) - Number(item.qty || 0),
      updatedAt: nowIso()
    });
  }

  if (sale.paymentType === "credit") {
    await saveDoc("credits", {
      type: "receivable",
      partyName: sale.customerName || "Walk-in customer",
      sourceId: sale.id,
      amount: sale.total,
      paidAmount: 0,
      status: "open",
      date: sale.date
    });
  }

  renderReceipt(sale, savedItems);
  state.cart = [];
  qs("#customer-name").value = "";
  resetCheckoutDiscount();
  renderCart();
  await loadData();
  showToast("Sale completed.");
}

function renderPurchases() {
  const supplierById = Object.fromEntries(state.suppliers.map((supplier) => [supplier.id, supplier.name]));
  const productById = Object.fromEntries(state.products.map((product) => [product.id, product.name]));
  qs("#purchases-body").innerHTML = state.purchases.slice(0, 30).map((purchase) => `
    <tr>
      <td>${new Date(purchase.date).toLocaleDateString()}</td>
      <td>${supplierById[purchase.supplierId] || purchase.supplierName || "-"}</td>
      <td>${productById[purchase.productId] || purchase.productName || "-"}</td>
      <td class="text-end">${Number(purchase.qty || 0).toLocaleString()}</td>
      <td class="text-end">${money(purchase.total)}</td>
      <td>${purchase.paymentStatus || "paid"}${purchase.paymentStatus === "paid" && purchase.paymentType ? ` · ${paymentTypeLabel(purchase.paymentType)}` : ""}</td>
    </tr>
  `).join("") || `<tr><td colspan="6" class="text-muted">No purchases yet.</td></tr>`;
}

function renderCredits() {
  qs("#credits-body").innerHTML = state.credits.map((credit) => `
    <tr>
      <td><span class="badge ${credit.type === "receivable" ? "text-bg-success" : "text-bg-warning"}">${credit.type}</span></td>
      <td>${credit.partyName}</td>
      <td class="text-end">${money(credit.amount)}</td>
      <td class="text-end">${money(credit.paidAmount)}</td>
      <td>${credit.status}</td>
    </tr>
  `).join("");

  const openCredits = state.credits.filter((credit) => credit.status !== "paid");
  qs("#credit-select").innerHTML = openCredits.map((credit) => `
    <option value="${credit.id}">${credit.type}: ${credit.partyName} (${money(Number(credit.amount) - Number(credit.paidAmount || 0))} left)</option>
  `).join("") || "<option value=''>No open credits</option>";
}

async function recordCreditPayment(event) {
  event.preventDefault();
  const credit = state.credits.find((item) => item.id === qs("#credit-select").value);
  const amount = numberValue("#credit-payment-amount");
  if (!credit || amount <= 0) {
    showToast("Select a credit and amount.");
    return;
  }

  const paymentType = qs("#credit-payment-type").value || "cash";
  const paidAmount = Number(credit.paidAmount || 0) + amount;
  await saveDoc("creditPayments", {
    creditId: credit.id,
    amount,
    paymentType,
    date: nowIso()
  });
  await saveDoc("credits", {
    ...credit,
    paidAmount,
    status: paidAmount >= Number(credit.amount || 0) ? "paid" : "open"
  });

  qs("#credit-payment-amount").value = "";
  qs("#credit-payment-type").value = "cash";
  await loadData();
  showToast(`Payment recorded (${paymentTypeLabel(paymentType)}).`);
}

function renderExpenses() {
  qs("#expenses-body").innerHTML = state.expenses.map((expense) => `
    <tr>
      <td>${new Date(expense.date).toLocaleDateString()}</td>
      <td>${expense.category}</td>
      <td>${expense.note || ""}</td>
      <td class="text-end">${money(expense.amount)}</td>
    </tr>
  `).join("");
}

function filterByPeriod(rows, period) {
  if (period === "all") return rows;
  const now = new Date();
  return rows.filter((row) => {
    const date = new Date(row.date);
    if (period === "year") return date.getFullYear() === now.getFullYear();
    return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
  });
}

function productTypeById(productId) {
  const product = state.products.find((item) => String(item.id) === String(productId));
  return product?.type || null;
}

function resolveItemProductType(item) {
  return productTypeById(item.productId) || (String(item.sku || item.barcode || "").startsWith("IA") ? "IA" : "HA");
}

function reportData(period = "month") {
  const sales = filterByPeriod(state.sales, period);
  const purchases = filterByPeriod(state.purchases, period);
  const expenses = filterByPeriod(state.expenses, period);
  const saleIds = new Set(sales.map((sale) => sale.id));
  const saleItems = state.saleItems.filter((item) => saleIds.has(item.saleId));
  const receivables = state.credits.filter((item) => item.type === "receivable" && item.status !== "paid");
  const payables = state.credits.filter((item) => item.type === "payable" && item.status !== "paid");

  const salesHa = saleItems
    .filter((item) => resolveItemProductType(item) === "HA")
    .reduce((sum, item) => sum + Number(item.lineTotal || 0), 0);
  const salesIa = saleItems
    .filter((item) => resolveItemProductType(item) === "IA")
    .reduce((sum, item) => sum + Number(item.lineTotal || 0), 0);

  const purchasesHa = purchases
    .filter((item) => (productTypeById(item.productId) || "HA") === "HA")
    .reduce((sum, item) => sum + Number(item.total || 0), 0);
  const purchasesIa = purchases
    .filter((item) => productTypeById(item.productId) === "IA")
    .reduce((sum, item) => sum + Number(item.total || 0), 0);

  const salesTotal = salesHa + salesIa;
  const purchaseTotal = purchasesHa + purchasesIa;
  // Profit only when there are sales for that type (unsold stock purchases are ignored).
  const profitHa = salesHa > 0 ? Math.abs(salesHa - purchasesHa) : 0;
  const profitIa = salesIa > 0 ? Math.abs(salesIa - purchasesIa) : 0;
  const expenseTotal = expenses.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const receivableTotal = receivables.reduce((sum, item) => sum + Number(item.amount || 0) - Number(item.paidAmount || 0), 0);
  const payableTotal = payables.reduce((sum, item) => sum + Number(item.amount || 0) - Number(item.paidAmount || 0), 0);
  const stockValue = state.products.reduce(
    (sum, item) => sum + Number(item.stockQty || 0) * (Number(item.cost || 0) + Number(item.cogs || 0)),
    0
  );

  return {
    salesTotal,
    salesHa,
    salesIa,
    purchaseTotal,
    purchasesHa,
    purchasesIa,
    profitHa,
    profitIa,
    expenseTotal,
    receivableTotal,
    payableTotal,
    stockValue
  };
}

function metricCard(label, value) {
  return `<div class="col-sm-6 col-xl-3"><div class="metric"><span>${label}</span><strong>${money(value)}</strong></div></div>`;
}

function metricCardPlain(label, value) {
  const amount = Math.abs(Number(value || 0)).toLocaleString("en-US");
  return `<div class="col-sm-6 col-xl-3"><div class="metric"><span>${label}</span><strong>${amount} MMK</strong></div></div>`;
}

function reportPeriodLabel(period) {
  if (period === "year") return "This year";
  if (period === "all") return "All time";
  return "This month";
}

function getReportPeriod() {
  return qs("#report-period")?.value || "month";
}

function buildDetailedReport(period = "month") {
  const summary = reportData(period);
  const sales = filterByPeriod(state.sales, period);
  const purchases = filterByPeriod(state.purchases, period);
  const expenses = filterByPeriod(state.expenses, period);
  const saleIds = new Set(sales.map((sale) => sale.id));
  const saleItems = state.saleItems.filter((item) => saleIds.has(item.saleId));
  const salesById = Object.fromEntries(sales.map((sale) => [sale.id, sale]));
  const saleItemsHa = saleItems.filter((item) => resolveItemProductType(item) === "HA");
  const saleItemsIa = saleItems.filter((item) => resolveItemProductType(item) === "IA");
  const purchasesHa = purchases.filter((item) => (productTypeById(item.productId) || "HA") === "HA");
  const purchasesIa = purchases.filter((item) => productTypeById(item.productId) === "IA");

  return {
    period,
    periodLabel: reportPeriodLabel(period),
    generatedAt: new Date().toLocaleString(),
    summary,
    sales,
    saleItems,
    saleItemsHa,
    saleItemsIa,
    salesById,
    purchases,
    purchasesHa,
    purchasesIa,
    expenses,
    credits: state.credits
  };
}

function reportTable(title, headers, rows, emptyText = "No records for this period.") {
  const head = `<tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr>`;
  const body = rows.length
    ? rows.map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")
    : `<tr><td colspan="${headers.length}" class="text-center text-muted py-3">${emptyText}</td></tr>`;

  return `
    <div class="panel mb-4">
      <h3 class="h5 mb-3">${title}</h3>
      <div class="table-responsive">
        <table class="table table-sm align-middle mb-0">
          <thead>${head}</thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </div>`;
}

function renderReportDetails(report) {
  const detailEl = qs("#reports-detail");
  if (!detailEl) return;

  const saleItemRowMapper = (item) => {
    const sale = report.salesById[item.saleId];
    return [
      new Date(item.date || sale?.date).toLocaleDateString(),
      sale?.receiptNo || "-",
      item.name,
      Number(item.qty || 0).toLocaleString(),
      `<span class="text-end d-block">${money(item.price)}</span>`,
      `<span class="text-end d-block">${money(item.lineTotal)}</span>`
    ];
  };

  const purchaseRowMapper = (purchase) => [
    new Date(purchase.date).toLocaleDateString(),
    purchase.supplierName || "-",
    purchase.productName || "-",
    `<span class="text-end d-block">${Number(purchase.qty || 0).toLocaleString()}</span>`,
    `<span class="text-end d-block">${money(purchase.total)}</span>`,
    `${purchase.paymentStatus || "-"}${purchase.paymentType ? ` · ${paymentTypeLabel(purchase.paymentType)}` : ""}`
  ];

  const expenseRows = report.expenses.map((expense) => [
    new Date(expense.date).toLocaleDateString(),
    expense.category,
    expense.note || "-",
    `<span class="text-end d-block">${money(expense.amount)}</span>`
  ]);

  const creditRows = report.credits.map((credit) => [
    credit.type,
    credit.partyName || "-",
    `<span class="text-end d-block">${money(credit.amount)}</span>`,
    `<span class="text-end d-block">${money(credit.paidAmount)}</span>`,
    `<span class="text-end d-block">${money(Number(credit.amount || 0) - Number(credit.paidAmount || 0))}</span>`,
    credit.status
  ]);

  detailEl.innerHTML = `
    <div class="mb-3 small text-muted">Detailed report for ${report.periodLabel}. Generated ${report.generatedAt}.</div>
    ${reportTable("Sales report — HA", ["Date", "Receipt", "Product", "Qty", "Price", "Line total"], report.saleItemsHa.map(saleItemRowMapper), "No HA sales in this period.")}
    ${reportTable("Sales report — IA", ["Date", "Receipt", "Product", "Qty", "Price", "Line total"], report.saleItemsIa.map(saleItemRowMapper), "No IA sales in this period.")}
    ${reportTable("Purchase report — HA", ["Date", "Supplier", "Product", "Qty", "Total", "Payment"], report.purchasesHa.map(purchaseRowMapper), "No HA purchases in this period.")}
    ${reportTable("Purchase report — IA", ["Date", "Supplier", "Product", "Qty", "Total", "Payment"], report.purchasesIa.map(purchaseRowMapper), "No IA purchases in this period.")}
    ${reportTable("Expenses", ["Date", "Category", "Note", "Amount"], expenseRows)}
    ${reportTable("Credit", ["Type", "Party", "Amount", "Paid", "Balance", "Status"], creditRows, "No credit records.")}
  `;
}

function excelMoney(value) {
  return Number(value || 0);
}

function appendExcelSheet(workbook, XLSX, name, rows) {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, name.slice(0, 31));
}

async function exportReportExcel() {
  const report = buildDetailedReport(getReportPeriod());

  try {
    const XLSX = await import("https://esm.sh/xlsx@0.18.5");
    const workbook = XLSX.utils.book_new();

    appendExcelSheet(workbook, XLSX, "Summary", [
      ["Electronics Shop POS Report"],
      ["Period", report.periodLabel],
      ["Generated", report.generatedAt],
      [],
      ["Metric", "Amount (MMK)"],
      ["Sales report HA", excelMoney(report.summary.salesHa)],
      ["Sales report IA", excelMoney(report.summary.salesIa)],
      ["Sales total", excelMoney(report.summary.salesTotal)],
      ["Purchase report HA", excelMoney(report.summary.purchasesHa)],
      ["Purchase report IA", excelMoney(report.summary.purchasesIa)],
      ["Purchase total", excelMoney(report.summary.purchaseTotal)],
      ["Profit HA", Math.abs(excelMoney(report.summary.profitHa))],
      ["Profit IA", Math.abs(excelMoney(report.summary.profitIa))],
      ["Expense total", excelMoney(report.summary.expenseTotal)],
      ["Receivable balance", excelMoney(report.summary.receivableTotal)],
      ["Payable balance", excelMoney(report.summary.payableTotal)],
      ["Stock value", excelMoney(report.summary.stockValue)],
      [],
      ["Sales count", report.sales.length],
      ["Sale items HA", report.saleItemsHa.length],
      ["Sale items IA", report.saleItemsIa.length],
      ["Purchases HA", report.purchasesHa.length],
      ["Purchases IA", report.purchasesIa.length],
      ["Expenses count", report.expenses.length]
    ]);

    appendExcelSheet(workbook, XLSX, "Sales HA", [
      ["Date", "Receipt", "Product", "Barcode", "Unit", "Qty", "Price (MMK)", "Line total (MMK)"],
      ...report.saleItemsHa.map((item) => {
        const sale = report.salesById[item.saleId];
        return [
          new Date(item.date || sale?.date).toLocaleDateString(),
          sale?.receiptNo || "",
          item.name || "",
          item.barcode || "",
          item.unit || "",
          Number(item.qty || 0),
          excelMoney(item.price),
          excelMoney(item.lineTotal)
        ];
      })
    ]);

    appendExcelSheet(workbook, XLSX, "Sales IA", [
      ["Date", "Receipt", "Product", "Barcode", "Unit", "Qty", "Price (MMK)", "Line total (MMK)"],
      ...report.saleItemsIa.map((item) => {
        const sale = report.salesById[item.saleId];
        return [
          new Date(item.date || sale?.date).toLocaleDateString(),
          sale?.receiptNo || "",
          item.name || "",
          item.barcode || "",
          item.unit || "",
          Number(item.qty || 0),
          excelMoney(item.price),
          excelMoney(item.lineTotal)
        ];
      })
    ]);

    appendExcelSheet(workbook, XLSX, "Purchases HA", [
      ["Date", "Supplier", "Product", "Qty", "Unit cost (MMK)", "Batch COGS (MMK)", "Total (MMK)", "Payment", "Payment type"],
      ...report.purchasesHa.map((purchase) => [
        new Date(purchase.date).toLocaleDateString(),
        purchase.supplierName || "",
        purchase.productName || "",
        Number(purchase.qty || 0),
        excelMoney(purchase.unitCost),
        excelMoney(purchase.batchCogs),
        excelMoney(purchase.total),
        purchase.paymentStatus || "",
        paymentTypeLabel(purchase.paymentType)
      ])
    ]);

    appendExcelSheet(workbook, XLSX, "Purchases IA", [
      ["Date", "Supplier", "Product", "Qty", "Unit cost (MMK)", "Batch COGS (MMK)", "Total (MMK)", "Payment", "Payment type"],
      ...report.purchasesIa.map((purchase) => [
        new Date(purchase.date).toLocaleDateString(),
        purchase.supplierName || "",
        purchase.productName || "",
        Number(purchase.qty || 0),
        excelMoney(purchase.unitCost),
        excelMoney(purchase.batchCogs),
        excelMoney(purchase.total),
        purchase.paymentStatus || "",
        paymentTypeLabel(purchase.paymentType)
      ])
    ]);

    appendExcelSheet(workbook, XLSX, "Expenses", [
      ["Date", "Category", "Note", "Amount (MMK)"],
      ...report.expenses.map((expense) => [
        new Date(expense.date).toLocaleDateString(),
        expense.category || "",
        expense.note || "",
        excelMoney(expense.amount)
      ])
    ]);

    appendExcelSheet(workbook, XLSX, "Credit", [
      ["Type", "Party", "Amount (MMK)", "Paid (MMK)", "Balance (MMK)", "Status", "Date"],
      ...report.credits.map((credit) => [
        credit.type || "",
        credit.partyName || "",
        excelMoney(credit.amount),
        excelMoney(credit.paidAmount),
        excelMoney(Number(credit.amount || 0) - Number(credit.paidAmount || 0)),
        credit.status || "",
        new Date(credit.date).toLocaleDateString()
      ])
    ]);

    const fileName = `electronics-pos-report-${report.period}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(workbook, fileName);
    showToast("Report exported to Excel.");
  } catch (error) {
    showToast(`Export failed: ${error.message}`);
  }
}

function renderReports() {
  const period = getReportPeriod();
  const report = buildDetailedReport(period);
  const data = report.summary;

  qs("#reports-output").innerHTML = [
    metricCard("Sales report HA", data.salesHa),
    metricCard("Sales report IA", data.salesIa),
    metricCard("Purchase report HA", data.purchasesHa),
    metricCard("Purchase report IA", data.purchasesIa),
    metricCardPlain("Profit HA", data.profitHa),
    metricCardPlain("Profit IA", data.profitIa),
    metricCard("Stock report", data.stockValue),
    metricCard("Credit to receive", data.receivableTotal),
    metricCard("Credit to pay", data.payableTotal),
    metricCard("Expenses report", data.expenseTotal),
    `<div class="col-sm-6 col-xl-3"><div class="metric"><span>Sales count</span><strong>${report.sales.length}</strong></div></div>`
  ].join("");

  renderReportDetails(report);
}

function printReceipt() {
  if (!qs("#receipt-preview").innerHTML && state.lastReceipt) {
    renderReceipt(state.lastReceipt.sale, state.lastReceipt.items);
  }

  if (!qs("#receipt-preview").innerHTML) {
    showToast("No receipt to print.");
    return;
  }

  window.print();
}

function printBarcodeLabelsForProducts(products) {
  if (!products.length) {
    showToast("No products to print.");
    return;
  }

  let area = qs("#label-print-area");
  if (area) area.remove();

  area = document.createElement("div");
  area.id = "label-print-area";
  area.className = "barcode-grid";
  area.innerHTML = products.map((product) => {
    const safeId = String(product.id).replace(/[^a-zA-Z0-9]/g, "");
    return `
    <div class="barcode-label">
      <strong>${product.name}</strong>
      <svg id="barcode-${safeId}"></svg>
      <div>${money(product.price)}</div>
    </div>`;
  }).join("");
  document.body.append(area);

  products.forEach((product) => {
    const safeId = String(product.id).replace(/[^a-zA-Z0-9]/g, "");
    JsBarcode(`#barcode-${safeId}`, product.barcode, {
      format: "CODE128",
      width: 1.4,
      height: 38,
      displayValue: true,
      fontSize: 10,
      margin: 2
    });
  });

  window.print();
  setTimeout(() => area.remove(), 1000);
}

function printBarcodeLabels() {
  printBarcodeLabelsForProducts(state.products);
}

function printProductLabel(productId) {
  const product = state.products.find((item) => item.id === productId);
  if (!product) {
    showToast("Product not found.");
    return;
  }
  printBarcodeLabelsForProducts([product]);
}

function bindEvents() {
  window.addEventListener("hashchange", showRoute);

  qs("#sidebar-toggle")?.addEventListener("click", () => {
    const open = !qs("#app-shell")?.classList.contains("sidebar-open");
    setSidebarOpen(open);
  });
  qs("#sidebar-backdrop")?.addEventListener("click", () => setSidebarOpen(false));
  qs("#products-nav-toggle")?.addEventListener("click", () => {
    const group = qs('[data-group="products"]');
    setProductsNavOpen(!group?.classList.contains("open"));
  });

  qs("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setLoginLoading(true, "Signing in...");
    qs("#auth-message").textContent = "";
    state.handlingLogin = true;

    try {
      if (!state.isSupabaseReady) {
        await enterApp(demoUser);
        return;
      }

      const { data, error } = await supabase.auth.signInWithPassword({
        email: qs("#login-email").value.trim(),
        password: qs("#login-password").value
      });
      if (error) throw error;

      const profile = await getUserProfile(data.user);
      await enterApp(profile);
    } catch (error) {
      qs("#auth-message").textContent = error.message;
    } finally {
      state.handlingLogin = false;
      setLoginLoading(false);
    }
  });

  qs("#logout-btn").addEventListener("click", signOutUser);

  [
    "#product-unit-cost",
    "#product-batch-cogs",
    "#product-qty",
    "#product-margin",
    "#current-fx",
    "#base-fx",
    "#round-to"
  ].forEach((selector) => {
    qs(selector).addEventListener("input", () => updateComputedPrice());
  });

  ["#product-type", "#product-name"].forEach((selector) => {
    qs(selector).addEventListener("input", previewGeneratedCodes);
    qs(selector).addEventListener("change", previewGeneratedCodes);
  });

  qs("#product-supplier").addEventListener("change", toggleNewSupplierField);

  qs("#product-form").addEventListener("submit", saveProduct);
  qs("#product-image").addEventListener("change", handleProductImageChange);
  qs("#clear-product-image").addEventListener("click", clearProductImage);

  qs("#reset-product-form").addEventListener("click", () => {
    const idValue = qs("#product-id").value;
    fillProductForm(idValue ? state.products.find((product) => product.id === idValue) : undefined);
  });

  qs("#add-product-btn")?.addEventListener("click", () => openProductFormModal());
  qs("#products-search")?.addEventListener("input", () => {
    state.productsPage = 1;
    renderProducts();
  });
  ["#products-category-filter", "#products-brand-filter", "#products-status-filter", "#products-page-size"].forEach((selector) => {
    qs(selector)?.addEventListener("change", () => {
      if (selector === "#products-page-size") state.productsPage = 1;
      else state.productsPage = 1;
      renderProducts();
    });
  });
  qs("#products-filter-reset")?.addEventListener("click", () => {
    if (qs("#products-search")) qs("#products-search").value = "";
    if (qs("#products-category-filter")) qs("#products-category-filter").value = "all";
    if (qs("#products-brand-filter")) qs("#products-brand-filter").value = "all";
    if (qs("#products-status-filter")) qs("#products-status-filter").value = "all";
    state.productsPage = 1;
    renderProducts();
  });
  qs("#products-pagination")?.addEventListener("click", (event) => {
    const page = event.target.closest("[data-products-page]")?.dataset.productsPage;
    if (!page) return;
    state.productsPage = Number(page);
    renderProducts();
  });
  qs("#products-select-all")?.addEventListener("change", (event) => {
    qsa(".product-row-check").forEach((box) => {
      box.checked = event.target.checked;
    });
  });
  qs("#product-view-edit-btn")?.addEventListener("click", () => {
    const product = state.products.find((item) => item.id === state.viewingProductId);
    bootstrap.Modal.getInstance(qs("#product-view-modal"))?.hide();
    if (product) openProductFormModal(product);
  });

  qs("#products-body").addEventListener("click", async (event) => {
    const editBtn = event.target.closest("[data-edit-product]");
    const viewBtn = event.target.closest("[data-view-product]");
    const deleteBtn = event.target.closest("[data-delete-product]");
    const editId = editBtn?.dataset.editProduct;
    const viewId = viewBtn?.dataset.viewProduct;
    const deleteId = deleteBtn?.dataset.deleteProduct;
    if (editId) openProductFormModal(state.products.find((product) => product.id === editId));
    if (viewId) openProductViewModal(viewId);
    if (deleteId && confirm("Delete this product?")) {
      await removeDoc("products", deleteId);
      await loadData();
      showToast("Product deleted.");
    }
  });

  qs("#settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const settings = {
        id: "main",
        baseFx: numberValue("#base-fx"),
        currentFx: numberValue("#current-fx"),
        roundTo: numberValue("#round-to"),
        defaultMargin: numberValue("#default-margin"),
        lowStockThreshold: numberValue("#low-stock-threshold"),
        marginBands: JSON.parse(qs("#margin-bands").value),
        updatedAt: nowIso()
      };
      await saveDoc("settings", settings);
      state.settings = settings;
      await loadData();
      showToast("Settings saved.");
    } catch (error) {
      showToast(`Invalid settings: ${error.message}`);
    }
  });

  qs("#reprice-btn").addEventListener("click", async () => {
    for (const product of state.products) {
      await saveDoc("products", { ...product, price: calculatePrice(product), updatedAt: nowIso() });
    }
    await loadData();
    showToast("All product prices recalculated.");
  });

  qs("#add-barcode-btn").addEventListener("click", () => {
    const product = findProductByBarcode(qs("#barcode-input").value);
    if (!product) showToast("Product not found.");
    else addProductToCart(product);
  });

  qs("#barcode-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      qs("#add-barcode-btn").click();
    }
  });

  qs("#cart-body").addEventListener("input", (event) => {
    if (!event.target.classList.contains("cart-qty")) return;
    const item = state.cart.find((row) => row.productId === event.target.dataset.cartProduct);
    if (item) {
      item.qty = Math.max(1, Math.round(Number(event.target.value || 1)));
      event.target.value = item.qty;
    }
    renderCart();
  });

  qs("#cart-body").addEventListener("click", (event) => {
    const removeId = event.target.dataset.removeCart;
    if (!removeId) return;
    state.cart = state.cart.filter((item) => item.productId !== removeId);
    renderCart();
  });

  qs("#checkout-btn").addEventListener("click", completeSale);
  qs("#discount-type")?.addEventListener("change", () => {
    syncDiscountInputState();
    renderCart();
  });
  qs("#discount-value")?.addEventListener("input", renderCart);
  qs("#print-last-receipt").addEventListener("click", printReceipt);
  qs("#print-labels-btn").addEventListener("click", printBarcodeLabels);

  qs("#supplier-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const supplierId = qs("#supplier-id").value;
    const payload = {
      name: qs("#supplier-name").value.trim(),
      phone: qs("#supplier-phone").value.trim(),
      address: qs("#supplier-address").value.trim()
    };
    if (supplierId) payload.id = supplierId;
    else payload.createdAt = nowIso();

    await saveDoc("suppliers", payload);
    fillSupplierForm();
    await loadData();
    showToast("Supplier saved.");
  });

  qs("#reset-supplier-form").addEventListener("click", () => fillSupplierForm());

  qs("#suppliers-body").addEventListener("click", async (event) => {
    const editId = event.target.dataset.editSupplier;
    const deleteId = event.target.dataset.deleteSupplier;
    if (editId) fillSupplierForm(state.suppliers.find((supplier) => supplier.id === editId));
    if (deleteId && confirm("Delete this supplier?")) {
      await removeDoc("suppliers", deleteId);
      await loadData();
      showToast("Supplier deleted.");
    }
  });
  qs("#credit-payment-form").addEventListener("submit", recordCreditPayment);

  qs("#expense-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveDoc("expenses", {
      date: nowIso(),
      category: qs("#expense-category").value.trim(),
      amount: numberValue("#expense-amount"),
      note: qs("#expense-note").value.trim()
    });
    event.target.reset();
    await loadData();
    showToast("Expense saved.");
  });

  qs("#refresh-inventory")?.addEventListener("click", loadData);
  ["#inventory-search", "#inventory-status-filter", "#inventory-type-filter"].forEach((selector) => {
    qs(selector)?.addEventListener("input", renderInventory);
    qs(selector)?.addEventListener("change", renderInventory);
  });
  qs("#inventory-body")?.addEventListener("click", (event) => {
    const printId = event.target.dataset.printLabel;
    const returnId = event.target.dataset.returnProduct;
    const damageId = event.target.dataset.damageProduct;
    const productId = event.target.dataset.restockProduct;
    if (printId) printProductLabel(printId);
    if (returnId) openReturnModal(returnId);
    if (damageId) openDamageModal(damageId);
    if (productId) openProductRestock(productId);
  });
  qs("#damage-product-form")?.addEventListener("submit", recordProductDamage);
  qs("#return-product-form")?.addEventListener("submit", recordProductReturn);
  qs("#return-log-body")?.addEventListener("click", (event) => {
    const editId = event.target.dataset.editReturn;
    const deleteId = event.target.dataset.deleteReturn;
    if (editId) openReturnEditModal(editId);
    if (deleteId) deleteReturnRecord(deleteId);
  });
  qs("#damage-log-body")?.addEventListener("click", (event) => {
    const editId = event.target.dataset.editDamage;
    const deleteId = event.target.dataset.deleteDamage;
    if (editId) openDamageEditModal(editId);
    if (deleteId) deleteDamageRecord(deleteId);
  });
  qs("#build-report").addEventListener("click", renderReports);
  qs("#export-report-excel").addEventListener("click", exportReportExcel);
  qs("#report-period").addEventListener("change", renderReports);
}

async function restoreSession(user) {
  if (!user || state.handlingLogin) return;
  if (state.user?.id === user.id) return;

  try {
    const profile = await getUserProfile(user);
    await enterApp(profile);
  } catch (error) {
    qs("#auth-message").textContent = error.message || "Could not restore session. Please sign in.";
    setLoginLoading(false);
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch (_error) {
      // Ignore sign-out errors while recovering the login form.
    }
  } finally {
    setLoginLoading(false);
  }
}

function initSupabase() {
  if (!state.isSupabaseReady) return;
  supabase = createClient(supabaseConfig.url, supabaseConfig.anonKey);

  // Keep the callback sync and defer async work. Awaiting Supabase queries
  // inside onAuthStateChange can deadlock the auth client and freeze login.
  supabase.auth.onAuthStateChange((event, session) => {
    if (state.handlingLogin) return;

    if (event === "SIGNED_OUT") {
      if (state.user) leaveApp();
      setLoginLoading(false);
      return;
    }

    if (!session?.user) {
      setLoginLoading(false);
      return;
    }

    if (event !== "INITIAL_SESSION" && event !== "SIGNED_IN") return;
    if (state.user?.id === session.user.id) return;

    const user = session.user;
    setTimeout(() => {
      restoreSession(user);
    }, 0);
  });
}

function init() {
  bindEvents();
  setLoginLoading(false);
  initSupabase();
  fillProductForm();
  fillSupplierForm();
  syncDiscountInputState();

  const authMessage = qs("#auth-message");
  if (state.isSupabaseReady) {
    authMessage.textContent = "Connected to Supabase. Sign in with your shop email and password.";
  } else {
    authMessage.innerHTML = "Configure Supabase in <code>assets/js/supabase-config.js</code>. Demo mode is used until real config is added.";
    qs("#login-email").value = demoUser.email;
    qs("#login-password").value = "demo";
  }
}

init();
