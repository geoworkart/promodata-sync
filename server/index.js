const express = require('express');
const cors = require('cors');
const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// In-memory store for jobs and settings. In a production app, use a database.
let jobs = {};
let jobCounter = 1;
const createJobId = () => `JOB-${String(jobCounter++).padStart(5, '0')}`;
let settings = {
    rules: { defaultMargin: 30, conditionalRules: [] },
    mappings: { categories: [], fields: [] },
    notifications: { email: '', onSuccess: false, onFailure: true },
    advanced: { requestsPerMinute: 60 }
};

// --- API Endpoints ---

// Add a root endpoint for health checks and deployment verification
app.get('/', (req, res) => {
    res.status(200).send('Promodata Sync Backend is running.');
});

// Removed the problematic `/api/config` endpoint. Config is now passed with each job.

// Settings
app.get('/api/settings', (req, res) => {
    res.status(200).json(settings);
});

app.post('/api/settings', (req, res) => {
    console.log('[Backend] Received settings update:', req.body);
    settings = { ...settings, ...req.body };
    res.status(200).json(settings);
});


// 1. Test WooCommerce Connection
app.post('/api/woo/test', async (req, res) => {
    const { url, key, secret } = req.body;
    console.log('[Backend] Received test connection request for:', url);

    if (!url || !key || !secret) {
        return res.status(400).json({ error: 'Missing WooCommerce credentials.' });
    }

    try {
        const wooApi = new WooCommerceRestApi({ url, consumerKey: key, consumerSecret: secret, version: 'wc/v3' });
        const response = await wooApi.get("products", { per_page: 1 });
        
        if (response.status !== 200) {
            throw new Error(`WooCommerce API returned status ${response.status}`);
        }

        console.log('[Backend] WooCommerce connection test successful!');
        res.status(200).json({ success: true });

    } catch (error) {
        const errorMessage = error.response ? (error.response.data.message || JSON.stringify(error.response.data)) : error.message;
        console.error('[Backend] Connection test failed:', errorMessage);
        res.status(500).json({ error: `Could not connect. WooCommerce said: ${errorMessage}` });
    }
});

// 2. Start a Sync Job (Now stateless)
app.post('/api/woo/start-sync', (req, res) => {
    const { kind, productCodes, apiConfig, wooConfig } = req.body;
    const total = productCodes?.length || 0;
    console.log(`[Backend] Received request to start sync job: ${kind} for ${total} items.`);

    if (!apiConfig || !wooConfig) {
        return res.status(400).json({ error: "API and WooCommerce configurations are required to start a sync." });
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
        apiConfig, // Store config with the job
        wooConfig, // Store config with the job
    };

    jobs[newJob.id] = newJob;

    // Start the job asynchronously
    setTimeout(() => {
        if (jobs[newJob.id]) {
            jobs[newJob.id].status = 'running';
            runRealSyncJob(newJob.id);
        }
    }, 1000);
    
    // Respond immediately with the job object, but without sensitive configs
    const { apiConfig: ac, wooConfig: wc, ...jobForResponse } = newJob;
    res.status(201).json(jobForResponse);
});


// 3. Get Job Status
app.get('/api/jobs/:id', (req, res) => {
    const { id } = req.params;
    const job = jobs[id];

    if (!job) {
        return res.status(404).json({ error: 'Job not found.' });
    }
    // Return job without the logs or product codes or configs
    const { logs, productCodes, apiConfig, wooConfig, ...jobWithoutDetails } = job;
    res.status(200).json(jobWithoutDetails);
});

// 4. Get Detailed Job Logs
app.get('/api/jobs/:id/logs', (req, res) => {
    const { id } = req.params;
    const job = jobs[id];

    if (!job) {
        return res.status(404).json({ error: 'Job not found.' });
    }

    res.status(200).json(job.logs);
});

// --- PRICING RULES ENGINE LOGIC ---
const checkCondition = (productValue, operator, ruleValue) => {
    if (!productValue || !ruleValue) return false;
    const prodVal = productValue.toLowerCase();
    const ruleVal = ruleValue.toLowerCase();

    switch (operator) {
        case 'is':
            return prodVal === ruleVal;
        case 'is_not':
            return prodVal !== ruleVal;
        case 'contains':
            return prodVal.includes(ruleVal);
        case 'does_not_contain':
            return !prodVal.includes(ruleVal);
        default:
            return false;
    }
};

const getApplicableMargin = (product, rules) => {
    for (const rule of rules.conditionalRules) {
        const productValue = rule.conditionField === 'category'
            ? product.categorisation?.supplier_category
            : product.supplier?.supplier;
        if (checkCondition(productValue, rule.conditionOperator, rule.conditionValue)) {
            return rule.margin;
        }
    }
    return rules.defaultMargin;
};


// --- REAL SYNC LOGIC ---

// Helper to fetch from Promodata API
async function getPromodataProduct(code, apiConfig) {
    if (!apiConfig) throw new Error("Promodata API config not set for job.");
    
    const { url, token } = apiConfig;
    const path = `/products?code=${code}`;
    const headers = { 'x-auth-token': token };

    const response = await fetch(`${url}${path}`, { headers });
    if (!response.ok) throw new Error(`Promodata API returned status ${response.status}`);
    
    const data = await response.json();
    if (data.items && data.items.length > 0) {
        return data.items[0];
    }
    throw new Error(`Product with code ${code} not found in Promodata.`);
}

// Helper to transform Promodata product to WooCommerce product
function transformProductForWoo(product) {
    const firstPriceBreak = product.prices?.price_groups?.[0]?.base_price?.breaks?.[0];
    const basePrice = firstPriceBreak ? firstPriceBreak.price : 0;
    const margin = getApplicableMargin(product, settings.rules);
    const salePrice = basePrice * (1 + (margin / 100));

    return {
        name: product.name,
        type: 'simple',
        sku: product.code,
        regular_price: String(salePrice.toFixed(2)),
        description: product.description_html || product.description,
        short_description: product.short_description || '',
        images: product.images.map(img => ({ src: img.url || img })),
    };
}


async function runRealSyncJob(jobId) {
    const job = jobs[jobId];
    if (!job) return;

    // Use the config stored with the job object
    const { apiConfig, wooConfig } = job;

    console.log(`[Backend] Starting real sync for Job ${jobId}`);
    const wooApi = new WooCommerceRestApi({ ...wooConfig, version: 'wc/v3' });

    for (const code of job.productCodes) {
        try {
            // 1. Fetch from Promodata using job-specific config
            const promoProduct = await getPromodataProduct(code, apiConfig);
            
            // 2. Transform for WooCommerce
            const wooProduct = transformProductForWoo(promoProduct);
            
            // 3. Create in WooCommerce
            await wooApi.post("products", wooProduct);

            job.logs.push({
                timestamp: new Date().toISOString(),
                itemId: code,
                status: 'success',
                message: `Synced "${wooProduct.name}" successfully.`
            });

        } catch (error) {
            const errorMessage = error.response ? (error.response.data.message || JSON.stringify(error.response.data)) : error.message;
            console.error(`[Backend] Job ${jobId} failed for product ${code}:`, errorMessage);
            job.error = "One or more items failed to sync.";
            job.logs.push({
                timestamp: new Date().toISOString(),
                itemId: code,
                status: 'failed',
                message: `Error: ${errorMessage}`
            });
        }
        job.done++;
        
        await new Promise(resolve => setTimeout(resolve, 200)); 
    }

    job.status = job.error ? 'failed' : 'completed';
    job.ended = new Date().toISOString();
    console.log(`[Backend] Job ${jobId} finished with status: ${job.status}.`);
}

// Add a catch-all for 404s to provide a JSON response instead of HTML
app.use((req, res, next) => {
    res.status(404).json({ error: `Not Found: Cannot ${req.method} ${req.path}` });
});


app.listen(PORT, () => {
    console.log(`Backend server listening on port ${PORT}`);
});
