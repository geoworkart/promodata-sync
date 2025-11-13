const express = require('express');
const cors = require('cors');
const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// In-memory store. In a production app, use a database.
let jobs = {};
let jobCounter = 1;
const createJobId = () => `JOB-${String(jobCounter++).padStart(5, '0')}`;

// Default settings, can be overwritten by POST /api/settings
let settings = {
    rules: { defaultMargin: 30, conditionalRules: [] },
    mappings: { categories: [], fields: [] },
    notifications: { email: '', onSuccess: false, onFailure: true },
    advanced: { requestsPerMinute: 60 }
};
// In-memory sets for ignored items
let ignoredSupplierIds = new Set();
let ignoredCategoryIds = new Set();


// --- API Endpoints ---

// Health check
app.get('/', (req, res) => {
    res.status(200).send('Promodata Sync Backend is running.');
});

// Settings
app.get('/api/settings', (req, res) => {
    res.status(200).json(settings);
});
app.post('/api/settings', (req, res) => {
    console.log('[Backend] Received settings update:', req.body);
    settings = { ...settings, ...req.body };
    res.status(200).json(settings);
});

// Ignored Suppliers
app.get('/api/ignored-suppliers', (req, res) => {
    res.status(200).json({ supplier_ids: Array.from(ignoredSupplierIds) });
});
app.post('/api/ignored-suppliers', (req, res) => {
    const { supplier_ids } = req.body;
    if (Array.isArray(supplier_ids)) {
        supplier_ids.forEach(id => ignoredSupplierIds.add(id));
        res.status(200).json({ success: true, count: ignoredSupplierIds.size });
    } else {
        res.status(400).json({ error: 'supplier_ids must be an array.' });
    }
});
app.delete('/api/ignored-suppliers', (req, res) => {
    const { supplier_ids } = req.body;
     if (Array.isArray(supplier_ids)) {
        supplier_ids.forEach(id => ignoredSupplierIds.delete(id));
        res.status(200).json({ success: true, count: ignoredSupplierIds.size });
    } else {
        res.status(400).json({ error: 'supplier_ids must be an array.' });
    }
});


// Ignored Categories
app.get('/api/ignored-categories', (req, res) => {
    res.status(200).json({ category_ids: Array.from(ignoredCategoryIds) });
});
app.post('/api/ignored-categories', (req, res) => {
    const { category_ids } = req.body;
    if (Array.isArray(category_ids)) {
        category_ids.forEach(id => ignoredCategoryIds.add(id));
        res.status(200).json({ success: true, count: ignoredCategoryIds.size });
    } else {
        res.status(400).json({ error: 'category_ids must be an array.' });
    }
});
app.delete('/api/ignored-categories', (req, res) => {
    const { category_ids } = req.body;
     if (Array.isArray(category_ids)) {
        category_ids.forEach(id => ignoredCategoryIds.delete(id));
        res.status(200).json({ success: true, count: ignoredCategoryIds.size });
    } else {
        res.status(400).json({ error: 'category_ids must be an array.' });
    }
});


// WooCommerce Test Connection
app.post('/api/woo/test', async (req, res) => {
    const { url, key, secret } = req.body;
    if (!url || !key || !secret) return res.status(400).json({ error: 'Missing WooCommerce credentials.' });

    try {
        const wooApi = new WooCommerceRestApi({ url, consumerKey: key, consumerSecret: secret, version: 'wc/v3' });
        const response = await wooApi.get("products", { per_page: 1 });
        if (response.status !== 200) throw new Error(`WooCommerce API returned status ${response.status}`);
        res.status(200).json({ success: true });
    } catch (error) {
        const errorMessage = error.response ? (error.response.data.message || JSON.stringify(error.response.data)) : error.message;
        res.status(500).json({ error: `Could not connect. WooCommerce said: ${errorMessage}` });
    }
});

// Start a Sync Job (Now fully stateless)
app.post('/api/woo/start-sync', (req, res) => {
    const { kind, productCodes, apiConfig, wooConfig, settings: jobSettings } = req.body;
    const total = productCodes?.length || 0;
    
    if (!apiConfig || !wooConfig || !jobSettings) {
        return res.status(400).json({ error: "API, WooCommerce, and Settings configurations are required to start a sync." });
    }
    if (total === 0) {
        return res.status(400).json({ error: "No products selected for sync." });
    }

    const newJob = {
        id: createJobId(),
        kind,
        status: 'queued',
        total,
        done: 0,
        started: new Date().toISOString(),
        error: null,
        logs: [],
        productCodes,
        apiConfig,
        wooConfig,
        settings: jobSettings, // Store settings with the job
    };
    jobs[newJob.id] = newJob;

    setTimeout(() => {
        if (jobs[newJob.id]) {
            jobs[newJob.id].status = 'running';
            runRealSyncJob(newJob.id);
        }
    }, 1000);
    
    const { apiConfig: ac, wooConfig: wc, settings: s, ...jobForResponse } = newJob;
    res.status(201).json(jobForResponse);
});


// Job Status & Logs
app.get('/api/jobs/:id', (req, res) => {
    const job = jobs[req.params.id];
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    const { logs, productCodes, apiConfig, wooConfig, settings, ...jobWithoutDetails } = job;
    res.status(200).json(jobWithoutDetails);
});
app.get('/api/jobs/:id/logs', (req, res) => {
    const job = jobs[req.params.id];
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    res.status(200).json(job.logs);
});

// --- PRICING RULES ENGINE LOGIC ---
const checkCondition = (productValue, operator, ruleValue) => {
    if (!productValue || !ruleValue) return false;
    const prodVal = productValue.toLowerCase();
    const ruleVal = ruleValue.toLowerCase();
    switch (operator) {
        case 'is': return prodVal === ruleVal;
        case 'is_not': return prodVal !== ruleVal;
        case 'contains': return prodVal.includes(ruleVal);
        case 'does_not_contain': return !prodVal.includes(ruleVal);
        default: return false;
    }
};

const getApplicableMargin = (product, rules) => {
    for (const rule of rules.conditionalRules) {
        const productValue = rule.conditionField === 'category'
            ? product.categorisation?.supplier_category
            : (product.supplier?.supplier || product.supplier_name); // Add supplier_name as fallback
        if (checkCondition(productValue, rule.conditionOperator, rule.conditionValue)) {
            return rule.margin;
        }
    }
    return rules.defaultMargin;
};

// --- REAL SYNC LOGIC ---
async function getPromodataProduct(code, apiConfig) {
    if (!apiConfig) throw new Error("Promodata API config not set for job.");
    const { url, token } = apiConfig;
    const response = await fetch(`${url}/products?code=${code}`, { headers: { 'x-auth-token': token } });
    if (!response.ok) throw new Error(`Promodata API returned status ${response.status}`);
    const data = await response.json();
    if (data.items && data.items.length > 0) return data.items[0];
    throw new Error(`Product with code ${code} not found in Promodata.`);
}

function transformProductForWoo(product, jobSettings) {
    const hasVariants = product.variants && product.variants.length > 1;

    const commonData = {
        name: product.name,
        sku: product.code,
        description: product.description_html || product.description,
        short_description: product.short_description || '',
        images: product.images.map(img => ({ src: img.url || img })),
        categories: product.categorisation?.supplier_category ? [{ name: product.categorisation.supplier_category }] : []
    };

    if (!hasVariants) {
        const firstPriceBreak = product.prices?.price_groups?.[0]?.base_price?.breaks?.[0];
        const basePrice = firstPriceBreak ? firstPriceBreak.price : 0;
        const margin = getApplicableMargin(product, jobSettings.rules);
        const salePrice = basePrice * (1 + (margin / 100));
        return { productData: { ...commonData, type: 'simple', regular_price: String(salePrice.toFixed(2)) }, variationsData: [] };
    } else {
        const attributesMap = new Map();
        product.variants.forEach(variant => {
            Object.entries(variant.attrs).forEach(([name, value]) => {
                if (!attributesMap.has(name)) attributesMap.set(name, new Set());
                attributesMap.get(name).add(value);
            });
        });

        const wooAttributes = Array.from(attributesMap.entries()).map(([name, optionsSet], index) => ({
            name, position: index, visible: true, variation: true, options: Array.from(optionsSet)
        }));

        const variationsData = product.variants.map(variant => {
            const firstPriceBreak = variant.prices?.price_groups?.[0]?.base_price?.breaks?.[0];
            const basePrice = firstPriceBreak ? firstPriceBreak.price : 0;
            const margin = getApplicableMargin(product, jobSettings.rules);
            const salePrice = basePrice * (1 + (margin / 100));
            return {
                sku: variant.sku,
                regular_price: String(salePrice.toFixed(2)),
                attributes: Object.entries(variant.attrs).map(([name, option]) => ({ name, option })),
            };
        });

        return { productData: { ...commonData, type: 'variable', attributes: wooAttributes }, variationsData };
    }
}

async function runRealSyncJob(jobId) {
    const job = jobs[jobId];
    if (!job) return;

    const { apiConfig, wooConfig, settings: jobSettings } = job;
    console.log(`[Backend] Starting real sync for Job ${jobId}`);
    const wooApi = new WooCommerceRestApi({ ...wooConfig, version: 'wc/v3' });

    for (const code of job.productCodes) {
        try {
            const promoProduct = await getPromodataProduct(code, apiConfig);
             // Enrich product with supplier name for rules engine
            promoProduct.supplier_name = promoProduct.supplier?.supplier;
            const { productData, variationsData } = transformProductForWoo(promoProduct, jobSettings);
            
            if (variationsData.length === 0) {
                await wooApi.post("products", productData);
                job.logs.push({ timestamp: new Date().toISOString(), itemId: code, status: 'success', message: `Synced simple product "${productData.name}" successfully.` });
            } else {
                const { data: parentProduct } = await wooApi.post("products", productData);
                if (parentProduct.id && variationsData.length > 0) {
                    await wooApi.post(`products/${parentProduct.id}/variations/batch`, { create: variationsData });
                }
                job.logs.push({ timestamp: new Date().toISOString(), itemId: code, status: 'success', message: `Synced variable product "${productData.name}" with ${variationsData.length} variations.` });
            }
        } catch (error) {
            const errorMessage = error.response ? (error.response.data.message || JSON.stringify(error.response.data)) : error.message;
            job.error = "One or more items failed to sync.";
            job.logs.push({ timestamp: new Date().toISOString(), itemId: code, status: 'failed', message: `Error: ${errorMessage}` });
        }
        job.done++;
        await new Promise(resolve => setTimeout(resolve, 200)); 
    }

    job.status = job.error ? 'failed' : 'completed';
    job.ended = new Date().toISOString();
    console.log(`[Backend] Job ${jobId} finished with status: ${job.status}.`);
}

// Catch-all 404
app.use((req, res, next) => {
    res.status(404).json({ error: `Not Found: Cannot ${req.method} ${req.path}` });
});

app.listen(PORT, () => {
    console.log(`Backend server listening on port ${PORT}`);
});